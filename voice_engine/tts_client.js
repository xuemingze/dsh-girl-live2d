/**
 * dsh-girl-live2d - voice_engine/tts_client.js
 * 
 * 负责向 9880 TTS 服务请求合成语音，具备服务离线自愈拉起机制，
 * 返回标准 PCM WAV 音频 buffer。
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TTS_SCRIPT = path.join(HERE, 'tts_service.py')

export async function pingTTS(port = 9880) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/ping',
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
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

let isSpawning = false
export async function ensureTTSServiceRunning(port = 9880) {
  const alive = await pingTTS(port)
  if (alive) return true
  if (isSpawning) return false
  isSpawning = true
  try {
    const pythonExe = fs.existsSync('C:\\Program Files\\Python312\\python.exe')
      ? 'C:\\Program Files\\Python312\\python.exe'
      : 'python'
    const child = spawn(pythonExe, [TTS_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200))
      if (await pingTTS(port)) {
        isSpawning = false
        return true
      }
    }
  } catch (e) {
    console.error('[TTS Client] Failed to auto-spawn tts_service.py:', e)
  }
  isSpawning = false
  return false
}

export function getSavedCharacterVoice(characterId) {
  try {
    const charsDir = path.join(path.resolve(HERE, '..'), 'characters')
    const cfgPath = path.join(charsDir, characterId, 'character.json')
    if (fs.existsSync(cfgPath)) {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      if (c && c.voice) {
        const v = c.voice
        const voiceName = v.voice_name || (typeof v.voice === 'string' ? v.voice : (v.voice && v.voice.voice_name)) || null
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
        timeout: 8000,
      },
      (res) => {
        if (res.statusCode !== 200) {
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
