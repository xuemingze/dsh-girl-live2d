/**
 * dsh-girl-live2d - voice_engine/tts_client.js
 *
 * 负责向 9880 TTS 服务请求合成语音，具备服务离线自愈拉起、并发单飞等待与安全关闭机制，
 * 返回标准 PCM WAV 音频 buffer。
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TTS_SCRIPT = path.join(HERE, 'tts_service.py')

let ttsChild = null
let spawnPromise = null

export async function pingTTS(port = 9880) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/ping',
        method: 'GET',
        timeout: 1200,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

export async function ensureTTSServiceRunning(port = 9880) {
  const alive = await pingTTS(port)
  if (alive) return true

  // 并发单飞：如果正在启动中，所有并发请求共享等待同一个启动 Promise，避免重装冷启动时直接返回 false 或重复拉起
  if (spawnPromise) {
    return spawnPromise
  }

  spawnPromise = (async () => {
    try {
      const candidates = [
        'C:\\Program Files\\Python312\\python.exe',
        'C:\\Program Files\\Python311\\python.exe',
        'C:\\Program Files\\Python310\\python.exe',
        'python',
      ]
      let pythonExe = 'python'
      for (const c of candidates) {
        if (c === 'python' || fs.existsSync(c)) {
          pythonExe = c
          break
        }
      }

      const child = spawn(
        pythonExe,
        [TTS_SCRIPT, '--port', String(port), '--host-pid', String(process.pid)],
        {
          cwd: HERE,
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      ttsChild = child
      child.on('exit', () => {
        if (ttsChild === child) ttsChild = null
      })
      child.on('error', () => {
        if (ttsChild === child) ttsChild = null
      })

      // 重装后首次冷启动（编译 pyc + 加载 soundfile/edge_tts/psutil）可能耗时 4~6 秒，预留最多 10 秒轮询
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250))
        if (await pingTTS(port)) {
          return true
        }
      }
    } catch (e) {
      console.error('[TTS Client] Failed to auto-spawn tts_service.py:', e)
    } finally {
      spawnPromise = null
    }
    return false
  })()

  return spawnPromise
}

export async function stopTTSService(port = 9880) {
  spawnPromise = null
  // 1. 优先通过 HTTP /shutdown 通知 9880 进程优雅关闭（同时也会关闭其托管的子进程）
  await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/shutdown',
        method: 'POST',
        timeout: 1500,
      },
      (res) => {
        res.resume()
        resolve(true)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })

  // 2. 若持有子进程句柄则兜底清理
  if (ttsChild) {
    try {
      ttsChild.kill()
    } catch (e) {}
    ttsChild = null
  }

  // 3. 等待端口彻底释放
  for (let i = 0; i < 10; i++) {
    if (!(await pingTTS(port))) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return !(await pingTTS(port))
}

export function getSavedCharacterVoice(characterId) {
  try {
    const charsDir = path.join(path.resolve(HERE, '..'), 'characters')
    const cfgPath = path.join(charsDir, characterId, 'character.json')
    if (fs.existsSync(cfgPath)) {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      if (c && c.voice) {
        const v = c.voice
        const voiceName =
          v.voice_name ||
          (typeof v.voice === 'string' ? v.voice : v.voice && v.voice.voice_name) ||
          null
        return {
          voice: voiceName,
          rate: v.rate || (v.voice && v.voice.rate) || null,
          pitch: v.pitch || (v.voice && v.voice.pitch) || null,
          prompt: v.prompt || (v.voice && v.voice.prompt) || null,
        }
      }
    }
  } catch (e) {}
  return null
}

export async function requestTTS(textOrOpts, characterId = 'whale', port = 9880) {
  let opts = {}
  if (typeof textOrOpts === 'string') {
    opts = { text: textOrOpts.trim(), characterId }
  } else if (textOrOpts && typeof textOrOpts === 'object') {
    opts = Object.assign({}, textOrOpts)
    if (!opts.characterId) opts.characterId = characterId
  }
  if (!opts.text || !opts.text.trim()) return null

  // 若未显式传入 voice 和 prompt，自动加载角色 character.json 中保存的专属定制音色与韵律
  if (!opts.voice && !opts.prompt && opts.characterId) {
    const saved = getSavedCharacterVoice(opts.characterId)
    if (saved) {
      if (saved.voice) opts.voice = saved.voice
      if (saved.rate) opts.rate = saved.rate
      if (saved.pitch) opts.pitch = saved.pitch
      if (saved.prompt && !opts.voice) opts.prompt = saved.prompt
    }
  }

  let alive = await pingTTS(port)
  if (!alive) {
    alive = await ensureTTSServiceRunning(port)
  }
  if (!alive) return null

  const payload = JSON.stringify(opts)

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/tts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 12000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolve(null)
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          resolve(buffer)
        })
      },
    )

    req.on('error', () => {
      resolve(null)
    })

    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })

    req.write(payload)
    req.end()
  })
}
