/**
 * dsh-live2d-pet —— 宿主侧插件。
 *
 * 职责只有四件事，其余全在前端：
 *   1. 静态资源：把 Live2D 运行时（Cubism Core / PIXI / pixi-live2d-display）、
 *      模型本体和前端脚本挂到 DSH Web 的 /dsh-pet/* 上。
 *   2. 事件桥：把 agent 的真实活动（轮次、思考、工具调用、逐字输出、结束）
 *      通过 SSE 推给桌宠，让模型的动作和 agent 的状态真正同步。
 *   3. 反向通道：桌宠输入框里的文字经官方 sessionController.prompt 送回会话。
 *   4. 注入：往 index.html 塞一个 <script>，让桌宠随 DSH Web 界面自启。
 *
 * 所有路由都过一遍 connection.requestRejection 的信任栅栏：DSH 的 Web 端口
 * 是回环地址，但浏览器里任何一个网页都能向回环发请求，不加栅栏等于把会话
 * 的读写权限开放给任意页面。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { extractCompanionVoiceText } from '../voice_engine/summarizer.js'
import { requestTTS, ensureTTSServiceRunning } from '../voice_engine/tts_client.js'
import { analyzeCharacterAssets, saveCharacterCategories } from '../tools/character-asset-analyzer.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(PACKAGE_ROOT, 'assets')
const MODEL_DIR = path.join(ASSETS, 'model')
const VENDOR_DIR = path.join(ASSETS, 'vendor')
const CHARACTERS_DIR = path.join(PACKAGE_ROOT, 'characters')
const VOICES_POOL_DIR = path.join(PACKAGE_ROOT, 'voice_engine', 'voices_pool')
try { fs.mkdirSync(VOICES_POOL_DIR, { recursive: true }) } catch (e) {}
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-live2d-pet.json')

/**
 * 桌面版通行证（macOS 原生壳用）。
 *
 * 为什么需要：所有 /dsh-pet/* 路由都要过信任栅栏，栅栏认的是 DSH 的会话 cookie。
 * 浏览器里有 cookie 所以正常；桌面壳是全新的 WebView，一个 cookie 都没有 → 401。
 * 这里给「本机进程」发一张随机通行证：壳子把它写成 cookie 再加载页面，栅栏就放行。
 * 只认回环地址 + 令牌，所以别的网页（CSRF）依然进不来。文件权限 600，删掉会自动重建。
 */
const DESKTOP_FILE = path.join(DSH_HOME, 'dsh-live2d-pet-desktop.json')

/** 版本串同时用于前端日志与缓存击穿，改前端时记得一起动。 */
const VERSION = '1.0.13'

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
}

/** 默认配置；用户改 $DSH_HOME/dsh-live2d-pet.json 覆盖。 */
const DEFAULT_CONFIG = {
  enabled: true,
  /** 桌宠渲染尺寸（CSS 像素，高度）；宽度按模型比例自动算。 */
  height: 180, // 桌宠是常驻挂件：默认约原来 1/3 的占地面积
  /** 初始位置：'br' 右下 / 'bl' 左下 / 'tr' 右上 / 'tl' 左上。 */
  corner: 'br',
  /** 鼠标悬停时视线跟随光标。 */
  lookAtCursor: true,
  /** 讲话/思考时是否自动开口（模型没有口型参数，这里用嘴部参数近似）。 */
  talkMouth: true,
  /** 空闲多久后打瞌睡（毫秒）；0 = 不睡。 */
  sleepAfterMs: 180000,
  /** 气泡最长显示时间（毫秒）；0 = 一直显示到下一次事件。 */
  bubbleTtlMs: 0,
  /** 是否显示桌宠自带的输入框按钮。 */
  showComposer: true,
  /** 是否把 agent 的思考（reasoning）也显示在气泡里。 */
  showReasoning: false,
  /** 音效开关（模型未附音频，预留给用户自备）。 */
  sound: true,
  characterId: 'tutu',
}

function readConfig() {
  let user = {}
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    /* 没配置或配置坏了都走默认值 */
  }
  return { ...DEFAULT_CONFIG, ...(user && typeof user === 'object' ? user : {}) }
}

/** 彻底剔除思考内容（<think>、<thought>、<reasoning> 标签及未闭合的前置思考链） */
function stripThinking(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '')
    .replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '')
    .replace(/<analysis>[\s\S]*?(?:<\/analysis>|$)/gi, '')
    .replace(/:::thinking[\s\S]*?(?::::|$)/gi, '')
    .trim()
}

/** 从消息的 content 块数组里抽纯文本，默认彻底过滤思考推理内容。 */
function blocksToText(content, includeReasoning = false) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(stripThinking(b.text))
    } else if (includeReasoning && b.type === 'reasoning' && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join('').trim()
}

function textOf(message, includeReasoning = false) {
  if (!message) return ''
  if (typeof message === 'string') return stripThinking(message)
  if (message.content) return blocksToText(message.content, includeReasoning)
  if (typeof message.text === 'string') return stripThinking(message.text)
  return ''
}

/** 工具名 → 中文短标签，气泡里显示“正在做什么”。 */
const TOOL_LABELS = {
  bash: '跑命令',
  read: '读文件',
  write: '写文件',
  edit: '改代码',
  glob: '找文件',
  grep: '搜代码',
  todo_write: '排计划',
  subagent: '派分身',
  subagent_fork: '派分身',
  web_search: '上网查',
  web_fetch: '读网页',
  kb_search: '翻知识库',
  kb_rag: '查知识库',
  kb_ingest: '入库文献',
  ask_user_question: '等你回话',
  create_goal: '立目标',
  update_goal: '更新目标',
  present: '交付文件',
  workflow: '编排分身',
  ralph: 'Ralph 循环',
  pdf_create: '生成 PDF',
  docx_create: '生成文档',
  xlsx_write: '生成表格',
  pptx_create: '生成幻灯片',
  auto_cite: '加引用',
  search_papers: '查文献',
  sci_draw: '画图',
  screen_capture: '观察屏幕',
  template_match_click: '找图点击',
  desktop_click: '点击屏幕',
  desktop_double_click: '双击屏幕',
  desktop_type: '键盘输入',
  get_desktop_windows: '检查窗口',
}

export default {
  name: 'dsh-live2d-pet',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    try {
      ensureTTSServiceRunning(9880).catch(() => {})
    } catch (e) {}
    // ————————————————————————————————————————————————————————————
    // 桌面版（官方 Electron App）的首页注入
    //
    // 上游贡献者 @3Asterism 的 PR #2 指出：官方桌面版是把前端**静态 dist** 出来的，
    // `ctx.webServer.tapIndex()` 那条路到不了它的 index，所以要用 `webserver/index-inject`
    // 通道推一行 <script src="/dsh-pet/pet.js">。思路是对的，我们采纳。
    //
    // 但他那版把写法改成了 `apply(root)` + `root.inject([...])` —— 实测宿主传进来的 ctx
    // **没有 .inject()**，会直接 TypeError、插件整个挂不上（我们的集成测试就是这么抓到的）。
    // 所以这里保留原有的 `inject` 声明 + `apply(ctx)`，只在 ctx 上挂监听，并且全程兜底：
    // hook 不存在时它只是个不触发的事件，空转、不影响任何现有行为。
    // ————————————————————————————————————————————————————————————
    try {
      if (ctx && typeof ctx.on === 'function') {
        ctx.on('webserver/index-inject', (table) => {
          try {
            if (!Array.isArray(table)) return
            for (const row of table) {
              if (!row) continue
              if (row.kind === 'script-src' && row.src === '/dsh-pet/pet.js') return
              if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes('/dsh-pet/pet.js')) return
            }
            table.push({
              kind: 'script',
              placement: 'body',
              text:
                '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
                'var s=document.createElement("script");s.src="/dsh-pet/pet.js";' +
                's.onerror=function(){};d.appendChild(s)}catch(e){}})()',
            })
          } catch (err) {}
        })
      }
    } catch (err) {}
    // ————————————————————————————————————————————————————————————
    // 钱包：余额 / 峰谷时段 / 本轮消耗 —— 右键 HUD 的数据源
    //
    // 为什么自己做而不是读 dsh-whale-widget：那个插件是可选的，主人可能停用它
    // （实测停用后 /dsh-whale/balance.json 直接 404）。桌宠自己会算，才到哪都能用。
    // 价格与峰谷规则照官方文档口径（与 dsh-whale-widget 的实现同源，便于对账）：
    //   · 高峰 = 北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00
    //   · 其余时段（含周末、调休上班的周末、法定节假日全天）一律空闲价
    //   · Flash: 命中 0.02/未命中 1/输出 4（元每百万 token），高峰 = 空闲 × 2
    //   · Pro 为 Flash 的 3 倍价
    //   ⚠️ 每年国务院公布次年放假安排后，记得往 HOLIDAY_VALLEY 里补下一年的日期。
    // ————————————————————————————————————————————————————————————
    const PEAK_HOURS = [
      [9, 12],
      [14, 18],
    ]
    const WEEKEND_VALLEY_FROM = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
    const HOLIDAY_VALLEY_FROM = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000)
    const HOLIDAY_VALLEY = new Set([
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
      '2026-10-05', '2026-10-06', '2026-10-07',
    ])
    /** 元 / 百万 token，数组是 [空闲价, 高峰价] */
    const PRICE = {
      flash: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
      pro: { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
    }
    /** 按北京时间（UTC+8）读日历 */
    function bjDate(sec) {
      return new Date(Number(sec) * 1000 + 8 * 3600 * 1000)
    }
    function isPeakTime(sec) {
      const n = Number(sec)
      if (!Number.isFinite(n)) return false
      const bj = bjDate(n)
      if (n >= WEEKEND_VALLEY_FROM) {
        const dow = bj.getUTCDay()
        if (dow === 0 || dow === 6) return false
      }
      if (n >= HOLIDAY_VALLEY_FROM && HOLIDAY_VALLEY.has(bj.toISOString().slice(0, 10))) return false
      const hour = bj.getUTCHours()
      for (const [a, b] of PEAK_HOURS) if (hour >= a && hour < b) return true
      return false
    }
    /** 下一个峰谷切换时刻（epoch 秒）：扫北京时间的 0/9/12/14/18 点边界，最多往后看 12 天 */
    function nextPeakChangeAt(sec) {
      const n = Number(sec)
      if (!Number.isFinite(n)) return null
      const nowPeak = isPeakTime(n)
      for (let i = 1; i <= 12 * 24; i++) {
        const t = n + i * 3600
        if (isPeakTime(t) !== nowPeak) return t
      }
      return null
    }
    function priceTier(model) {
      return /pro/i.test(String(model || '')) ? 'pro' : 'flash'
    }
    /** 一轮的花费（元）：命中/未命中/输出 三个价目分别算 */
    function costOf(usage, peak, tier) {
      const p = PRICE[tier] || PRICE.flash
      const idx = peak ? 1 : 0
      const hit = (Number(usage.hit) || 0) / 1e6 * p.hit[idx]
      const miss = (Number(usage.miss) || 0) / 1e6 * p.miss[idx]
      const out = (Number(usage.out) || 0) / 1e6 * p.out[idx]
      return hit + miss + out
    }

    /** 余额缓存（60 秒）——不缓存的话，每轮结束都打一次官方接口 */
    const wallet = {
      balanceAt: 0,
      balance: null,
      balanceErr: '',
      lastTurn: null,
      turnSeq: 0,
      today: { date: '', amount: 0, tokens: 0 },
      keyWarned: false,
    }

    /** DeepSeek key：优先问 DSH 的凭据服务，其次看环境变量 */
    async function deepseekKey() {
      try {
        const cred = ctx.get('credentials')
        if (cred && typeof cred.resolve === 'function') {
          const c = await cred.resolve('DEEPSEEK_API_KEY')
          if (c && c.value) return String(c.value)
        }
      } catch (err) {
        if (!wallet.keyWarned) {
          wallet.keyWarned = true
          try {
            console.warn('[live2d-pet] 读不到凭据服务里的 DEEPSEEK_API_KEY：' + String((err && err.message) || err).slice(0, 120))
          } catch (e) {}
        }
      }
      return process.env.DEEPSEEK_API_KEY || ''
    }

    async function fetchBalance(force) {
      const now = Date.now()
      if (!force && wallet.balance && now - wallet.balanceAt < 60000) return wallet.balance
      const key = await deepseekKey()
      if (!key) {
        wallet.balance = { ok: false, code: 'NO_KEY', error: '没配置 DEEPSEEK_API_KEY' }
        wallet.balanceAt = now
        return wallet.balance
      }
      try {
        const res = await fetch('https://api.deepseek.com/user/balance', {
          headers: { Authorization: 'Bearer ' + key },
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const j = await res.json()
        const info = (j && j.balance_infos && j.balance_infos[0]) || {}
        wallet.balance = {
          ok: true,
          totalBalance: Number(info.total_balance),
          currency: info.currency || 'CNY',
          isAvailable: j.is_available !== false,
          updatedAt: new Date().toISOString(),
        }
      } catch (err) {
        // 拿不到就沿用上一次的数字（标 stale），别让 HUD 变空
        const msg = String((err && err.message) || err).slice(0, 160)
        wallet.balance = wallet.balance && wallet.balance.ok
          ? Object.assign({}, wallet.balance, { stale: true, error: msg })
          : { ok: false, code: 'ERROR', error: msg }
      }
      wallet.balanceAt = now
      return wallet.balance
    }

    function todayKey() {
      return bjDate(Math.floor(Date.now() / 1000)).toISOString().slice(0, 10)
    }
    function addToday(amount, tokens) {
      const k = todayKey()
      if (wallet.today.date !== k) wallet.today = { date: k, amount: 0, tokens: 0 }
      wallet.today.amount += Number(amount) || 0
      wallet.today.tokens += Number(tokens) || 0
    }

    function walletSnapshot() {
      const nowSec = Math.floor(Date.now() / 1000)
      return {
        ok: true,
        version: VERSION,
        source: 'dsh-live2d-pet',
        isPeak: isPeakTime(nowSec),
        peakNextChangeAt: nextPeakChangeAt(nowSec),
        balance: wallet.balance,
        today: { date: wallet.today.date, amount: wallet.today.amount, tokens: wallet.today.tokens },
        turn: wallet.lastTurn,
        priceTier: 'flash',
        priceNote: 'Flash 空闲 0.02/1/4・高峰 ×2（元每百万 token）',
      }
    }

    // —— 信任栅栏：和官方插件一致，自定义路由必须先过 connection 的判定 ——
    //
    // 唯一的例外是「桌面版通行证」：本机进程（macOS 原生壳）带着令牌来，就放行。
    // 为什么必须留这个口子：壳子是全新 WebView，没有 DSH 的会话 cookie，
    // 而桌面桌宠的全部意义就是「不在浏览器里」，不能让用户先去浏览器登录一次。
    let deskToken = null
    function desktopKey() {
      if (deskToken) return deskToken
      try {
        const raw = JSON.parse(fs.readFileSync(DESKTOP_FILE, 'utf8'))
        if (raw && typeof raw.token === 'string' && raw.token.length >= 16) {
          deskToken = raw.token
          // 宿主端口只有它自己知道（官方桌面版由宿主决定、dsh web 可能带 --port），
          // 所以顺手补写进文件：客户端读文件就能连上，不用猜端口。
          const livePort = ctx && ctx.webServer && ctx.webServer.port
          if (livePort && raw.port !== livePort) {
            try {
              fs.writeFileSync(DESKTOP_FILE, JSON.stringify({ ...raw, port: livePort }, null, 2), { mode: 0o600 })
            } catch (err) {}
          }
          return deskToken
        }
      } catch (err) {}
      const token = randomBytes(24).toString('hex')
      try {
        fs.writeFileSync(
          DESKTOP_FILE,
          JSON.stringify(
            {
              token,
              // 客户端据此自动连上正确的宿主（端口由宿主决定，因机器而异）
              port: (ctx && ctx.webServer && ctx.webServer.port) || null,
              note: '桌面版（macOS 原生壳）的本机通行证。删掉这个文件会自动重新生成，旧壳子需要重启。',
              createdAt: new Date().toISOString(),
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        )
      } catch (err) {
        try {
          console.warn('[live2d-pet] 桌面版通行证写不进去：', err && err.message)
        } catch (e) {}
      }
      deskToken = token
      return deskToken
    }

    /** 这个请求是不是「本机桌面壳」发来的（回环地址） */
    function isDesktopReq(req) {
      try {
        const addr = (req.socket && (req.socket.remoteAddress || '')) || ''
        if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true
        const token = desktopKey()
        if (!token) return false
        const cookie = String(req.headers.cookie || '')
        if (cookie.split(/;\s*/).some((c) => c === `dsh_pet_desk=${token}`)) return true
        if (req.headers['x-dsh-pet-desk'] === token) return true
        const m = /[?&]k=([0-9a-f]{16,})/.exec(String(req.url || ''))
        if (m && m[1] === token) return true
        return false
      } catch (err) {
        return false
      }
    }

    function rejected(req, res) {
      try {
        if (isDesktopReq(req)) return false
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          return false
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.writeHead(typeof code === 'number' ? code : 403, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
        return true
      } catch (err) {
        return false
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(
        ctx.webServer.register({
          kind,
          path: pathname,
          handler: async (req, res) => {
            if (req.method === 'OPTIONS') {
              res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
                'Access-Control-Allow-Headers': 'Content-Type, x-dsh-pet-desk, Authorization',
                'Access-Control-Max-Age': '86400',
              })
              res.end()
              return
            }
            if (rejected(req, res)) return
            try {
              await handler(req, res)
            } catch (err) {
              try {
                res.writeHead(500, { 'Content-Type': MIME['.json'] })
                res.end(JSON.stringify({ ok: false, error: `live2d-pet: ${err && err.message ? err.message : String(err)}` }))
              } catch (e) {}
            }
          },
        }),
      )
    }

    // ————————————————————————————————————————————————————————————
    // 1. 静态资源
    // ————————————————————————————————————————————————————————————

    /** 把一个相对路径安全地解析到某个根目录下，越界直接判失败。 */
    function safeJoin(root, rel) {
      const decoded = decodeURIComponent(String(rel || ''))
      const target = path.resolve(root, decoded)
      const prefix = root.endsWith(path.sep) ? root : root + path.sep
      if (target !== root && !target.startsWith(prefix)) return null
      return target
    }

    function serveFile(res, abs, { cache = 'no-store' } = {}) {
      let stat
      try {
        stat = fs.statSync(abs)
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end('not found')
        return
      }
      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end('not a file')
        return
      }
      const ext = path.extname(abs).toLowerCase()
      const type = MIME[ext] || 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': String(stat.size),
        'Cache-Control': cache,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': 'Content-Type, x-dsh-pet-desk, Authorization',
      })
      fs.createReadStream(abs).pipe(res)
    }

    // 前端脚本按 mtime 热读取：改完刷新页面就生效，不用重启 DSH。
    const hotCache = new Map()
    function readHot(abs) {
      const stat = fs.statSync(abs)
      const hit = hotCache.get(abs)
      if (hit && hit.mtime === stat.mtimeMs) return hit.text
      const text = fs.readFileSync(abs, 'utf8')
      hotCache.set(abs, { mtime: stat.mtimeMs, text })
      return text
    }

    route('exact', '/dsh-pet/pet.js', (req, res) => {
      let body
      try {
        body = readHot(path.join(ASSETS, 'pet.js'))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('pet.js missing')
        return
      }
      const config = readConfig()
      // desktop：宿主是不是官方 Electron 桌面版（桌面版宿主在 Electron 里跑）
      // port：宿主自己的端口 —— 前端据此显示「当前连的是哪一个」，配合设置里的连接开关
      const boot = `\n;window.__DSH_PET_BOOT__=${JSON.stringify({
        config,
        version: VERSION,
        desktop: !!process.versions.electron,
        port: (ctx && ctx.webServer && ctx.webServer.port) || null,
        token: desktopKey(),
      })};\n`
      const doc = `/* dsh-live2d-pet ${VERSION} */\n${body}${boot}`
      res.writeHead(200, {
        'Content-Type': MIME['.js'],
        'Content-Length': String(Buffer.byteLength(doc)),
        'Cache-Control': 'no-store',
      })
      res.end(doc)
    })

    route('prefix', '/dsh-pet/modules', (req, res) => {
      const rel = req.url.split('?')[0].replace(/^\/dsh-pet\/modules\/?/, '')
      const abs = safeJoin(path.join(ASSETS, 'modules'), rel)
      if (!abs) {
        res.writeHead(403).end()
        return
      }
      serveFile(res, abs, { cache: 'no-store' })
    })

    route('prefix', '/dsh-pet/vendor', (req, res) => {
      const rel = req.url.split('?')[0].replace(/^\/dsh-pet\/vendor\/?/, '')
      const abs = safeJoin(VENDOR_DIR, rel)
      if (!abs) {
        res.writeHead(403).end()
        return
      }
      // vendor 体积大且不常改，允许浏览器缓存但必须每次校验
      serveFile(res, abs, { cache: 'no-store' })
    })

    route('prefix', '/dsh-pet/model', (req, res) => {
      const rel = req.url.split('?')[0].replace(/^\/dsh-pet\/model\/?/, '')
      const abs = safeJoin(MODEL_DIR, rel)
      if (!abs) {
        res.writeHead(403).end()
        return
      }
      serveFile(res, abs, { cache: 'no-store' })
    })

    route('exact', '/dsh-pet/config', (req, res) => {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(readConfig()))
    })

    function listCharacters() {
      const list = []
      try {
        const dirs = fs.readdirSync(CHARACTERS_DIR)
        for (const d of dirs) {
          const cfgPath = path.join(CHARACTERS_DIR, d, 'character.json')
          if (fs.existsSync(cfgPath)) {
            try {
              const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
              list.push(c)
            } catch (e) {}
          }
        }
      } catch (e) {}
      return list
    }

    route('exact', '/dsh-pet/characters', (req, res) => {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, characters: listCharacters(), active: readConfig().characterId || 'tutu' }))
    })

    route('exact', '/dsh-pet/set-character', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await json(req, res)
      if (!body || !body.characterId) return
      const cur = readConfig()
      cur.characterId = body.characterId
      try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8')
      } catch (e) {}
      broadcast({ t: 'character-changed', characterId: body.characterId })
      res.writeHead(200, { 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify({ ok: true, characterId: body.characterId }))
    })

    route('exact', '/dsh-pet/character-assets', (req, res) => {
      let qChar = 'tutu'
      try {
        const u = new URL(req.url, 'http://localhost')
        qChar = u.searchParams.get('id') || readConfig().characterId || 'tutu'
      } catch (e) {}
      const charDir = path.join(CHARACTERS_DIR, qChar)
      if (!fs.existsSync(charDir)) {
        res.writeHead(404, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'Character not found' }))
        return
      }
      const analysis = analyzeCharacterAssets(charDir)
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(Object.assign({ ok: true }, analysis)))
    })

    route('exact', '/dsh-pet/save-character-categories', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await json(req, res)
      if (!body || !body.characterId) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'Missing characterId' }))
        return
      }
      const charDir = path.join(CHARACTERS_DIR, body.characterId)
      if (!fs.existsSync(charDir)) {
        res.writeHead(404, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'Character not found' }))
        return
      }
      try {
        const saved = saveCharacterCategories(charDir, body.categories || {})
        res.writeHead(200, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: true, characterId: body.characterId, categories: saved }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })

    route('exact', '/dsh-pet/save-character-mapping', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await json(req, res)
      if (!body || !body.characterId) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'Missing characterId' }))
        return
      }
      const charDir = path.join(CHARACTERS_DIR, body.characterId)
      const cfgPath = path.join(charDir, 'character.json')
      if (!fs.existsSync(cfgPath)) {
        res.writeHead(404, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'Character not found' }))
        return
      }
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        if (body.expressions) cfg.expressions = body.expressions
        if (body.motions) cfg.motions = body.motions
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')

        // 确保动作和表情同步进 model3.json
        if (cfg.modelFile) {
          const modelFilePath = path.join(charDir, 'model', cfg.modelFile)
          if (fs.existsSync(modelFilePath)) {
            try {
              const mData = JSON.parse(fs.readFileSync(modelFilePath, 'utf8'))
              mData.FileReferences = mData.FileReferences || {}
              mData.FileReferences.Motions = mData.FileReferences.Motions || {}
              mData.FileReferences.Expressions = mData.FileReferences.Expressions || []

              const existingExpFiles = new Set((mData.FileReferences.Expressions || []).map(e => e.File))
              const modelDir = path.join(charDir, 'model')
              const allExpFiles = fs.readdirSync(modelDir).filter(f => f.endsWith('.exp3.json'))
              for (const ef of allExpFiles) {
                if (!existingExpFiles.has(ef)) {
                  mData.FileReferences.Expressions.push({
                    Name: ef.replace(/\.exp3\.json$/, ''),
                    File: ef
                  })
                }
              }

              const allMotionFiles = fs.readdirSync(modelDir).filter(f => f.endsWith('.motion3.json'))
              for (const mf of allMotionFiles) {
                const motName = mf.replace(/\.motion3\.json$/, '')
                if (!mData.FileReferences.Motions[motName]) {
                  mData.FileReferences.Motions[motName] = [{ File: mf }]
                }
                if (motName.toLowerCase() === 'idle' || motName === '待机' || motName === 'Scene1') {
                  if (!mData.FileReferences.Motions['idle']) {
                    mData.FileReferences.Motions['idle'] = [{ File: mf }]
                  }
                }
              }
              fs.writeFileSync(modelFilePath, JSON.stringify(mData, null, '\t'), 'utf8')
            } catch (me) {}
          }
        }

        broadcast({ t: 'character-mapping-updated', characterId: body.characterId, expressions: cfg.expressions, motions: cfg.motions })
        res.writeHead(200, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: true, characterId: body.characterId }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })

    route('prefix', '/dsh-pet/characters', (req, res) => {
      const rel = req.url.split('?')[0].replace(/^\/dsh-pet\/characters\/?/, '')
      const abs = safeJoin(CHARACTERS_DIR, rel)
      if (!abs) {
        res.writeHead(403).end()
        return
      }
      serveFile(res, abs, { cache: 'no-store' })
    })

    route('prefix', '/dsh-pet/voices_pool', (req, res) => {
      let rel = req.url.split('?')[0].replace(/^\/dsh-pet\/voices_pool\/?/, '')
      try {
        rel = decodeURIComponent(rel)
      } catch (e) {}
      const safeName = path.basename(rel)
      const abs = path.join(VOICES_POOL_DIR, safeName)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end('voice file not found')
        return
      }
      serveFile(res, abs, { cache: 'no-store' })
    })

    let latestAudioBuffer = null
    let latestAudioSeq = 0

    route('exact', '/dsh-pet/audio.wav', (req, res) => {
      if (!latestAudioBuffer) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('no audio')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(latestAudioBuffer.length),
        'Cache-Control': 'no-store',
      })
      res.end(latestAudioBuffer)
    })

    route('exact', '/dsh-pet/test-speech', async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-dsh-pet-desk',
        }).end()
        return
      }
      let body = {}
      if (req.method === 'POST') {
        body = (await json(req, res)) || {}
      } else if (req.method === 'GET') {
        const u = new URL(req.url, 'http://localhost')
        body = {
          characterId: u.searchParams.get('characterId'),
          text: u.searchParams.get('text')
        }
      }
      const charId = body.characterId || readConfig().characterId || 'tutu'
      const testGreetings = {
        tutu: '主人好呀！我是兔兔，随时准备为你加油助威哦~',
        yuyu: '主人，我是玉玉。工作辛苦了，随时听候你的吩咐。',
        xiaoxiao: '主人累了吗？喝杯温水休息一下，小小会一直陪着你的。',
        keke: '报告主人！女仆可可随时待命，今天也要元气满满哦！',
        whale: '主人好，鲸鱼娘随时在此协助你处理各项任务。',
      }
      const textToSpeak = body.text || testGreetings[charId] || '主人，语音系统测试正常！'
      try {
        const ttsOpts = {
          text: textToSpeak,
          characterId: charId,
          voice: body.voice,
          rate: body.rate,
          pitch: body.pitch,
          prompt: body.prompt,
        }
        const wav = await requestTTS(ttsOpts, charId, 9880)
        if (wav && wav.length > 0) {
          latestAudioBuffer = wav
          latestAudioSeq++
          broadcast({
            t: 'voice-speech',
            seq: latestAudioSeq,
            text: textToSpeak,
            characterId: charId,
            url: '/dsh-pet/audio.wav?seq=' + latestAudioSeq,
          })
          res.writeHead(200, { 'Content-Type': MIME['.json'] })
          res.end(JSON.stringify({ ok: true, text: textToSpeak, audioUrl: '/dsh-pet/audio.wav?seq=' + latestAudioSeq }))
          return
        }
      } catch (err) {}
      res.writeHead(503, { 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify({ ok: false, error: '9880 TTS 服务未响应' }))
    })

    route('exact', '/dsh-pet/voices', async (req, res) => {
      // 1. 本地音色池文件直接由 Node 扫描读取，确保 9880 离线也能正常列出
      const localPool = []
      try {
        if (fs.existsSync(VOICES_POOL_DIR)) {
          for (const f of fs.readdirSync(VOICES_POOL_DIR)) {
            if (f.toLowerCase().match(/\.(wav|mp3|ogg|m4a|flac)$/)) {
              const fullP = path.join(VOICES_POOL_DIR, f)
              const st = fs.statSync(fullP)
              localPool.push({
                file: f,
                name: f.replace(/\.[^.]+$/, ''),
                path: '/dsh-pet/voices_pool/' + encodeURIComponent(f),
                size: st.size,
                mtime: st.mtimeMs,
              })
            }
          }
        }
      } catch (e) {}

      // 2. 获取系统可用基座音色列表
      let systemVoices = [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (元气女声/全能推荐)' },
        { id: 'zh-CN-XiaoyiNeural', name: '晓伊 (温柔治愈/深海女仆)' },
        { id: 'zh-CN-YunjianNeural', name: '云健 (沉稳男声/知性严谨)' },
        { id: 'zh-CN-YunxiNeural', name: '云希 (阳光正太/元气活泼)' },
        { id: 'zh-CN-YunyangNeural', name: '云扬 (清亮青年/专业助理)' },
        { id: 'zh-CN-liaoning-XiaobeiNeural', name: '东北晓北 (幽默开朗/东北风情)' },
        { id: 'zh-CN-shaanxi-XiaoniNeural', name: '陕西晓妮 (自然甜美/西北乡情)' },
        { id: 'zh-TW-HsiaoChenNeural', name: '台湾晓臻 (软萌可爱/台湾国语)' },
        { id: 'zh-HK-HiuGaaiNeural', name: '香港晓佳 (粤语温润/优雅从容)' },
      ]
      try {
        const resp = await fetch('http://127.0.0.1:9880/voices_list', { signal: AbortSignal.timeout(1500) })
        if (resp.ok) {
          const d = await resp.json()
          if (d && Array.isArray(d.systemVoices)) systemVoices = d.systemVoices
        }
      } catch (e) {}

      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, systemVoices, localPool }))
    })

    route('exact', '/dsh-pet/delete-pool-voice', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = (await json(req, res)) || {}
      const rawFile = body.file || ''
      const safeFile = path.basename(decodeURIComponent(rawFile))
      if (!safeFile || safeFile === '.' || safeFile.startsWith('..')) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: '无效的文件名' }))
        return
      }
      const target = path.join(VOICES_POOL_DIR, safeFile)
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target)
          res.writeHead(200, { 'Content-Type': MIME['.json'] })
          res.end(JSON.stringify({ ok: true, deleted: safeFile }))
          return
        } catch (e) {
          res.writeHead(500, { 'Content-Type': MIME['.json'] })
          res.end(JSON.stringify({ ok: false, error: e.message }))
          return
        }
      }
      res.writeHead(404, { 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify({ ok: false, error: '文件不存在' }))
    })

    const handleSaveToPool = async (req, res, body = {}) => {
      let bufferToSave = null
      if (body && body.audioBase64) {
        try {
          bufferToSave = Buffer.from(body.audioBase64, 'base64')
        } catch (e) {}
      } else if (latestAudioBuffer) {
        bufferToSave = latestAudioBuffer
      }
      if (!bufferToSave || bufferToSave.length === 0) {
        res.writeHead(400, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: '没有可供保存的音频数据，请先生成声音' }))
        return
      }
      const rawName = ((body && body.name) || ('sample_' + Date.now())).trim()
      let safeName = rawName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')
      if (!safeName.toLowerCase().endsWith('.wav')) safeName += '.wav'
      const targetPath = path.join(VOICES_POOL_DIR, safeName)
      try {
        fs.writeFileSync(targetPath, bufferToSave)
        res.writeHead(200, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({
          ok: true,
          file: safeName,
          path: '/dsh-pet/voices_pool/' + encodeURIComponent(safeName),
        }))
      } catch (e) {
        res.writeHead(500, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    }

    const saveToPoolRouteHandler = async (req, res) => {
      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://localhost')
        const name = u.searchParams.get('name') || ''
        const audioBase64 = u.searchParams.get('audioBase64') || ''
        return handleSaveToPool(req, res, { name, audioBase64 })
      }
      const body = (await json(req, res)) || {}
      return handleSaveToPool(req, res, body)
    }

    route('exact', '/dsh-pet/save-to-pool', saveToPoolRouteHandler)
    route('exact', '/dsh-pet/save-to-pool/', saveToPoolRouteHandler)

    route('exact', '/dsh-pet/init-default-samples', async (req, res) => {
      const defaultDir = path.join(PACKAGE_ROOT, 'voice_engine', 'default_samples')
      let count = 0
      try {
        if (fs.existsSync(defaultDir)) {
          for (const f of fs.readdirSync(defaultDir)) {
            if (f.endsWith('.wav')) {
              const srcP = path.join(defaultDir, f)
              const dstP = path.join(VOICES_POOL_DIR, f)
              if (!fs.existsSync(dstP)) {
                fs.copyFileSync(srcP, dstP)
                count++
              }
            }
          }
        }
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify({ ok: true, restoredCount: count }))
    })

    route('exact', '/dsh-pet/generate-voice', async (req, res) => {
      const handleVoice = async (b) => {
        try {
          const resp = await fetch('http://127.0.0.1:9880/generate_voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(b),
          })
          if (!resp.ok) throw new Error('HTTP ' + resp.status)
          const resolvedVoice = resp.headers.get('X-Resolved-Voice') || 'zh-CN-XiaoxiaoNeural'
          const resolvedRate = resp.headers.get('X-Resolved-Rate') || '+0%'
          const resolvedPitch = resp.headers.get('X-Resolved-Pitch') || '+0Hz'
          const ab = await resp.arrayBuffer()
          latestAudioBuffer = Buffer.from(ab)
          latestAudioSeq++
          res.writeHead(200, {
            'Content-Type': MIME['.json'],
            'Access-Control-Allow-Origin': '*',
          })
          res.end(JSON.stringify({
            ok: true,
            voice: resolvedVoice,
            rate: resolvedRate,
            pitch: resolvedPitch,
            audioUrl: '/dsh-pet/audio.wav?seq=' + latestAudioSeq,
          }))
        } catch (err) {
          res.writeHead(500, {
            'Content-Type': MIME['.json'],
            'Access-Control-Allow-Origin': '*',
          })
          res.end(JSON.stringify({ ok: false, error: err.message }))
        }
      }

      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://localhost')
        return handleVoice({
          prompt: u.searchParams.get('prompt') || '',
          text: u.searchParams.get('text') || '',
          characterId: u.searchParams.get('characterId') || 'tutu',
          voice: u.searchParams.get('voice') || '',
          rate: u.searchParams.get('rate') || 0,
          pitch: u.searchParams.get('pitch') || 0,
        })
      }
      const body = (await json(req, res)) || {}
      return handleVoice(body)
    })

    route('exact', '/dsh-pet/save-voice-config', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(200, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
        return
      }
      const body = (await json(req, res)) || {}
      if (!body.characterId) {
        res.writeHead(400, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: 'Missing characterId' }))
        return
      }
      const cfgPath = path.join(CHARACTERS_DIR, body.characterId, 'character.json')
      try {
        let cfg = {}
        if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        const voiceName = (typeof body.voice === 'object' && body.voice !== null)
          ? (body.voice.voice_name || body.voice.voice)
          : (body.voice || undefined)
        cfg.voice = {
          voice_name: voiceName || cfg.voice?.voice_name || 'zh-CN-XiaoxiaoNeural',
          prompt: body.prompt ?? cfg.voice?.prompt ?? '',
          rate: body.rate ?? cfg.voice?.rate ?? '+0%',
          pitch: body.pitch ?? cfg.voice?.pitch ?? '+0Hz',
          referenceAudio: body.referenceAudio ?? body.customVoicePath ?? cfg.voice?.referenceAudio,
          referenceText: body.referenceText ?? cfg.voice?.referenceText,
          engine: body.engine ?? cfg.voice?.engine ?? 'edge-tts',
        }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
        broadcast({ t: 'voice-config-updated', characterId: body.characterId, voice: cfg.voice })
        res.writeHead(200, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: true, characterId: body.characterId, voice: cfg.voice }))
      } catch (err) {
        res.writeHead(500, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })

    route('exact', '/dsh-pet/import-character', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = (await json(req, res)) || {}
      const src = body.sourcePath ? path.resolve(body.sourcePath.trim()) : null
      if (!src || !fs.existsSync(src)) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: '路径不存在: ' + src }))
        return
      }
      let modelFile = null
      try {
        const files = fs.readdirSync(src, { withFileTypes: true })
        for (const f of files) {
          if (f.isFile() && f.name.toLowerCase().endsWith('.model3.json')) {
            modelFile = f.name
            break
          }
        }
      } catch (e) {}
      if (!modelFile) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: '未找到 .model3.json 文件' }))
        return
      }
      const name = body.name || path.basename(src) || '新角色'
      const charId = 'custom_' + Date.now().toString(36)
      const targetDir = path.join(CHARACTERS_DIR, charId)
      fs.mkdirSync(targetDir, { recursive: true })
      try {
        fs.symlinkSync(src, path.join(targetDir, 'model'), 'junction')
      } catch (e) {
        fs.cpSync(src, path.join(targetDir, 'model'), { recursive: true })
      }
      const charConfig = {
        id: charId,
        name,
        modelFile,
        title: name,
        scale: 0.25,
      }
      // 立即触发深度资产扫描并生成初始映射
      const analysis = analyzeCharacterAssets(targetDir)
      charConfig.expressions = analysis.currentMappings.expressions
      charConfig.motions = analysis.currentMappings.motions
      charConfig.categories = analysis.categories
      fs.writeFileSync(path.join(targetDir, 'character.json'), JSON.stringify(charConfig, null, 2), 'utf8')
      broadcast({ t: 'character-changed', characterId: charId })
      res.writeHead(200, { 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify({ ok: true, character: charConfig, analysis }))
    })

    route('exact', '/dsh-pet/delete-character', async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        res.writeHead(200, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
        return
      }
      const body = (await json(req, res)) || {}
      const charId = (body.characterId || '').trim()
      if (!charId) {
        res.writeHead(400, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: 'Missing characterId' }))
        return
      }
      const builtins = ['whale', 'tutu', 'yuyu', 'xiaoxiao', 'keke']
      if (builtins.includes(charId)) {
        res.writeHead(403, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: '内置黄金伴侣不可删除' }))
        return
      }
      const charDir = path.join(CHARACTERS_DIR, charId)
      if (!fs.existsSync(charDir)) {
        res.writeHead(404, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: '角色目录不存在' }))
        return
      }
      try {
        fs.rmSync(charDir, { recursive: true, force: true })
        const cur = readConfig()
        if (cur.characterId === charId) {
          cur.characterId = 'tutu'
          try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8')
          } catch (e) {}
        }
        broadcast({ t: 'character-deleted', characterId: charId, fallbackCharacterId: 'tutu' })
        res.writeHead(200, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: true, deleted: charId, fallbackCharacterId: 'tutu' }))
      } catch (err) {
        res.writeHead(500, {
          'Content-Type': MIME['.json'],
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })


    // ————————————————————————————————————————————————————————————
    // 2. 事件桥
    // ————————————————————————————————————————————————————————————

    /** SSE 客户端集合。每个连接一个 res。 */
    const clients = new Set()
    let seq = 0

    // 最近一次有事件的时间：壳子用它判断「哪个宿主正在干活」，从而优先连那个
    // （主人要求：哪个东西在跑任务就适配哪个，不要老挂网页端）
    let lastEventAt = 0

    function broadcast(payload) {
      lastEventAt = Date.now()
      if (!clients.size) return
      const frame = `id: ${++seq}\ndata: ${JSON.stringify(payload)}\n\n`
      for (const res of clients) {
        try {
          res.write(frame)
        } catch (err) {
          clients.delete(res)
        }
      }
    }

    /**
     * 会话归属。桌宠只关心“人正在用的那个会话”，子代理的会话不能抢气泡。
     * primarySessionId 由真实人类 prompt（source.kind === 'user'）确定。
     */
    let primarySessionId = null
    let lastSessionId = null
    const sessionState = new Map() // sessionId -> { status, turn, step }

    function stateOf(sessionId) {
      let s = sessionState.get(sessionId)
      if (!s) {
        s = { status: 'idle', turn: 0, step: 0, busySince: 0 }
        sessionState.set(sessionId, s)
      }
      return s
    }

    /** 桌宠只对主会话做完整反应；其它会话（子代理）只发一个轻量的“分身”信号。 */
    function isPrimary(sessionId) {
      if (primarySessionId) return sessionId === primarySessionId
      return sessionId === lastSessionId
    }

    function sendLocal(payload) {
      // 来自 /dsh-pet/control 的本地指令（用户点桌宠菜单、或 agent 主动调用）
      broadcast(payload)
    }

    // —— 逐字流：agent/assistant-stream 是 process-local 的实时 chunk 通道 ——
    disposers.push(
      ctx.on('agent/assistant-stream', (payload) => {
        try {
          const p = payload || {}
          const agent = p.agent
          const frame = p.frame
          if (!agent || !frame || !agent.session) return
          const sessionId = agent.session.id
          lastSessionId = sessionId
          if (!isPrimary(sessionId)) return
          if (frame.type === 'start') {
            broadcast({ t: 'attempt-start', sessionId, turn: frame.turn, step: frame.step })
            return
          }
          if (frame.type === 'end') {
            broadcast({ t: 'attempt-end', sessionId, turn: frame.turn ?? null })
            return
          }
          if (frame.type !== 'chunk' || !frame.chunk) return
          const c = frame.chunk
          if (c.type === 'text-delta' && c.text) {
            broadcast({ t: 'delta', sessionId, kind: 'text', text: c.text })
          } else if (c.type === 'reasoning-delta' && c.text) {
            broadcast({ t: 'delta', sessionId, kind: 'reasoning', text: c.text })
          } else if (c.type === 'tool-call-delta' && c.name) {
            broadcast({ t: 'tool-draft', sessionId, name: c.name })
          }
        } catch (err) {
          /* 事件桥永远不能把主流程带崩 */
        }
      }),
    )

    // —— 会话事件：轮次/步骤/工具/最终消息 ——
    const pendingTools = new Map() // callId -> { name, startedAt }
    /** 每轮累计 token 数，桌宠完成时用它弹「这一轮花了多少」的小结。 */
    const turnTokens = new Map() // sessionId -> tokens
    /** 钱包用：这一轮的 命中/未命中/输出 口径（算钱用） */
    const turnUsage = new Map()

    disposers.push(
      ctx.on('session/event', (session, event) => {
        try {
          const sessionId = (session && session.id) || 'default'
          lastSessionId = sessionId
          const type = event && event.type
          const d = (event && event.data) || {}
          const st = stateOf(sessionId)

          // 人类直接发的 prompt —— 以此认定“当前会话”
          if (type === 'user/message' && d.source && d.source.kind === 'user') {
            primarySessionId = sessionId
            broadcast({ t: 'user', sessionId, text: textOf(d).slice(0, 4000), ts: Date.now() })
            return
          }
          if (type === 'turn/start') {
            turnTokens.set(sessionId, 0)
            st.status = 'running'
            st.turn = d.turn
            st.busySince = Date.now()
            if (isPrimary(sessionId)) broadcast({ t: 'turn-start', sessionId, turn: d.turn })
            else broadcast({ t: 'subagent', sessionId, active: true, kind: 'turn-start' })
            return
          }
          if (type === 'step/start') {
            st.step = d.step
            if (isPrimary(sessionId)) broadcast({ t: 'step-start', sessionId, turn: d.turn, step: d.step })
            return
          }
          if (type === 'assistant/message') {
            if (d.usage) {
              const hit = Number(d.usage.cacheReadTokens) || 0
              const miss = Number(d.usage.inputTokens) || 0
              const out = Number(d.usage.outputTokens) || 0
              const t = hit + miss + out
              turnTokens.set(sessionId, (turnTokens.get(sessionId) || 0) + t)
              // 钱包：把这一轮的三个口径也累计起来（用于算钱）
              const u = turnUsage.get(sessionId) || { hit: 0, miss: 0, out: 0, model: '' }
              u.hit += hit
              u.miss += miss
              u.out += out
              const model = (d.message && d.message.model) || d.model
              if (model) u.model = String(model)
              turnUsage.set(sessionId, u)
            }
            if (!isPrimary(sessionId)) return
            const usage = d.usage || null
            broadcast({
              t: 'assistant',
              sessionId,
              turn: d.turn,
              step: d.step,
              text: textOf(d.message).slice(0, 8000),
              interrupted: d.interrupted === true,
              usage: usage
                ? {
                    input: usage.inputTokens || 0,
                    cache: usage.cacheReadTokens || 0,
                    output: usage.outputTokens || 0,
                  }
                : null,
            })

            const cleanAssistantText = textOf(d.message)
            const activeCharId = readConfig().characterId || 'tutu'
            const spokenVoiceText = cleanAssistantText ? extractCompanionVoiceText(cleanAssistantText, activeCharId) : ''
            if (spokenVoiceText) {
              requestTTS(spokenVoiceText, activeCharId, 9880)
                .then((wav) => {
                  if (wav && wav.length > 0) {
                    latestAudioBuffer = wav
                    latestAudioSeq++
                    broadcast({
                      t: 'voice-speech',
                      seq: latestAudioSeq,
                      text: spokenVoiceText,
                      characterId: activeCharId,
                      url: '/dsh-pet/audio.wav?seq=' + latestAudioSeq,
                    })
                  }
                })
                .catch(() => {})
            }
            return
          }
          if (type === 'assistant/attempt') {
            if (isPrimary(sessionId)) broadcast({ t: 'attempt-failed', sessionId, turn: d.turn })
            return
          }
          if (type === 'tool/call') {
            const startedAt = Date.now()
            pendingTools.set(String(d.callId), { name: d.name, startedAt })
            if (!isPrimary(sessionId)) return
            let args = ''
            try {
              args = String(d.arguments || '')
            } catch (err) {}
            broadcast({
              t: 'tool-call',
              sessionId,
              callId: String(d.callId),
              name: d.name,
              label: TOOL_LABELS[d.name] || d.name,
              args: args.slice(0, 600),
            })
            return
          }
          if (type === 'tool/result') {
            const callId = d.message && d.message.content && d.message.content[0] && d.message.content[0].toolCallId
            const key = String(callId || '')
            const pending = pendingTools.get(key)
            if (pending) pendingTools.delete(key)
            if (!isPrimary(sessionId)) return
            broadcast({
              t: 'tool-result',
              sessionId,
              callId: key,
              name: (pending && pending.name) || '',
              label: (pending && TOOL_LABELS[pending.name]) || (pending && pending.name) || '',
              ms: pending ? Date.now() - pending.startedAt : null,
              error: d.error ? { name: d.error.name, code: d.error.code } : null,
            })
            return
          }
          if (type === 'turn/end') {
            st.status = 'idle'
            const ms = st.busySince ? Date.now() - st.busySince : null
            st.busySince = 0
            const tokens = turnTokens.get(sessionId) || 0
            turnTokens.delete(sessionId)
            // 钱包结算：按「下单时刻」的峰谷 + 模型档位算出这一轮花了多少
            const u = turnUsage.get(sessionId) || { hit: 0, miss: 0, out: 0, model: '' }
            turnUsage.delete(sessionId)
            const nowSec = Math.floor(Date.now() / 1000)
            const peak = isPeakTime(nowSec)
            const amount = tokens > 0 ? costOf(u, peak, priceTier(u.model)) : 0
            wallet.turnSeq += 1
            wallet.lastTurn = {
              seq: wallet.turnSeq,
              turn: d.turn || null,
              amount: Math.round(amount * 1e6) / 1e6,
              tokens,
              ts: Date.now(),
              isPeak: peak,
              tier: priceTier(u.model),
              detail: { hit: u.hit, miss: u.miss, out: u.out },
            }
            if (tokens > 0) addToday(amount, tokens)
            if (isPrimary(sessionId)) {
              broadcast({ t: 'turn-end', sessionId, turn: d.turn, reason: d.reason, ms, tokens,
                amount: wallet.lastTurn.amount, isPeak: peak })
              // HUD 靠这条立刻弹出来，不用等前端再拉一次
              broadcast({ t: 'hud-turn', sessionId, turn: wallet.lastTurn })
            } else {
              broadcast({ t: 'subagent', sessionId, active: false, kind: 'turn-end' })
            }
            return
          }
          if (type === 'approval/asked') {
            if (isPrimary(sessionId)) broadcast({ t: 'approval', sessionId, state: 'asked' })
            return
          }
          if (type === 'approval/decided') {
            if (isPrimary(sessionId)) broadcast({ t: 'approval', sessionId, state: 'decided' })
            return
          }
          if (type === 'session/title') {
            if (isPrimary(sessionId) && d.title) broadcast({ t: 'title', sessionId, title: String(d.title) })
            return
          }
        } catch (err) {
          /* 同上：事件桥不许抛 */
        }
      }),
    )

    disposers.push(
      ctx.on('session/disposed', (session) => {
        const id = session && session.id
        if (!id) return
        turnTokens.delete(id)
        sessionState.delete(id)
        if (primarySessionId === id) primarySessionId = null
        if (lastSessionId === id) lastSessionId = null
      }),
    )

    route('exact', '/dsh-pet/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // 连上先给一份当前状态，桌宠不用等下一个事件才知道自己在什么状态
      const state = primarySessionId ? stateOf(primarySessionId) : null
      res.write(
        `data: ${JSON.stringify({
          t: 'hello',
          sessionId: primarySessionId || lastSessionId || null,
          status: state ? state.status : 'idle',
          ts: Date.now(),
        })}\n\n`,
      )
      clients.add(res)
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch (err) {
          clearInterval(ping)
          clients.delete(res)
        }
      }, 15000)
      const cleanup = () => {
        clearInterval(ping)
        clients.delete(res)
      }
      req.on('close', cleanup)
      req.on('error', cleanup)
      res.on('error', cleanup)
    })

    /**
     * 右键 HUD 的数据源：余额 + 峰谷 + 本轮消耗 + 今日累计。
     * ?refresh=1 强制刷新余额（前端有 60 秒节流）。
     */
    route('exact', '/dsh-pet/hud', async (req, res) => {
      if (rejected(req, res)) return
      try {
        const force = /[?&]refresh=1/.test(req.url || '')
        await fetchBalance(force)
        const snap = walletSnapshot()
        const body = JSON.stringify(snap)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(Buffer.byteLength(body)),
        })
        res.end(body)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    })

    route('exact', '/dsh-pet/state', (req, res) => {
      const sid = primarySessionId || lastSessionId
      const st = sid ? stateOf(sid) : { status: 'idle', turn: 0, step: 0 }
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      res.end(
        JSON.stringify({
          ok: true,
          version: VERSION,
          sessionId: sid,
          status: st.status,
          turn: st.turn,
          step: st.step,
          clients: clients.size,
          hasSessionController: !!ctx.get('sessionController'),
          // 下面三项给桌面客户端挑宿主用（判断哪个在干活 / 是网页版还是桌面版 / 端口多少）
          lastEventAt,
          desktop: !!process.versions.electron,
          port: (ctx && ctx.webServer && ctx.webServer.port) || null,
        }),
      )
    })

    // ————————————————————————————————————————————————————————————
    // 3. 反向通道：桌宠 → 会话
    // ————————————————————————————————————————————————————————————

    function readBody(req, limit = 256 * 1024) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > limit) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    async function json(req, res) {
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch (err) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'bad json' }))
        return null
      }
      return body
    }

    function resolveSession(requested) {
      const candidate = requested || primarySessionId || lastSessionId
      if (!candidate) return null
      return candidate
    }

    route('exact', '/dsh-pet/say', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await json(req, res)
      if (!body) return
      const text = String(body.text || '').trim()
      if (!text) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'empty text' }))
        return
      }
      const controller = ctx.get('sessionController')
      if (!controller || typeof controller.prompt !== 'function') {
        res.writeHead(503, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'session controller unavailable' }))
        return
      }
      let sessionId = resolveSession(body.sessionId)
      let created = false
      if (!sessionId && typeof controller.create === 'function') {
        // 还没有会话就自己开一个——否则主人刚打开 DSH 时点桌宠说话会直接失败。
        try {
          const made = await controller.create({})
          sessionId = made && made.sessionId
          created = true
        } catch (err) {
          try {
            console.error('[live2d-pet] 自动建会话失败：', (err && err.stack) || err)
          } catch (e) {}
        }
      }
      if (!sessionId) {
        res.writeHead(503, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'no active session' }))
        return
      }
      try {
        // 第二个参数 signal 是**必需**的：SessionController.prompt(request, signal) 里
        // 第一行就是 signal.throwIfAborted()。走 RPC 时由载体提供，直接调用必须自己给。
        await controller.prompt(
          {
            requestId: randomUUID(),
            sessionId,
            mode: body.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
        res.writeHead(200, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: true, sessionId, created }))
      } catch (err) {
        // 把栈打到宿主日志——这条路径出错时，前端只拿到一句 message，根本没法定位
        try {
          console.error('[live2d-pet] /say 送话失败：', (err && err.stack) || err)
        } catch (e) {}
        res.writeHead(500, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }))
      }
    })

    // 中断当前轮次（桌宠菜单里的“打断”按钮）
    route('exact', '/dsh-pet/cancel', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await json(req, res)
      if (!body) return
      const sessionId = resolveSession(body.sessionId)
      const controller = ctx.get('sessionController')
      try {
        if (!sessionId || !controller || typeof controller.cancel !== 'function') {
          throw new Error('cancel unavailable')
        }
        await controller.cancel({ sessionId })
        res.writeHead(200, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }))
      }
    })

    /**
     * 外部驱动通道。桌宠自己的菜单用它，agent 也可以直接 POST 过来让模型做指定反应
     * （见 tools/pet-ctl.mjs）。这是“agent 主动表演”的唯一入口。
     */
    route('exact', '/dsh-pet/control', async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: true, version: VERSION, sessions: clients.size }))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const body = await json(req, res)
      if (!body) return
      const out = { t: 'control', ts: Date.now() }
      if (body.expression !== undefined) out.expression = body.expression === null ? null : String(body.expression)
      if (body.mood !== undefined) out.mood = body.mood === null ? null : String(body.mood)
      if (body.motion !== undefined) out.motion = body.motion === null ? null : String(body.motion)
      if (body.bubble !== undefined) out.bubble = body.bubble === null ? null : String(body.bubble)
      if (body.bubbleMs !== undefined) out.bubbleMs = Number(body.bubbleMs) || 0
      if (body.props !== undefined) out.props = body.props
      if (body.clearProps === true) out.clearProps = true
      if (body.say !== undefined) out.say = String(body.say)
      if (body.attention === true) out.attention = true
      // 工作简报：{title, body} / [title, body] / "纯文本" 都接受
      //（前端头顶会挂一个信封，点开是大号可读面板）
      if (body.report !== undefined && body.report !== null) out.report = body.report
      sendLocal(out)
      res.writeHead(200, { 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify({ ok: true, clients: clients.size, sent: out }))
    })

    // ————————————————————————————————————————————————————————————
    // 4. 独立桌面窗口：一个只放桌宠的极简页面，用 Chrome --app 打开就是一个
    //    无浏览器边框的常驻小窗（DSH 标签页关掉也还在）。
    // ————————————————————————————————————————————————————————————
    route('exact', '/dsh-pet/standalone', (req, res) => {
      const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DS 鲸鱼娘 · 桌宠</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent}
  body{--dsh-pet-standalone:1}
</style>
</head><body>
<script src="/dsh-pet/pet.js"></script>
</body></html>`
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
      res.end(html)
    })

    // ————————————————————————————————————————————————————————————
    // 5. 自检页：一条 URL 看清桌宠到底走到哪一步了。
    //    开发时这台机器的无头浏览器起不了合成器，截图/自动化全废，
    //    所以把「模型加载到哪一步、哪些参数被过滤、掩码覆盖率多少」
    //    直接渲染成人类可读的报告，出问题时截个图就能定位。
    // ————————————————————————————————————————————————————————————
    route('exact', '/dsh-pet/diag', (req, res) => {
      const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DS 鲸鱼娘 · 自检</title>
<style>
 body{margin:0;padding:18px 20px 40px;font:13px/1.65 -apple-system,"PingFang SC",system-ui,sans-serif;
   background:#0f1117;color:#e6e9f2}
 h1{font-size:15px;margin:0 0 4px}
 .sub{opacity:.55;margin-bottom:14px;font-size:12px}
 pre{background:#171a23;border:1px solid #262a36;border-radius:10px;padding:12px 14px;
   white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6}
 .ok{color:#5ee6a8}.bad{color:#ff7b7b}.warn{color:#ffce6a}
</style></head><body>
<h1>DS 鲸鱼娘 · 自检</h1>
<div class="sub">这条页面会把桌宠的启动过程和运行状态直接打出来。桌宠本体在右下角。</div>
<pre id="out">正在启动…</pre>
<script src="/dsh-pet/pet.js"></script>
<script>
(function(){
  var lines=[], out=document.getElementById('out');
  function add(s){lines.push(s); out.textContent=lines.join('\\n');}
  var t0=Date.now();
  add('插件版本: ${VERSION}');
  add('页面地址: '+location.href);
  add('时间: '+new Date().toLocaleString());
  add('');
  add('— 运行时 —');
  ['Live2DCubismCore','PIXI'].forEach(function(k){add('  '+k+': '+(window[k]?'已加载':'缺失'))});
  setTimeout(function(){
    add('  PIXI.live2d: '+((window.PIXI&&window.PIXI.live2d)?'已加载':'缺失'));
    if(window.PIXI&&PIXI.live2d&&PIXI.live2d.Live2DModel) add('  Live2DModel: 存在');
    var st=window.DSHPet&&window.DSHPet.state;
    add('');
    add('— 模型 —');
    if(!st){add('  <span class="bad">桌宠还没就绪（模型可能没加载出来）</span>')}
    else{
      add('  原始尺寸: '+(st.modelSize?Math.round(st.modelSize.w)+' × '+Math.round(st.modelSize.h):'未知'));
      add('  取景: '+(st.view?st.view.w+'×'+st.view.h+' ('+st.view.mode+', 缩放 '+st.view.scale+')':'未知'));
      if(st.contentBox){var b=st.contentBox;
        add('  角色实体范围: x '+b.x0+'–'+b.x1+' / y '+b.y0+'–'+b.y1+'（画布归一化，由启动自测得出）')}
      else add('  <span class="warn">角色实体范围未测出（按整张画布取景）</span>');
      add('  可用表情: '+st.expressions.length+' 个');
      add('  可用动作: '+st.motions.join(', '));
      add('');
      add('— 参数过滤 —');
      if(st.droppedParams.length) add('  <span class="warn">忽略 '+st.droppedParams.length+' 个：'+st.droppedParams.join('、')+'</span>');
      else add('  <span class="ok">全部表情参数都存在</span>');
    }
    add('');
    add('— 提示 —');
    add('  右键桌子上的鲸鱼娘 / 点 ⋯ 可以换表情、道具、动作、取景；双击开输入框。');
    add('  如果模型没出来，把这一页截图发出来即可定位。');
  }, 4000);
})();
</script>
</body></html>`
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
      res.end(html)
    })

    // ————————————————————————————————————————————————————————————
    // 6. 注入 index.html
    // ————————————————————————————————————————————————————————————
    disposers.push(
      ctx.webServer.tapIndex((html) => {
        if (!readConfig().enabled) return html
        if (html.indexOf('/dsh-pet/pet.js') !== -1) return html
        const tag = '<script defer src="/dsh-pet/pet.js"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }),
    )

    ctx.effect(() => () => {
      for (const res of clients) {
        try {
          res.end()
        } catch (err) {}
      }
      clients.clear()
      for (const d of disposers) {
        try {
          d()
        } catch (err) {}
      }
    })

    try {
      // 启动就把「桌面版通行证」准备好：macOS 原生壳启动时要先读它再加载页面，
      // 如果等到第一个请求才生成，壳子会一直拿不到（鸡生蛋）。
      desktopKey()
      console.log(
        `[live2d-pet] 已挂载：/dsh-pet/pet.js · 模型目录 ${MODEL_DIR} · 桌面版通行证 ${DESKTOP_FILE}`,
      )
    } catch (err) {}
  },
}
