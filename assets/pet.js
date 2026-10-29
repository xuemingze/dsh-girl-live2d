/**
 * dsh-live2d-pet —— 桌宠前端。
 *
 * 这份文件是桌宠的「大脑 + 身体」，改这里的常量就能改它的性格。
 *
 * 设计要点（每条都是踩过的坑）：
 *
 * 1. 模型是一套 VTube Studio 资产：44 个「表情」其实是 44 组参数开关，
 *    而且全是 Add 混合。所以不用框架的 expressionManager（它会和一次性动作抢
 *    同一批参数），自己实现 rig，挂在 InternalModel 的 beforeModelUpdate 上——
 *    那是 model.update() 之前的最后一站：动作、眨眼、视线、物理都已算完，我们加上
 *    去的一定生效；而每帧结尾 model.loadParameters() 又会把参数还原，所以写入不会
 *    跨帧累积，道具能稳定保持、情绪能干净回退。
 *
 * 2. 情绪（脸）互斥、道具（眼镜/贴纸/家具）粘性，分开管理。权重降到 0 的表达式
 *    就不再写参数，把参数交还给动作——这样「伸展」「自拍」这些自带表情的一次性
 *    动作才不会被 rig 抹平成面瘫。
 *
 * 3. 命中判定用 alpha 掩码而不是包围盒：这个模型是一整个「书桌场景」，
 *    包围盒里大半是空气。点空气要让事件穿透到下面的 DSH 界面，点在人身上才吃掉
 *    事件——这才是桌宠该有的手感。（掩码靠 preserveDrawingBuffer + postrender 取，
 *    因为 Live2DModel 自己没有 bounds，extract 拿不到东西。）
 *
 * 4. 事件来自宿主 SSE（真实 agent 活动），不是猜的；气泡里的字是逐字长出来的。
 *
 * 5. 尺寸只信 internalModel.width/height：Live2DModel 继承 PIXI Container，
 *    没有自己的 width 取值器，用 model.width 会拿到 0。
 */
;(function () {
  'use strict'

  if (window.__DSH_PET_LOADED__) return
  window.__DSH_PET_LOADED__ = true

  const isStandalone = typeof window !== 'undefined' && (
    !!window.__DSHPET_DESKTOP__ ||
    (window.location && window.location.pathname.indexOf('/dsh-pet/standalone') !== -1) ||
    /[?&]source=desktop/.test(typeof window !== 'undefined' && window.location ? window.location.search : '')
  )

  async function requestDesktopLaunchGlobal() {
    const payload = JSON.stringify({
      port: Number(window.location.port) || 59684,
    })
    try {
      const res = await fetch('/dsh-pet/desktop/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      if (res.ok) {
        const txt = await res.text()
        if (txt) {
          try { return JSON.parse(txt) } catch (e) {}
        }
      }
    } catch (e) {}

    const res2 = await fetch('http://127.0.0.1:9880/desktop/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
    const txt2 = await res2.text()
    if (txt2) {
      try { return JSON.parse(txt2) } catch (e) {}
    }
    return { ok: false, error: txt2 || `HTTP ${res2.status}` }
  }

  async function requestDesktopCloseGlobal() {
    try {
      const res = await fetch('/dsh-pet/desktop/close', { method: 'POST' })
      if (res.ok) {
        const txt = await res.text()
        if (txt) {
          try { return JSON.parse(txt) } catch (e) {}
        }
      }
    } catch (e) {}

    try {
      const res2 = await fetch('http://127.0.0.1:9880/desktop/close', { method: 'POST' })
      const txt2 = await res2.text()
      if (txt2) {
        try { return JSON.parse(txt2) } catch (e) {}
      }
    } catch (e) {}
    return { ok: true }
  }

  async function requestDesktopStatusGlobal() {
    try {
      const res = await fetch('/dsh-pet/desktop/status')
      if (res.ok) {
        const txt = await res.text()
        if (txt) {
          try { return JSON.parse(txt) } catch (e) {}
        }
      }
    } catch (e) {}

    try {
      const res2 = await fetch('http://127.0.0.1:9880/desktop/status')
      if (res2.ok) {
        const txt2 = await res2.text()
        if (txt2) {
          try { return JSON.parse(txt2) } catch (e) {}
        }
      }
    } catch (e) {}
    return { ok: true, running: false }
  }

  let isClientDetached = false
  let detachedPollTimer = null
  function setClientDetached(val) {
    isClientDetached = !!val
    if (isStandalone) return
    if (isClientDetached) {
      document.body.classList.add('dshp-client-detached')
      if (ui && ui.root) ui.root.classList.add('dshp-client-detached')
      if (typeof stopCurrentAudio === 'function') stopCurrentAudio()
      if (!detachedPollTimer) {
        detachedPollTimer = setInterval(async () => {
          try {
            const st = await requestDesktopStatusGlobal()
            if (st && st.ok && !st.running) {
              setClientDetached(false)
            }
          } catch (e) {}
        }, 1500)
      }
    } else {
      document.body.classList.remove('dshp-client-detached')
      if (ui && ui.root) ui.root.classList.remove('dshp-client-detached')
      if (detachedPollTimer) {
        clearInterval(detachedPollTimer)
        detachedPollTimer = null
      }
    }
    if (window.__dshpUpdateDetachBtn) {
      window.__dshpUpdateDetachBtn(isClientDetached)
    }
  }

  const BOOT = window.__DSH_PET_BOOT__ || {}
  const CFG = Object.assign(
    {
      height: 180, // 桌宠是常驻挂件：默认约原来 1/3 的占地面积
      corner: 'br',
      lookAtCursor: true,
      talkMouth: true,
      sound: true,
      ttsVolume: 1.0,
      tapVoice: true,
      sleepAfterMs: 180000,
      bubbleTtlMs: 0,
      maxWidthRatio: 0.5,
      roamEnabled: true,
      fullscreenPrimary: true,
      voiceMode: 'rephrase', // 'rephrase' | 'template' | 'off'
      perceptionMedia: true,
      perceptionWeb: true,
      perceptionGame: false,
      screenVision: true,
    },
    BOOT.config || {},
  )

  const BASE = '/dsh-pet'
  const LS_KEY = 'dsh-live2d-pet:layout'
  const DESK_TOKEN = (BOOT && BOOT.token) || ''

  // 面向对象核心动力学与漫步系统模块声明
  let SpringPhysicsController = null
  let FrameRateGovernor = null
  let DockAutoHideController = null
  let DesktopRoamEngine = null
  let PRESS_PROFILE_DEFAULT = { depth: 0.12, volume: 0.6, pressOmega: 36, pressZeta: 0.95, releaseOmega: 22, releaseZeta: 0.3, kick: 34 }

  let springPhysics = null
  let frameRateGovernor = null
  let dockAutoHide = null
  let desktopRoamEngine = null
  let isPetHovered = false
  let isPetDragging = false
  let dragInertiaRaf = 0

  function isSettingOrInteractionOpen() {
    const isMenuOpen = !!(ui && ui.root && ui.root.classList.contains('dshp-open')) ||
                       !!(ui && ui.menu && ui.menu.el && ui.menu.el.classList.contains('dshp-on')) ||
                       !!(ui && ui.composer && ui.composer.el && ui.composer.el.classList.contains('dshp-on')) ||
                       !!(ui && ui.hud && ui.hud.el && ui.hud.el.classList.contains('dshp-open'))
    return isMenuOpen || isPetHovered || isPetDragging
  }

  async function loadModules() {
    try {
      const mod = await import(BASE + '/modules/core-engines.js')
      SpringPhysicsController = mod.SpringPhysicsController
      FrameRateGovernor = mod.FrameRateGovernor
      DockAutoHideController = mod.DockAutoHideController
      if (mod.PRESS_PROFILE_DEFAULT) PRESS_PROFILE_DEFAULT = mod.PRESS_PROFILE_DEFAULT
    } catch (e) {
      if (window.__DSH_ENGINES__) {
        SpringPhysicsController = window.__DSH_ENGINES__.SpringPhysicsController
        FrameRateGovernor = window.__DSH_ENGINES__.FrameRateGovernor
        DockAutoHideController = window.__DSH_ENGINES__.DockAutoHideController
      }
    }

    try {
      const rmod = await import(BASE + '/modules/roam-engine.js')
      DesktopRoamEngine = rmod.DesktopRoamEngine
    } catch (e) {
      if (window.__DSH_ENGINES__) {
        DesktopRoamEngine = window.__DSH_ENGINES__.DesktopRoamEngine
      }
    }
  }

  let currentCareCardEl = null
  let currentSessionId = null
  let lastReportedBounds = ''
  function reportBoundsToShell() {
    if (window.dshpetBridge && typeof window.dshpetBridge.syncBounds === 'function') {
      const list = []
      const addBox = (el) => {
        if (!el) return
        if (el.classList.contains('dshp-hidden') || el.style.display === 'none' || el.style.visibility === 'hidden') return
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          list.push({
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          })
        }
      }
      addBox(ui && ui.root)
      if (ui && ui.menu && ui.menu.el && ui.menu.el.classList.contains('dshp-on')) addBox(ui.menu.el)
      if (ui && ui.composer && ui.composer.el && ui.composer.el.classList.contains('dshp-on')) addBox(ui.composer.el)
      if (ui && ui.bubble && ui.bubble.el && ui.bubble.el.classList.contains('dshp-on')) addBox(ui.bubble.el)
      if (ui && ui.hud && ui.hud.el && ui.hud.el.classList.contains('dshp-on')) addBox(ui.hud.el)
      if (ui && ui.report && ui.report.el && ui.report.el.classList.contains('dshp-on')) addBox(ui.report.el)
      if (ui && ui.mail && ui.mail.el && ui.mail.el.style.display !== 'none') addBox(ui.mail.el)
      if (currentCareCardEl && !currentCareCardEl.classList.contains('dshp-hidden')) addBox(currentCareCardEl)
      for (const c of document.querySelectorAll('.dshp-care-card:not(.dshp-hidden)')) {
        if (c !== currentCareCardEl) addBox(c)
      }

      const key = JSON.stringify(list)
      if (key !== lastReportedBounds) {
        lastReportedBounds = key
        window.dshpetBridge.syncBounds(list)
      }
    }
  }

  /** 彻底剔除思考内容（<think>、<thought>、<reasoning> 标签及未闭合的前置思考链） */
  function stripThinking(text) {
    if (!text || typeof text !== 'string') return ''
    let s = text
      .replace(/<\s*(?:think|thought|reasoning|analysis|reflection)(?:\s[^>]*)?>[\s\S]*?(?:<\/\s*(?:think|thought|reasoning|analysis|reflection)\s*>|$)/gi, '')
      .replace(/<\|(?:thought|think|reasoning|analysis)\|>[\s\S]*?(?:<\|\/(?:thought|think|reasoning|analysis)\|>|$)/gi, '')
      .replace(/:::thinking[\s\S]*?(?::::|$)/gi, '')
      .replace(/```(?:thought|thinking)[\s\S]*?(?:```|$)/gi, '')
      .replace(/\[\/?(?:THINK|THOUGHT|REASONING)\][\s\S]*?(?:\[\/(?:THINK|THOUGHT|REASONING)\]|$)/gi, '')
      .replace(/^(?:thought process|thinking process|思考过程|思考路径)\s*[:：][\s\S]*?(?:\n\n|$)/gi, '')
    // 过滤尚未闭合的单标签前缀，例如流式传输前几个字节 "<th", "<think"
    if (/^<[a-zA-Z|]{1,12}>?$/i.test(s.trim())) return ''
    return s.trim()
  }

  async function apiFetch(url, opt = {}) {
    const headers = Object.assign({}, opt.headers || {})
    if (opt.body && !headers['Content-Type'] && typeof opt.body === 'string') {
      headers['Content-Type'] = 'application/json'
    }
    if (DESK_TOKEN) headers['x-dsh-pet-desk'] = DESK_TOKEN
    const res = await fetch(url, Object.assign({}, opt, {
      headers,
      credentials: 'include',
    }))
    const raw = await res.text()
    let data = null
    try {
      data = JSON.parse(raw)
    } catch (e) {}
    if (!res.ok) {
      const errMsg = (data && data.error) || ('HTTP ' + res.status + (raw && raw.length < 80 ? ': ' + raw : ''))
      throw new Error(errMsg)
    }
    const result = data !== null ? data : {}
    if (result && typeof result === 'object' && typeof result.json !== 'function') {
      try {
        Object.defineProperty(result, 'json', {
          value: async function () { return this },
          enumerable: false,
          configurable: true,
          writable: true,
        })
      } catch (e) {}
    }
    return result
  }

  /**
   * 感知与视觉子系统弹性请求客户端 (perceptionFetch)
   * 双回路设计：
   * 1. 优先尝试主服务路由 (BASE + '/perception/...')
   * 2. 若遇 HTTP 405/404 或主服务尚未启动感知路由，无缝降级直连 9880 伴随服务端口
   */
  async function perceptionFetch(endpoint, opt = {}) {
    const relPath = endpoint.startsWith('/') ? endpoint : '/' + endpoint
    const isCapture = relPath.includes('/perception/capture')
    let prevVis = null

    if (isCapture && ui && ui.root) {
      // 物理级防自截：捕获瞬间桌宠根容器暂时隐形 45ms，确保画面中绝无桌宠倒影
      prevVis = ui.root.style.visibility
      ui.root.style.visibility = 'hidden'
      await new Promise(r => setTimeout(r, 45))
    }

    try {
      const primaryUrl = BASE + relPath
      let dshError = null

      // 1. 优先走主应用路由
      try {
        const headers = Object.assign({}, opt.headers || {})
        if (opt.body && !headers['Content-Type'] && typeof opt.body === 'string') {
          headers['Content-Type'] = 'application/json'
        }
        if (DESK_TOKEN) headers['x-dsh-pet-desk'] = DESK_TOKEN
        const res = await fetch(primaryUrl, Object.assign({}, opt, {
          headers,
          credentials: 'include',
        }))
        if (res.status !== 404 && res.status !== 405) {
          const raw = await res.text()
          let data = null
          try { data = JSON.parse(raw) } catch (e) {}
          if (!res.ok) {
            throw new Error((data && data.error) || ('HTTP ' + res.status + (raw && raw.length < 80 ? ': ' + raw : '')))
          }
          return data || { ok: true }
        }
        dshError = new Error('HTTP ' + res.status)
      } catch (err) {
        dshError = err
      }

      // 2. 遇 405/404/网络异常，无缝降级直连 9880 伴随服务独立端口
      const fallbackUrl = 'http://127.0.0.1:9880' + relPath
      try {
        const fbHeaders = Object.assign({}, opt.headers || {})
        if (opt.body && !fbHeaders['Content-Type'] && typeof opt.body === 'string') {
          fbHeaders['Content-Type'] = 'application/json'
        }
        const fbRes = await fetch(fallbackUrl, Object.assign({}, opt, {
          headers: fbHeaders,
          mode: 'cors',
        }))
        const fbRaw = await fbRes.text()
        let fbData = null
        try { fbData = JSON.parse(fbRaw) } catch (e) {}
        if (!fbRes.ok) {
          throw new Error((fbData && fbData.error) || ('HTTP ' + fbRes.status + (fbRaw && fbRaw.length < 80 ? ': ' + fbRaw : '')))
        }
        return fbData || { ok: true }
      } catch (fbErr) {
        throw new Error(`感知请求失败 (主服务: ${dshError ? dshError.message : '无响应'}, 9880备用: ${fbErr.message})`)
      }
    } finally {
      if (isCapture && ui && ui.root) {
        ui.root.style.visibility = prevVis || ''
      }
    }
  }

  /**
   * 设置持久化：把 CFG 里可序列化的值随 layout 一起存本地。
   * 主人要求：「每次设置保存，哪怕关掉以后下次还是这样」。
   */
  function persistCfg() {
    try {
      const snap = {}
      for (const k of Object.keys(CFG)) {
        const v = CFG[k]
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') snap[k] = v
      }
      saveLayout({ cfg: snap })
    } catch (err) {}
  }

  /** 启动时恢复上次保存的设置 */
  function restoreCfg() {
    try {
      const snap = readLayout().cfg
      if (!snap || typeof snap !== 'object') return
      for (const k of Object.keys(snap)) {
        if (k in CFG) CFG[k] = snap[k]
      }
    } catch (err) {}
  }
  restoreCfg()
  const MOTION_PRIORITY = { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 }

  const CHARACTERS = {
    tutu: {
      id: 'tutu',
      name: '兔兔',
      title: '元气甜心',
      modelUrl: BASE + '/characters/tutu/model/茕兔.model3.json',
      scale: 0.28,
      defaultParams: {
        Param123: 1.0,
      },
    },
    yuyu: {
      id: 'yuyu',
      name: '玉玉',
      title: '冷艳御姐',
      modelUrl: BASE + '/characters/yuyu/model/Xiyu.model3.json',
      scale: 0.25,
    },
    xiaoxiao: {
      id: 'xiaoxiao',
      name: '小小',
      title: '温柔治愈',
      modelUrl: BASE + '/characters/xiaoxiao/model/冰冰龙.model3.json',
      scale: 0.22,
    },
    keke: {
      id: 'keke',
      name: '可可',
      title: '元气女仆',
      modelUrl: BASE + '/characters/keke/model/maid.model3.json',
      scale: 0.22,
    },
    whale: {
      id: 'whale',
      name: '鲸鱼娘',
      title: '深海女仆',
      modelUrl: BASE + '/characters/whale/model/c_0120.model3.json',
      scale: 0.25,
    },
  }

  let activeCharacterId = (BOOT.config && BOOT.config.characterId) || CFG.characterId || 'tutu'

  function activeCharInfo() {
    return CHARACTERS[activeCharacterId] || CHARACTERS.tutu
  }

  let audioCtx = null
  let audioAnalyser = null
  let audioDataArray = null
  let audioTimeDomainArray = null
  let audioMasterGain = null
  let isSpeakingAudio = false
  let audioCurrentVolume = 0
  let audioCurrentForm = 0
  let currentAudioSource = null
  let currentAudioElement = null

  function getAudioVolume() {
    const v = Number(CFG.ttsVolume)
    if (isNaN(v)) return 1.0
    return Math.max(0, Math.min(1, v))
  }

  function setAudioVolume(vol) {
    const v = Math.max(0, Math.min(1, Number(vol) || 0))
    CFG.ttsVolume = v
    if (audioMasterGain && audioCtx) {
      try {
        audioMasterGain.gain.setValueAtTime(v, audioCtx.currentTime)
      } catch (e) {}
    }
    if (currentAudioElement) {
      try {
        currentAudioElement.volume = v
      } catch (e) {}
    }
  }

  function ensureAudioPipeline() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (!audioAnalyser) {
      audioAnalyser = audioCtx.createAnalyser()
      audioAnalyser.fftSize = 512
      audioAnalyser.smoothingTimeConstant = 0.4
      audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount)
      audioTimeDomainArray = new Uint8Array(audioAnalyser.fftSize)
    }
    if (!audioMasterGain) {
      audioMasterGain = audioCtx.createGain()
      audioAnalyser.connect(audioMasterGain)
      audioMasterGain.connect(audioCtx.destination)
    }
    const currentVol = getAudioVolume()
    try {
      audioMasterGain.gain.setValueAtTime(currentVol, audioCtx.currentTime)
    } catch (e) {}
  }

  function sampleAudioMouth(dt) {
    rig.talkPhase = (rig.talkPhase || 0) + dt
    let targetOpen = 0
    let targetForm = 0
    let hasAnalyserSignal = false

    if (isSpeakingAudio && audioAnalyser && currentAudioSource) {
      try {
        if (!audioTimeDomainArray || audioTimeDomainArray.length !== audioAnalyser.fftSize) {
          audioTimeDomainArray = new Uint8Array(audioAnalyser.fftSize)
        }
        audioAnalyser.getByteTimeDomainData(audioTimeDomainArray)
        let sumSq = 0
        for (let i = 0; i < audioTimeDomainArray.length; i++) {
          const v = (audioTimeDomainArray[i] - 128) / 128
          sumSq += v * v
        }
        const rms = Math.sqrt(sumSq / audioTimeDomainArray.length)

        if (!audioDataArray || audioDataArray.length !== audioAnalyser.frequencyBinCount) {
          audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount)
        }
        audioAnalyser.getByteFrequencyData(audioDataArray)

        // 提取人声三大特征频段：
        // 1. 低频共鸣段 (F1: 90~800Hz，bins 1..8) -> 喉音/鼻音/圆唇元音 U, O
        let lowSum = 0, lowCount = 0
        for (let i = 1; i <= 8 && i < audioDataArray.length; i++) {
          lowSum += audioDataArray[i]
          lowCount++
        }
        const lowEnergy = lowCount > 0 ? lowSum / (lowCount * 255) : 0

        // 2. 中频共鸣段 (F2: 800~2400Hz，bins 9..25) -> 元音开阔度与声门张开度 A, E
        let midSum = 0, midCount = 0
        for (let i = 9; i <= 25 && i < audioDataArray.length; i++) {
          midSum += audioDataArray[i]
          midCount++
        }
        const midEnergy = midCount > 0 ? midSum / (midCount * 255) : 0

        // 3. 高频共鸣段 (F3/F4: 2400~5600Hz，bins 26..60) -> 齿擦音、摩擦音与扁平唇形 I, S, SH, T
        let highSum = 0, highCount = 0
        for (let i = 26; i <= 60 && i < audioDataArray.length; i++) {
          highSum += audioDataArray[i]
          highCount++
        }
        const highEnergy = highCount > 0 ? highSum / (highCount * 255) : 0

        // 动态门限与非线性幂律响应（Gamma Response）：彻底消除 0 与 1 极端跳变
        const speechEnergy = Math.max(rms, midEnergy * 0.45 + lowEnergy * 0.3)
        const noiseGate = 0.012
        if (speechEnergy > noiseGate) {
          hasAnalyserSignal = true
          // 归一化输入振幅，避免直接顶格饱和
          const norm = clamp((speechEnergy - noiseGate) / 0.18, 0, 1.0)
          // 幂律曲线 (Gamma 1.35)：低音量微张(0.1~0.25)，中等音量开合自如(0.35~0.65)，仅洪亮开元音才冲顶(0.8~0.95)
          const baseOpen = Math.pow(norm, 1.35) * 0.95
          // 微量音节呼吸起伏，使长音也保持生动自然的下颌微动
          const articulation = 0.9 + 0.1 * Math.sin(rig.talkPhase * 13)
          targetOpen = clamp(baseOpen * articulation, 0, 0.96)

          // 唇形横向形变分析 (ParamMouthForm):
          // 高频占优为扁唇/微笑(I/E: +0.1~+0.6)，低频占优为圆唇(O/U: -0.1~-0.5)
          const formantDiff = (highEnergy - lowEnergy * 0.85) / (highEnergy + lowEnergy + 0.02)
          targetForm = clamp(formantDiff * 0.75, -0.55, 0.65)
        } else {
          hasAnalyserSignal = true
          targetOpen = 0
          targetForm = 0
        }
      } catch (e) {}
    }

    if (!hasAnalyserSignal && (isSpeakingAudio || rig.talking)) {
      // 降级 HTML5 Audio 播放或流式吐字阶段：采用具备平滑加减速的多频段音节连续流动包络
      const p = rig.talkPhase
      const baseCadence = 0.38 + 0.28 * Math.sin(p * 9.5) + 0.16 * Math.sin(p * 15.3)
      targetOpen = clamp(baseCadence, 0.06, 0.82)
      targetForm = 0.2 * Math.sin(p * 6.5)
    }

    // 仿生下颌质量与阻尼物理模型：快速顺滑抬颌(Attack 18)，柔和阻尼闭颌(Decay 11)
    const openSpeed = targetOpen > audioCurrentVolume ? 18 : 11
    audioCurrentVolume += (targetOpen - audioCurrentVolume) * clamp(dt * openSpeed, 0, 1)
    if (audioCurrentVolume < 0.005) audioCurrentVolume = 0

    // 唇形渐变平滑
    audioCurrentForm += (targetForm - audioCurrentForm) * clamp(dt * 12, 0, 1)

    return {
      open: clamp(audioCurrentVolume, 0, 1),
      form: clamp(audioCurrentForm, -1, 1),
    }
  }

  function stopCurrentAudio() {
    if (currentAudioSource) {
      try {
        currentAudioSource.onended = null
        currentAudioSource.stop()
      } catch (e) {}
      try {
        currentAudioSource.disconnect()
      } catch (e) {}
      currentAudioSource = null
    }
    if (currentAudioElement) {
      try {
        currentAudioElement.onended = null
        currentAudioElement.onerror = null
        currentAudioElement.pause()
        currentAudioElement.currentTime = 0
      } catch (e) {}
      currentAudioElement = null
    }
    isSpeakingAudio = false
    rig.talking = false
    audioCurrentVolume = 0
    audioCurrentForm = 0
  }

  async function playAudioWithLipSync(url, { force = false } = {}) {
    if (!CFG.sound) {
      if (force) {
        CFG.sound = true
        persistCfg()
      } else {
        return
      }
    }
    stopCurrentAudio()
    try {
      ensureAudioPipeline()
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume().catch(() => {})
      }

      const vol = getAudioVolume()

      // 1. 安全获取音频二进制数据（自动处理鉴权 Header、多端口与编解码容错）
      let blob = null
      let arrayBuffer = null
      const fetchHeaders = {}
      if (DESK_TOKEN) fetchHeaders['x-dsh-pet-desk'] = DESK_TOKEN

      if (url instanceof ArrayBuffer) {
        arrayBuffer = url
        blob = new Blob([arrayBuffer], { type: 'audio/wav' })
      } else if (typeof Blob !== 'undefined' && url instanceof Blob) {
        blob = url
        arrayBuffer = await blob.arrayBuffer()
      } else {
        // 智能解析文件名，建立多候选加载路径
        let fileName = ''
        if (typeof url === 'string') {
          const clean = url.split('?')[0].split('#')[0]
          if (clean.includes('/voices_pool/')) {
            fileName = clean.split('/voices_pool/').pop()
          } else if (clean.includes('voices_pool/')) {
            fileName = clean.split('voices_pool/').pop()
          } else if (!clean.includes('/')) {
            fileName = clean
          }
        }
        try { fileName = decodeURIComponent(fileName) } catch (e) {}

        const candidateUrls = []
        if (fileName) {
          // 优先直连 9880 独立 TTS 服务端口（绝对无主应用路由拦截、原生支持跨域音频流）
          candidateUrls.push('http://127.0.0.1:9880/voices_pool/' + encodeURIComponent(fileName))
          candidateUrls.push('/dsh-pet/voices_pool/' + encodeURIComponent(fileName))
          candidateUrls.push('/dsh-pet/voices_pool/' + fileName)
        }
        if (typeof url === 'string' && !candidateUrls.includes(url)) {
          candidateUrls.push(url)
        }

        for (const curUrl of candidateUrls) {
          try {
            const is9880 = curUrl.includes(':9880')
            const opt = is9880 ? { mode: 'cors' } : { headers: fetchHeaders, credentials: 'include' }
            const resp = await fetch(curUrl, opt)
            if (resp.ok) {
              const ct = (resp.headers.get('content-type') || '').toLowerCase()
              if (ct.includes('application/json') || ct.includes('text/html')) continue
              const ab = await resp.arrayBuffer()
              if (ab && ab.byteLength > 200) {
                arrayBuffer = ab
                blob = new Blob([ab], { type: 'audio/wav' })
                break
              }
            }
          } catch (e) {}
        }
      }

      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        console.warn('[桌宠语音] 无法从所有候选地址获取音频数据:', candidateUrls)
        if (ui && ui.bubble) ui.bubble.show('示例音频加载失败，请检查音色池文件是否存在~', { duration: 3000 })
        return
      }

      const blobUrl = URL.createObjectURL(blob)

      // 2. 优先走 Web Audio decodeAudioData，支持 Promise 与 Callback 双规范并驱动口型
      try {
        let audioBuffer = null
        try {
          audioBuffer = await new Promise((resolve, reject) => {
            let done = false
            const p = audioCtx.decodeAudioData(
              arrayBuffer.slice(0),
              (b) => { if (!done) { done = true; resolve(b) } },
              (err) => { if (!done) { done = true; reject(err) } }
            )
            if (p && typeof p.then === 'function') {
              p.then((b) => { if (!done) { done = true; resolve(b) } }).catch((err) => { if (!done) { done = true; reject(err) } })
            }
          })
        } catch (decErr) {
          console.warn('[桌宠语音] Web Audio decodeAudioData 失败:', decErr)
        }

        if (audioBuffer) {
          const source = audioCtx.createBufferSource()
          source.buffer = audioBuffer

          source.connect(audioAnalyser)

          currentAudioSource = source
          isSpeakingAudio = true
          rig.talking = true
          if (frameRateGovernor) frameRateGovernor.touch()
          setStatus('speaking')

          source.onended = () => {
            try { URL.revokeObjectURL(blobUrl) } catch (e) {}
            if (currentAudioSource === source) {
              try { source.disconnect() } catch (e) {}
              currentAudioSource = null
              isSpeakingAudio = false
              rig.talking = false
              audioCurrentVolume = 0
              setStatus('idle')
            }
          }
          source.start(0)
          return
        }
      } catch (err) {
        console.warn('[桌宠语音] Web Audio 播放链路异常，降级原生 HTML5 Audio:', err)
      }

      // 3. 降级使用原生 HTML5 Audio 播放本地 blob URL（绝对无 CORS 和 Header 限制）
      const audio = new Audio(blobUrl)
      audio.volume = vol
      currentAudioElement = audio
      isSpeakingAudio = true
      rig.talking = true
      if (frameRateGovernor) frameRateGovernor.touch()
      setStatus('speaking')
      audio.onended = () => {
        try { URL.revokeObjectURL(blobUrl) } catch (e) {}
        if (currentAudioElement === audio) {
          currentAudioElement = null
          isSpeakingAudio = false
          rig.talking = false
          audioCurrentVolume = 0
          setStatus('idle')
        }
      }
      audio.onerror = (e) => {
        try { URL.revokeObjectURL(blobUrl) } catch (e) {}
        if (currentAudioElement === audio) {
          currentAudioElement = null
          isSpeakingAudio = false
          rig.talking = false
          audioCurrentVolume = 0
          setStatus('idle')
        }
        console.warn('[桌宠语音] HTML5 Audio 播放失败:', e)
      }
      audio.play().catch((err) => {
        console.warn('[桌宠语音] 自动播放受限或播放失败:', err)
        if (currentAudioElement === audio) {
          currentAudioElement = null
          isSpeakingAudio = false
          rig.talking = false
          audioCurrentVolume = 0
          setStatus('idle')
        }
      })
    } catch (e) {
      isSpeakingAudio = false
      rig.talking = false
      console.warn('[桌宠语音] playAudioWithLipSync 异常:', e)
    }
  }

  /**
   * 伴随动作点击的专属角色 TTS 实时合成与播报（自动携带当前角色专属声线）
   */
  async function speakCharacterText(text, charId = activeCharacterId, { isTap = false } = {}) {
    if (!text || CFG.sound === false) return
    if (isTap && CFG.tapVoice === false) return
    if (isClientDetached && !isStandalone) return
    const char = CHARACTERS[charId] || {}
    const charVoice = char.voice || {}
    const payload = JSON.stringify({
      text: text,
      characterId: charId,
      voice: charVoice.voice_name || charVoice.voice,
      prompt: charVoice.prompt,
      rate: charVoice.rate,
      pitch: charVoice.pitch,
    })
    try {
      let resp = null
      try {
        resp = await fetch(BASE + '/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: payload,
        })
      } catch (e) {}
      if (!resp || !resp.ok) {
        resp = await fetch('http://127.0.0.1:9880/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        })
      }
      if (resp && resp.ok) {
        const ab = await resp.arrayBuffer()
        if (ab && ab.byteLength > 200) {
          await playAudioWithLipSync(ab, { force: true })
        }
      }
    } catch (e) {
      console.warn('[桌宠语音] speakCharacterText 异常:', e)
    }
  }

  async function discoverAssetsFromModel(charId) {
    const char = CHARACTERS[charId] || {}
    let cfg = {}
    try {
      cfg = await apiFetch(BASE + '/characters/' + charId + '/character.json')
    } catch (e) {}

    let localSaved = null
    try {
      localSaved = JSON.parse(localStorage.getItem('dsh_pet_mapping_' + charId) || 'null')
    } catch (e) {}

    const curExp = (localSaved && localSaved.expressions) || cfg.expressions || char.expressions || {}
    const curMot = (localSaved && localSaved.motions) || cfg.motions || char.motions || {}

    const expressions = []
    const motions = []

    try {
      const mUrl = char.modelUrl || (BASE + '/characters/' + charId + '/model/' + encodeURIComponent(char.modelFile || ''))
      const mData = await apiFetch(mUrl)
      const fRefs = (mData && mData.FileReferences) || {}

      const expList = fRefs.Expressions || []
      const expTasks = expList.map(async (e) => {
        let params = []
        try {
          const expPath = String(e.File || '').split('/').map(encodeURIComponent).join('/')
          const expJson = await apiFetch(BASE + '/characters/' + charId + '/model/' + expPath)
          if (expJson && expJson.Parameters) {
            params = expJson.Parameters.map((p) => ({ id: p.Id, value: p.Value, blend: p.Blend || 'Add' }))
          }
        } catch (e2) {}
        return {
          file: e.File,
          name: e.Name || e.File.replace(/\.exp3\.json$/, ''),
          params,
        }
      })
      const resolvedExps = await Promise.all(expTasks)
      for (const rx of resolvedExps) expressions.push(rx)

      const motDict = fRefs.Motions || {}
      for (const [group, mArr] of Object.entries(motDict)) {
        if (Array.isArray(mArr) && mArr.length && mArr[0].File) {
          motions.push({
            file: mArr[0].File,
            name: group,
            duration: 2.0,
          })
        }
      }
    } catch (err) {
      console.warn('[桌宠] 从 model3.json 自动嗅探资产异常：', err)
    }

    return {
      ok: true,
      characterId: charId,
      expressions,
      motions,
      currentMappings: {
        expressions: curExp,
        motions: curMot,
      },
    }
  }

  async function loadCharacterAssets(charId) {
    const char = CHARACTERS[charId]
    if (!char) return
    try {
      let data = null
      try {
        data = await apiFetch(BASE + '/character-assets?id=' + encodeURIComponent(charId))
      } catch (e) {}

      // 如果后端没有返回有效表情列表，立即触发客户端深度兜底（从 model3.json 提取全部表情与动作）
      if (!data || !data.ok || !data.expressions || data.expressions.length === 0) {
        data = await discoverAssetsFromModel(charId)
      }

      currentCharacterAssets = {
        characterId: charId,
        expressions: (data && data.expressions) || [],
        motions: (data && data.motions) || [],
        categories: (data && data.categories) || { decor: [], scene: [], action: [], emotion: [] },
      }
      char.expressions = (data && data.currentMappings && data.currentMappings.expressions) || char.expressions || {}
      char.motions = (data && data.currentMappings && data.currentMappings.motions) || char.motions || {}

      // 装入该角色的所有可用表情参数
      for (const k of Object.keys(EXPR)) delete EXPR[k]
      for (const exp of currentCharacterAssets.expressions) {
        if (exp.params) {
          EXPR[exp.file] = exp.params
          EXPR[exp.name] = exp.params
        }
      }

      // 按映射表绑定标准情绪槽位
      for (const k of Object.keys(MOOD_FACE)) delete MOOD_FACE[k]
      MOOD_FACE.neutral = null

      for (const [slot, expFile] of Object.entries(char.expressions)) {
        if (expFile && EXPR[expFile]) {
          MOOD_FACE[slot] = expFile
          const def = STANDARD_EMOTION_SLOTS.find((s) => s.id === slot)
          if (def && def.keys) {
            for (const subKey of def.keys) {
              MOOD_FACE[subKey] = expFile
            }
          }
        }
      }
      if (MOOD_FACE.happy) MOOD_FACE.joy = MOOD_FACE.happy
      if (MOOD_FACE.grumpy) MOOD_FACE.angry = MOOD_FACE.grumpy
      if (MOOD_FACE.shy) MOOD_FACE.blush = MOOD_FACE.shy
      if (MOOD_FACE.playful) {
        MOOD_FACE.pout = MOOD_FACE.playful
        MOOD_FACE.smug = MOOD_FACE.playful
      }
      if (MOOD_FACE.excited) {
        MOOD_FACE.listening = MOOD_FACE.excited
        MOOD_FACE.reading = MOOD_FACE.excited
      }
    } catch (err) {
      console.warn('[桌宠] 加载角色表情资产异常：', err)
    }
  }

  function resumeCharacterIdleMotion() {
    if (!model || !model.internalModel || activeCharacterId === 'whale') return
    try {
      const mm = model.internalModel.motionManager
      if (mm) {
        const groups = (mm.definitions && Object.keys(mm.definitions)) || []
        const idleGroup = groups.find((g) => g.toLowerCase() === 'idle') ||
                          groups.find((g) => g.toLowerCase() === 'scene1') ||
                          groups[0]
        if (idleGroup) {
          model.motion(idleGroup, 0, MOTION_PRIORITY.IDLE)
        }
      }
    } catch (e) {}
  }

  function previewExpression(expFileOrName) {
    if (!model || !coreModel) return
    clearUserFace()
    let expName = expFileOrName
    if (!EXPR[expName] && EXPR[expFileOrName + '.exp3.json']) {
      expName = expFileOrName + '.exp3.json'
    }
    act({ face: expName, ms: 3500 })
    setTimeout(() => {
      resumeCharacterIdleMotion()
    }, 3600)
  }

  function previewMotion(motFileOrName) {
    if (!model) return
    const motName = String(motFileOrName || '').replace(/\.motion3\.json$/, '')
    try {
      if (model.internalModel && model.internalModel.motionManager) {
        const mm = model.internalModel.motionManager
        const groups = (mm.definitions && Object.keys(mm.definitions)) || []
        const matched = groups.find((g) => g === motName || g.toLowerCase() === motName.toLowerCase() || g === motFileOrName)
        if (matched) {
          model.motion(matched, 0, MOTION_PRIORITY.FORCE)
          return
        }
      }
      model.motion(motName, 0, MOTION_PRIORITY.FORCE)
    } catch (e) {
      try {
        model.motion('idle', 0, MOTION_PRIORITY.FORCE)
      } catch (e2) {}
    }
  }

  function cleanVoiceText(raw) {
    if (!raw) return ''
    let t = String(raw)
    // 移除 markdown 代码块 ```...```
    t = t.replace(/```[\s\S]*?```/g, ' [代码已折叠] ')
    // 移除行内代码 `...`
    t = t.replace(/`([^`]+)`/g, '$1')
    // 移除 markdown 图片和链接 [text](url)
    t = t.replace(/!\[.*?\]\(.*?\)/g, '')
    t = t.replace(/\[(.*?)\]\(.*?\)/g, '$1')
    // 移除 html 标签
    t = t.replace(/<[^>]+>/g, '')
    // 移除 markdown 标题符号、加粗、星号、引用等
    t = t.replace(/[#*~_>]/g, '')
    // 移除多余空白
    t = t.replace(/\s+/g, ' ').trim()
    // 提取前 1~2 句话（不超过 90 字），确保伴侣口播精炼生动
    const sentences = t.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) || [t]
    let summary = ''
    for (const s of sentences) {
      if ((summary + s).length > 90) break
      summary += s
      if (summary.length >= 28) break
    }
    return summary || t.slice(0, 80)
  }

  function classifyCharacterAssets(assets) {
    const decor = []
    const scene = []
    const action = []
    const emotion = []

    const decorKeywords = [
      '发型', '发', '白发', '粉发', '金发', '棕发', '双马尾', '后发', '发带', '头纱', '黑纱',
      '袜', '白袜', '丝袜', '丝袜带子', '瞳孔', '瞳', '衣', '服', '裙', '外套', '眼镜', '饰品',
      '尾巴', '耳', '变小', '蓝', '紫', '兔兔'
    ]
    const sceneKeywords = [
      '扇子', '狐狸', '话筒', '麦克风', '菜单', '餐盘', '奶茶', '杯', '桌', '椅', '书', '电脑',
      '设备', '宠物', '鱼', '伞', '道具'
    ]
    const actionKeywords = [
      '点唇', '飞头', '前倾', '施法', '比耶', '插手', '点单', '点击', '勾手', '掏耳', '拉弓',
      '射箭', '俯身', '脚', '脚捕捉', '脚点击', '嘘', '挥手', '动作', '摸', '抱'
    ]

    for (const e of ((assets && assets.expressions) || [])) {
      const lower = (e.name + ' ' + e.file).toLowerCase()
      if (sceneKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        scene.push(e)
      } else if (decorKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        decor.push(e)
      } else if (actionKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        action.push(e)
      } else {
        emotion.push(e)
      }
    }

    for (const m of ((assets && assets.motions) || [])) {
      action.push(m)
    }

    return { decor, scene, action, emotion }
  }

  let activeModelLoadSeq = 0
  let switchingCharId = null

  function clearAllStageModels() {
    if (app && app.stage) {
      for (const child of Array.from(app.stage.children)) {
        try {
          if (child.internalModel) {
            child.internalModel.off('beforeModelUpdate', applyRig)
          }
          app.stage.removeChild(child)
          child.destroy({ children: true, texture: false, baseTexture: false })
        } catch (e) {
          console.warn('[桌宠] 舞台模型销毁异常:', e)
        }
      }
      app.stage.removeChildren()
    }
    model = null
    coreModel = null
  }

  async function loadCharacterModel(charId) {
    const char = CHARACTERS[charId] || CHARACTERS.tutu
    activeCharacterId = char.id
    const currentSeq = ++activeModelLoadSeq

    // 1. 先把当前舞台上的所有模型和 rig 监听彻底清理
    clearAllStageModels()

    // 2. 清理 rig 历史状态，防止不同角色间参数与道具互相污染
    rig.userProps.clear()
    rig.props.clear()
    rig.weight.clear()
    rig.face = null
    rig.override = null
    rig.burst = null
    device.out = false
    if (applyRig._appliedParams) applyRig._appliedParams.clear()

    const { Live2DModel } = PIXI.live2d
    Live2DModel.registerTicker(PIXI.Ticker)

    const loadedModel = await Live2DModel.from(char.modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      idleMotionGroup: 'idle',
    })

    // 3. 检查异步加载期间是否有新请求发生；若有，丢弃当前模型
    if (currentSeq !== activeModelLoadSeq) {
      try {
        loadedModel.destroy({ children: true, texture: false, baseTexture: false })
      } catch (e) {}
      return
    }

    // 4. 再次确保舞台干净，再挂载新模型
    clearAllStageModels()
    model = loadedModel
    model.eventMode = 'none'
    app.stage.addChild(model)

    const internal = model.internalModel
    coreModel = internal.coreModel

    // 立即执行常驻参数初始化（例如兔兔的去水印/模型显示 Param123）
    try {
      if (char.defaultParams) {
        for (const [k, v] of Object.entries(char.defaultParams)) {
          coreModel.setParameterValueById(k, v)
        }
      }
      if (char.id === 'tutu') {
        coreModel.setParameterValueById('Param123', 1.0)
      }
      coreModel.saveParameters()
    } catch (e) {}

    // 角色表情资产与情绪映射同步
    if (char.id === 'whale') {
      for (const k of Object.keys(EXPR)) delete EXPR[k]
      Object.assign(EXPR, BASE_WHALE_EXPR)
      for (const k of Object.keys(MOOD_FACE)) delete MOOD_FACE[k]
      Object.assign(MOOD_FACE, BASE_WHALE_MOOD_FACE)
    } else {
      await loadCharacterAssets(char.id)
    }

    internal.on('beforeModelUpdate', applyRig)
    try {
      if (internal.eyeBlink) internal.eyeBlink = undefined
    } catch (e) {}
    if (char.id !== 'whale') {
      resumeCharacterIdleMotion()
    }
    mask.dirty = true
    if (desktopRoamEngine) {
      if (model) desktopRoamEngine.baseModelY = model.y
      desktopRoamEngine.currentStrategy = desktopRoamEngine.resolveStrategy()
    }
    reportBoundsToShell()
  }

  async function switchCharacter(charId) {
    const target = CHARACTERS[charId]
    if (!target) return
    if (switchingCharId === charId) return
    switchingCharId = charId

    CFG.characterId = charId
    persistCfg()
    try {
      await apiFetch(BASE + '/set-character', {
        method: 'POST',
        body: JSON.stringify({ characterId: charId }),
      })
    } catch (e) {}
    ui.bubble.show('正在唤醒 ' + target.name + ' ...', { name: target.name, busy: true, ttl: 8000, force: true })
    try {
      contentBox = null
      await loadCharacterModel(charId)
      const box = await fitFromMeasurement()
      applyPosition(readLayout())
      if (charId === 'whale') {
        restoreProps()
        setBase('neutral', IDLE_PROPS)
      } else {
        setBase('neutral', [])
      }
      updateMenuTabLabels()
      if (ui && ui.bubble && ui.bubble.setName) ui.bubble.setName(target.name)
      if (ui && ui.menu && (ui.menu.focused === 'click' || ui.menu.focused === 'character')) {
        renderPane(ui.menu.focused)
      }
      ui.bubble.hide()
      ui.bubble.show('主人好！我是 ' + target.name + '（' + target.title + '），很高兴陪伴你~', { name: target.name, ttl: 4000, force: true })
    } catch (err) {
      ui.bubble.hide()
      ui.bubble.show('切换模型失败: ' + ((err && err.message) || err), { name: target.name, ttl: 3500, force: true })
    } finally {
      switchingCharId = null
    }
  }

  /**
   * 取景模式。这个模型是一整张「书桌场景」而不是半身立绘，直接整体显示会又小又占地方。
   * 关键是：三档都按「角色实体的高度」算，不是按画布高度算——画布上可能有一大片空气。
   * 实体范围靠启动时自测一次（见 measureContent），所以换任何模型都不用改这里。
   */
  const FIT_FRACTION = { full: 1, bust: 0.62, head: 0.38 }
  /**
   * 视窗宽高比。三档取景共用同一个比例，所以切换档位时桌宠的占地完全不变，
   * 只是「镜头推近」——固定尺寸的挂件位置上跳来跳去很难看。
   */
  const VIEW_ASPECT = 1.15
  /**
   * UI 缩放的基准高度。气泡/按钮/菜单全部用 calc(... * var(--dshp-s)) 跟着模型一起缩放，
   * 否则把模型调小时，气泡和按钮还是原来那么大，看着就不协调。
   */
  const UI_BASE_HEIGHT = 180
  const log = (...a) => console.log('%c[鲸鱼娘]', 'color:#7c5cff', ...a)

  // ——————————————————————————————————————————————————————————————
  // 一、性格表：桌宠「怎么演」全部写在这里
  // ——————————————————————————————————————————————————————————————

  /**
   * 情绪（脸）：同时只有一个。值是 manifest.expressions 里的键。
   * 注意：这些是「自动表情」的词汇表——桌宠平时自己挑，用户的手动选择只是临时覆盖。
   */
  const MOOD_FACE = {
    neutral: null,
    listening: '星星眼', // 主人在说话
    thinking: null, // 主人在想事时就是平常脸（主人要求：不要呆呆眼）
    reading: '星星眼', // 凑近看资料（配合眼镜道具）
    happy: '开心兴奋',
    excited: '星星眼',
    love: '爱心眼',
    shy: '脸红', // 被摸头 / 被夸
    pout: '调皮', // 傲娇：嘴上嫌弃其实开心
    smug: '调皮',
    sad: '悲伤',
    cry: '哭',
    grumpy: '生气', // 「我才不胖」
    dizzy: '晕晕',
    // 注：呆呆眼 / 圈圈眼（晕晕）已从所有自动行为里移除
    gloomy: '阴暗',
    sweat: '流汗',
    confused: '问号',
    alert: '感叹号',
    sleepy: '闭眼口水',
    tongue: '吐舌',
    dead: '吐魂',
    // 兼容旧名字
    angry: '生气',
    playful: '调皮',
  }

  /**
   * 以鲸鱼娘表情菜单为准的标准基准情绪槽位（15 项）
   * 作为所有 Live2D 模型的统一通用情绪对接词汇表，使得各角色触发与鲸鱼娘 100% 同步
   */
  const STANDARD_EMOTION_SLOTS = [
    { id: 'excited', label: '星星眼', icon: '✨', desc: '期待兴奋、阅读资料、倾听主人', keys: ['excited', 'listening', 'reading'], keywords: ['星星', '黄色瞳孔', '期待', 'star', 'excited', '1星星'] },
    { id: 'happy', label: '开心兴奋', icon: '😊', desc: '积极喜悦、任务完成庆祝', keys: ['happy', 'joy'], keywords: ['0.0', '开心', '笑', 'happy', 'smile', 'joy', 'weixiao', 'xiyan', '1不许看'] },
    { id: 'love', label: '爱心眼', icon: '❤️', desc: '好感心动、冒爱心、夸奖', keys: ['love'], keywords: ['爱心', '心心', '喜欢', 'love', 'heart', 'aixin', '1心心', '1爱心'] },
    { id: 'shy', label: '脸红', icon: '😳', desc: '被摸头、被夸奖、害羞腼腆', keys: ['shy', 'blush'], keywords: ['脸红', '红脸', '害羞', 'shy', 'blush', 'hong', '1脸红', '1红脸', '1不许看2'] },
    { id: 'playful', label: '调皮', icon: '😜', desc: '傲娇嫌弃、眨眼得意、逗趣', keys: ['playful', 'pout', 'smug'], keywords: ['调皮', '傲娇', '得意', '眯眼', 'playful', 'pout', 'smug'] },
    { id: 'sad', label: '悲伤', icon: '😢', desc: '打断失落、难过低头', keys: ['sad'], keywords: ['难过', '悲伤', '委屈', '低头', 'sad'] },
    { id: 'cry', label: '哭', icon: '😭', desc: '委屈流泪、大哭', keys: ['cry'], keywords: ['哭', '流泪', '眼泪', 'cry', 'tear', '1流泪', '哭哭'] },
    { id: 'grumpy', label: '生气', icon: '💢', desc: '抗议不满、鼓脸气愤', keys: ['grumpy', 'angry'], keywords: ['生气', '怒', '鼓脸', 'angry', '1生气'] },
    { id: 'gloomy', label: '阴暗', icon: '🌧️', desc: '工具报错、心情低落、长蘑菇', keys: ['gloomy'], keywords: ['黑脸', '阴暗', 'heilian', 'gloomy', '1黑脸'] },
    { id: 'sweat', label: '流汗', icon: '😅', desc: '擦汗、撤回、吃力', keys: ['sweat'], keywords: ['汗', '冷汗', '流汗', 'sweat'] },
    { id: 'confused', label: '问号', icon: '❓', desc: '歪头不解、需要主人确认', keys: ['confused'], keywords: ['问号', '疑惑', '疑问', 'confused', 'dizzy'] },
    { id: 'alert', label: '感叹号', icon: '❗', desc: '猛地抬头、睡醒、受惊', keys: ['alert'], keywords: ['惊', '感叹号', 'alert'] },
    { id: 'sleepy', label: '闭眼口水', icon: '😴', desc: '待机犯困、打瞌睡、做梦', keys: ['sleepy'], keywords: ['zzz', '睡', '困', '口水', 'sleep', 'sleepy'] },
    { id: 'tongue', label: '吐舌', icon: '👅', desc: '调皮调侃、扮鬼脸略略略', keys: ['tongue'], keywords: ['舌头', '吐舌', 'tongue'] },
    { id: 'dead', label: '吐魂', icon: '👻', desc: '摸鱼被抓、大招耗尽、累瘫', keys: ['dead'], keywords: ['吐魂', '灵魂', '瘫', 'dead', '0.0'] },
  ]

  const STANDARD_ACTION_SLOTS = [
    { id: 'idle', label: '待机动作', icon: '🌀', desc: '常态待机循环', keywords: ['idle', 'scene1', '待机', 'wait', 'stand'] },
    { id: 'click', label: '摸摸交互', icon: '👆', desc: '单次点击摸头反馈', keywords: ['click', 'tap', 'touch', '扇子', 'idle2', '摸'] },
    { id: 'done', label: '完成任务', icon: '🎉', desc: '任务完成庆祝', keywords: ['done', 'yes', 'cheer', '点唇'] },
  ]

  /**
   * 装饰品（粘性开关）：戴上就一直挂着，直到你再点一下摘掉。group 相同的互斥。
   *
   * 主人把话说清楚了：**要分开「动作」和「场景」**——
   *   · 装饰品（眼镜、贴纸、头饰、头发这类）→ 一直存在
   *   · 场景摆设（桌布、鲸鱼、巴菲、魔爪这类）→ 一直存在
   *   · 动作（猫爪、比耶、卖萌、心跳、蛋包饭这类）→ 演一次就消失
   * 所以「喵喵手 / 双手比耶 / 心跳 / 拿笔」都从这里搬走了：
   * 前三个是一次性动作，拿笔是常态（她本来就一直握着笔）。
   */
  const PROPS = {
    glassesRound: { label: '圆眼镜', expr: '圆眼镜', group: 'glasses', key: 'Alt+J' },
    glassesSquare: { label: '方眼镜', expr: '方眼镜', group: 'glasses', key: 'Alt+K' },
    glassesOval: { label: '椭圆眼镜', expr: '椭圆眼镜', group: 'glasses', key: 'Alt+L' },
    glassesSun: { label: '墨镜', expr: '墨镜', group: 'glasses', key: 'Alt+Z' },
    stickerCat: { label: '猫猫贴纸', expr: '猫猫贴纸', group: 'sticker', key: 'Alt+V' },
    stickerRabbit: { label: '兔兔贴纸', expr: '兔兔贴纸', group: 'sticker', key: 'Alt+B' },
    stickerBow: { label: '蝴蝶结贴纸', expr: '蝴蝶结贴纸', group: 'sticker', key: 'Alt+N' },
    flower: { label: '情绪花花', expr: '情绪花花', group: 'headwear', key: 'Alt+X' },
    ponytail: { label: '单边马尾', expr: '单边马尾', group: 'hair', key: 'Alt+2' },
    headband: { label: '发箍', expr: '头箍', group: 'headwear', key: 'Alt+3' },
    whaleHat: { label: '头顶鲸鱼', expr: '鲸鱼', key: 'Alt+1' },
  }

  /**
   * 场景摆设：换掉桌面布置，同样是「摆着不走」，再点一下才收。
   *
   * 「掏出手机」是原作者的一个**模式**（按键表里叫「自拍手机＆放下」）：
   * 掏出之后手机就摆在手上／桌上，自拍和快速自拍都在这个模式下才演。
   * 这里照搬这个依赖关系（见 requires），不是自己瞎编的组合。
   */
  const SCENES = {
    darkCloth: { label: '深色桌布', expr: '深色桌布', group: 'cloth', key: 'Alt+4' },
    whaleOnDesk: { label: '鲸鱼放桌上', expr: '鲸鱼放桌上', key: 'Del+Numpad1' },
    parfait: { label: '桌面巴菲', expr: '巴菲', key: '*+3' },
    claws: { label: '粉魔爪', expr: '魔爪', group: 'claw', clears: ['clawsWhite'], key: '*+4' },
    clawsWhite: { label: '白魔爪', expr: '魔爪换色', group: 'clawColor', needs: 'claws', key: '*+5' },
    phone: { label: '掏出手机', device: true, group: 'device', key: 'Del+Numpad4' },
    phoneSkin: { label: '手机换色', expr: '手机换色', needs: 'phone', key: 'Numpad0+2' },
  }

  /**
   * 常态道具：**不进菜单**（她本来就这样待着），放在这里只是让
   * IDLE_PROPS / WORK_PROPS 能按 key 解析出表达式。
   *
   * 这三个正好就是原作者绑在**左键按住**上的东西：点菜按下 + 画笔 + 挤
   * （`松键取消 = true`）——也就是说，按住她的时候她手里就是板子和笔。
   * 我们的常态道具跟人家的设计是一致的。
   */
  const BASE_ITEMS = {
    menuBoard: { label: '点菜板', expr: '点菜按下' },
    pen: { label: '拿笔', expr: '画笔' },
  }

  /**
   * 一次性动作：演一次就消失，绝不常驻。
   *
   * 全部照原作者的 `TriggerAnimation` / 动画类热键来（猫爪、比耶、冒爱心、
   * 挤番茄酱、自拍、喷水…），再加上主人点名的蛋包饭：
   * **「蛋包饭不能一直存在，蛋包饭只是挤完酱以后就消失了」**——
   * 所以它是「蛋包饭模式 + 挤番茄酱动画」合成的一次性表演。
   *
   * 机制上它们全部走 override 层（带 TTL 自动过期），**不写 userProps**，
   * 所以绝不会像装饰品那样赖在桌上。
   *
   * `requires` = 原作者设计里的前置模式（自拍类要先掏出手机），
   * 点了会自动补上前置，不用主人自己先开一遍。
   * `mood: null` = **不要压住动画自己的表情**：动作本身就带表情变化，
   * 我们再盖一张脸上去就是「冲突/覆盖」，所以这类动作把脸交还给动画。
   */
  const ACTIONS = {
    paw: {
      label: '猫爪摆手',
      motion: 'idle',
      ms: 4400,
      mood: null,
      key: 'Del+Numpad7',
      lines: ['（挥舞猫爪）喵喵喵～', '看人家的猫爪！', '（猫爪左右摆）可爱吧'],
    },
    catPaw: { label: '喵喵手', expr: '喵喵手~喵~动画', ms: 3000, mood: 'playful', key: 'Del+Numpad7', lines: ['（伸出猫爪）喵！', '爪爪在这里', '（捏了捏爪子）软的哦'] },
    doubleV: { label: '双手比耶', expr: '双手比耶', ms: 2800, mood: 'happy', key: 'Del+Numpad9', lines: ['（比耶）耶！', '看人家！', '胜利的手势～'] },
    love: { label: '冒爱心', expr: 'love', heart: true, ms: 3200, mood: null, key: 'Del+Numpad8', lines: ['（冒爱心）人家心情超好', '爱心发射～', '（飘了一串爱心）'] },
    heartbeat: { label: '心跳', expr: '心跳', heart: true, ms: 3200, mood: null, key: 'Alt+C', lines: ['（心跳加速）扑通扑通', '不、不是因为主人哦', '（捂胸口）人家没事！'] },
    squeeze: { label: 'MoeMoeQ~', expr: '挤', ms: 2600, mood: 'playful', key: '左键按住', lines: ['（捏）Moe moe Q～', '让人家挤一挤', '（被捏了）唔…'] },
    eraser: { label: '橡皮擦', expr: '橡皮', ms: 2600, mood: null, key: 'E', lines: ['（拿橡皮）擦掉重来', '这段不算，人家重写', '（擦擦擦）'] },
    undo: { label: '撤回', expr: '撤回', ms: 2600, mood: 'sweat', key: 'Ctrl+Z', lines: ['（撤回）刚才那句不算！', '人、人家没说过', '（赶紧撤回）'] },
    omurice: {
      label: '蛋包饭',
      expr: '蛋包饭',
      motion: 'ketchup',
      ms: 6200,
      mood: null,
      heart: true,
      key: 'Del+Numpad2 → 3',
      lines: ['（蛋包饭！）挤点番茄酱', '番茄酱画个爱心…给主人的', '（挤酱中）马上就好'],
    },
    selfie: {
      label: '自拍',
      motion: 'selfie',
      ms: 3600,
      mood: null,
      requires: 'phone',
      key: 'Del+Numpad5',
      lines: ['（举手机）笑一个～', '咔嚓！这张留给主人', '（找角度）人家这个角度最好看'],
    },
    selfieQuick: {
      label: '快速自拍',
      motion: 'selfieQuick',
      ms: 2000,
      mood: null,
      requires: 'phone',
      key: 'Del+Numpad6',
      lines: ['（咔嚓）好了！', '快拍一张', '（一秒拍完）'],
    },
    splash: { label: '鲸鱼喷水', motion: 'splash', ms: 2200, mood: null, key: '左键点她', lines: ['（喷水）噗——', '鲸鱼是会喷水的！', '（喷你一脸）嘻嘻'] },
  }
  const ACTION_KEYS = Object.keys(ACTIONS)

  const ALL_TOGGLES = Object.assign({}, BASE_ITEMS, PROPS, SCENES)

  /**
   * 两种底层状态下她手上拿什么。
   * 主人要的是：平时拿个板子待着，跑任务时拿记录板干活；自拍/比耶那类只作为
   * 「完成奖励」这类特殊场景的瞬时反应，不进待机循环。
   */
  // 主人定的常态：手里是「本子 + 笔」，思考和待机都这样。
  // 眼镜/手机之类由具体工具反应临时加，装饰品（猫耳、单马尾、贴纸）由主人自己开、能一直留着。
  const IDLE_PROPS = ['menuBoard', 'pen']
  const WORK_PROPS = ['menuBoard', 'pen']

  /**
   * 菜单里每一项「点了会怎样」。
   *
   * 主人抱怨「有的点击之后是没用的……像白魔爪还有蛋包饭，那也只是卡在那没什么用」。
   * 病根不是参数没生效（每个都真的变了），而是**点完之后她本人毫无反应**——
   * 桌上多了盘蛋包饭，她却面无表情地待机，看起来就像按钮坏了。
   *
   * 所以从这一版起：**每一个表情、每一个道具、每一个场景都配一句话 + 一个小动作**，
   * 而且一次只演一个（act() 负责把上一个收干净），不叠、不重复、到点自动收。
   * 台词按她的口气写：傲娇、爱吃白米、管人叫主人、不能被叫胖。
   */
  const FACE_ACT = {
    listening: { lines: ['（眼睛发亮）主人你说', '嗯嗯，人家听着呢', '（凑过来）什么什么'] },
    excited: { lines: ['主人主人！有好玩的吗', '（星星眼）人家准备好了', '（蹦）期待！'] },
    happy: { lines: ['嘿嘿，今天心情不错', '（笑）本鲸就是这么厉害', '心情好，看什么都顺眼'] },
    love: { lines: ['最喜欢主人了', '（冒爱心）', '（心跳）不、不是因为主人哦'], heart: true },
    shy: { lines: ['别、别一直看着人家啦', '（脸红）干嘛突然这样', '唔…人家会不好意思的'] },
    pout: { lines: ['哼', '（扭头）人家才没有高兴', '别以为人家好哄'] },
    smug: { lines: ['（眯眼）本鲸很厉害吧', '夸人家两句嘛', '这算什么，小意思'] },
    playful: { lines: ['（闭一只眼）就逗你玩', '略，被人家骗到了吧', '（眨眼）'] },
    sad: { lines: ['呜…人家有点难过', '（低头）', '（抱着膝盖）'] },
    cry: { lines: ['哇——主人欺负人', '（哭）人家不干了啦', '（眼泪汪汪）'] },
    grumpy: { lines: ['（鼓脸）哼！', '人家生气了，真的', '除非给一碗白饭，不然不原谅'] },
    gloomy: { lines: ['（阴暗角落）……', '人家现在心情很差', '（长蘑菇）'] },
    sweat: { lines: ['（冷汗）这个…有点难', '人、人家在努力了', '（擦汗）'] },
    confused: { lines: ['诶？', '（歪头）主人说的是什么', '（问号）人家没听懂'] },
    alert: { lines: ['！（惊）', '（猛地抬头）怎么了怎么了', '吓人家一跳！'] },
    tongue: { lines: ['略略略', '就不理你', '（吐舌头）人家赢了'] },
    dead: { lines: ['（吐魂）人家人家不行了…', '（灵魂出窍）摸鱼被抓到了', '（瘫）需要白饭急救'] },
    sleepy: { lines: ['（打瞌睡）唔…人家没睡', '（流口水）梦见白饭了', '（眯眼）主人让开，挡住光了'] },
  }

  /** 装饰品：戴上时说什么。**不叠别的东西**——主人说「不要瞎组合」。 */
  const PROP_ACT = {
    glassesRound: { mood: 'reading', lean: true, lines: ['（扶了扶眼镜）人家看看', '圆框的，适合人家吗', '（推眼镜）这道题人家会'] },
    glassesSquare: { mood: 'reading', lean: true, lines: ['（一本正经）人家现在是学者', '方框的，显脸小吧', '（推眼镜）认真模式'] },
    glassesOval: { mood: 'reading', lean: true, lines: ['（圆圆的镜片）好看吗', '这个戴着温柔一点', '（看）嗯…清楚了'] },
    glassesSun: { mood: 'smug', lines: ['（戴墨镜）本鲸谁也不怕', '酷不酷？', '（耍帅）今天走酷路线'] },
    stickerCat: { mood: 'happy', lines: ['（贴上）喵～', '人家是猫还是鲸鱼呀', '（猫猫贴纸）可爱吧'] },
    stickerRabbit: { mood: 'happy', lines: ['（兔兔贴纸）蹦蹦', '兔兔也很可爱嘛', '耳朵长长的'] },
    stickerBow: { mood: 'shy', lines: ['（蝴蝶结）好看吗好看吗', '人家今天很可爱哦', '（摸摸蝴蝶结）'] },
    flower: { mood: 'happy', lines: ['（脑门上开花了）', '人家现在心情超好', '（花花）送主人的'] },
    ponytail: { mood: 'smug', lines: ['（扎起来）干活方便', '马尾好看吗', '（甩了甩）'] },
    headband: { mood: 'excited', lines: ['（戴上发箍）清爽！', '人家要开始努力了', '（发箍）请多指教'] },
    whaleHat: { mood: 'happy', lines: ['（头顶蹲了一只鲸鱼）', '它和人家是一家的', '看，人家的同类'] },
  }

  /** 场景摆设：摆上时说什么。摆着不走，再点一下才收。 */
  const SCENE_ACT = {
    darkCloth: { mood: 'smug', lines: ['（换桌布）今天走高级风', '深色显瘦…人家说的是桌子', '（拉平桌布）'] },
    whaleOnDesk: { mood: 'happy', lines: ['（把鲸鱼摆桌上）陪着人家', '看，同类', '（拍一拍鲸鱼）'] },
    parfait: { mood: 'love', heart: true, lines: ['（巴菲！）人家开动了', '甜品时间到！', '（挖一大勺）唔…好吃'] },
    claws: { mood: 'playful', lines: ['（亮爪子）看人家的爪', '粉色爪子，可爱又危险', '（磨爪子）'] },
    clawsWhite: { mood: 'playful', lines: ['（换成白色的爪子）这个更锋利', '白色爪子，帅气吧', '（亮爪）这下认真了'] },
    phone: { mood: 'excited', lines: ['（掏出手机）人家看看', '（开盖）有新消息吗', '手机在手，天下我有'] },
    phoneSkin: { mood: 'smug', lines: ['（换个手机壳）好看吗', '这个颜色人家喜欢', '（翻来覆去地看）'] },
  }

  /**
   * 工具 → 桌宠怎么演。
   *
   * 设计原则（改这张表就能改性格）：
   *   · 干活不该是阴着脸的——「跑命令」改成伸长猫爪敲键盘的专注样
   *   · 读/查/翻资料 = 戴眼镜 + 低头凑近看（lean 就是低头幅度）
   *   · 写/改 = 猫爪打字
   *   · 问你 = 问号；交付 = 比耶
   *   · 只有真的出错/卡住才用「汗」「晕」
   */
  /**
   * 工具 → 她在气泡里说的话。
   *
   * 主人嫌「老是敲键盘 / 跑命令」太单调，所以：
   *   · **按工具分开写**，每个工具好几句，用 pickFresh 轮换，连着同名工具也不重复
   *   · 用她的口气（傲娇、爱吃白米、管人叫主人）
   *   · 气泡第二行放**从工具参数里抽出来的具体内容**（跑的是哪条命令、读的是哪个文件），
   *     这样 Agent 里在干什么，桌宠这边能同步看出来
   */
  const TOOL_LINE = {
    bash: ['（挽袖子）跑个命令试试', '让人家敲两行命令', '命令行交给人家', '（噼里啪啦）跑起来了', '这个命令人家熟'],
    read: ['（凑近看）先读一下这份', '人家看看里面写了啥', '翻开看看…', '（认真脸）读一下'],
    write: ['好，人家写出来', '（奋笔疾书）写上了', '这就给你落成文件', '写成文件啦'],
    edit: ['（改改改）这里调一下', '人家把这段改掉', '（橡皮擦）修一修', '这段人家重写一下'],
    glob: ['（翻箱倒柜）找找在哪儿', '人家找找这个文件', '翻一下目录'],
    grep: ['（眯着眼）搜一下关键词', '人家查查哪里用到了', '（翻）搜搜看'],
    web_search: ['（掏手机）上网查一下', '人家搜搜看', '（划手机）查查这个', '网上应该有答案'],
    web_fetch: ['（点开链接）读读这页', '人家看看这个网页', '（凑近屏幕）'],
    search_papers: ['（翻文献）查查有没有人写过', '人家去翻翻论文', '（戴眼镜）查文献去'],
    kb_search: ['（查资料库）人家找找', '翻翻知识库', '（翻）这儿应该有'],
    kb_rag: ['（查资料库）人家找找', '翻翻知识库', '（翻）这儿应该有'],
    kb_ingest: ['（搬书）人家收进库里', '把这份收好'],
    todo_write: ['（列清单）先排个计划', '人家记一下要做啥', '（在本子上划拉）'],
    subagent: ['（招手）叫个分身来帮忙', '人家派个分身去办', '（分工）这就安排'],
    subagent_fork: ['（招手）叫个分身来帮忙', '人家派个分身去办'],
    workflow: ['（排兵布阵）同时开几路', '人家把活儿分一下'],
    ask_user_question: ['（歪头）这个得问问主人', '人家不确定，问一下'],
    present: ['（举起来）喏，给你', '人家交付啦', '（递过去）弄好了'],
    pdf_create: ['（排版）给你出一份 PDF', '人家做份文档'],
    docx_create: ['（排版）给你出份 Word', '人家写份文档'],
    xlsx_write: ['（拉表格）数字给你排好', '人家做个表'],
    pptx_create: ['（做幻灯片）给你排几页', '人家弄个 PPT'],
    sci_draw: ['（画画）人家画一个', '（拿笔）给你画出来'],
    create_goal: ['（立个目标）人家记下了', '这个人家盯着办'],
    update_goal: ['（更新一下目标）', '人家改一下计划'],
    skill: ['（翻手册）人家查查怎么弄', '（翻）这个人家学过'],
    auto_cite: ['（加引用）人家补上出处', '引用人家来配'],
    get_goal: ['（看一眼任务）', '人家看看进度'],
  }

  /** 从工具参数里抽一句「具体在干什么」，让气泡跟 Agent 真正同步。 */
  function toolHint(argsJson) {
    let a = {}
    try {
      a = JSON.parse(argsJson || '{}')
    } catch (e) {
      return ''
    }
    const keys = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'title', 'description', 'prompt']
    let s = ''
    for (const k of keys) {
      if (a[k]) {
        s = String(a[k])
        break
      }
    }
    if (!s && Array.isArray(a.queries) && a.queries.length) s = String(a.queries[0])
    if (!s) return ''
    s = s.replace(/\s+/g, ' ').trim()
    return s.length > 46 ? s.slice(0, 46) + '…' : s
  }

  /** 需要「掏出小设备」的工具（搜索/查资料这类）。用模型自带的开盖动作，不自己编。 */
  const DEVICE_TOOLS = new Set([
    'web_search', 'web_fetch', 'search_papers', 'kb_search', 'kb_rag',
    'search_semantic', 'search_google_scholar', 'pubmed_search_papers',
    'search_arxiv', 'browser', 'fetch',
  ])

  /**
   * 读资料时戴哪副眼镜——**每次随机**，也可能不戴。
   * 主人说的：工作认真看就行，眼镜随机（半框/圆框/不戴）。
   */
  function randomGlasses() {
    const r = Math.random()
    if (r < 0.34) return 'glassesRound'
    if (r < 0.62) return 'glassesSquare' // 半框方眼镜
    if (r < 0.72) return 'glassesOval'
    return null // 三成左右不戴
  }

  const TOOL_REACT = {
    // —— 阅读 / 检索：认真看（眼镜随机：圆框 / 半框方框 / 不戴），低头看本子 ——
    read: { mood: 'reading', prop: 'auto' },
    glob: { mood: 'thinking', prop: 'auto' },
    grep: { mood: 'reading', prop: 'auto' },
    web_fetch: { mood: 'reading', prop: 'auto' },
    web_search: { mood: 'thinking', prop: 'auto' },
    kb_search: { mood: 'reading', prop: 'auto' },
    kb_rag: { mood: 'reading', prop: 'auto' },
    kb_ingest: { mood: 'happy', prop: 'auto' },
    search_papers: { mood: 'reading', prop: 'auto' },
    auto_cite: { mood: 'reading', prop: 'auto' },
    pubmed_search_papers: { mood: 'reading', prop: 'auto' },
    pubmed_pubtator_search: { mood: 'reading', prop: 'auto' },
    search_arxiv: { mood: 'reading', prop: 'auto' },
    pdf_read: { mood: 'reading', prop: 'auto' },
    docx_read: { mood: 'reading', prop: 'auto' },
    xlsx_read: { mood: 'reading', prop: 'auto' },
    pptx_read: { mood: 'reading', prop: 'auto' },
    skill: { mood: 'reading', prop: 'auto' },

    // —— 桌面灵视觉工具支持 ——
    screen_capture: { mood: 'reading', prop: 'glassesRound' },
    template_match_click: { mood: 'thinking', prop: 'auto' },
    desktop_click: { mood: 'happy', prop: 'auto' },
    desktop_double_click: { mood: 'happy', prop: 'auto' },
    desktop_type: { mood: 'working', prop: 'auto' },
    get_desktop_windows: { mood: 'reading', prop: 'auto' },

    // —— 干活：认真看本子，不摆手、不卖萌 ——
    bash: { mood: 'reading', prop: null },
    write: { mood: 'reading', prop: null },
    edit: { mood: 'reading', prop: null },
    todo_write: { mood: 'happy', prop: 'stickerCat' },
    subagent: { mood: 'thinking', prop: null },
    subagent_fork: { mood: 'thinking', prop: null },
    task: { mood: 'thinking', prop: null },
    workflow: { mood: 'thinking', prop: null },
    ralph: { mood: 'thinking', prop: null },

    // —— 产出 / 交付：干完了才有一点表示 ——
    present: { mood: 'happy', prop: 'stickerCat' },
    pdf_create: { mood: 'happy', prop: 'stickerCat' },
    docx_create: { mood: 'happy', prop: 'stickerCat' },
    pptx_create: { mood: 'happy', prop: 'stickerCat' },
    xlsx_write: { mood: 'happy', prop: 'stickerCat' },
    sci_draw: { mood: 'excited', prop: 'flower' },

    // —— 交互 / 目标 ——
    ask_user_question: { mood: 'confused', prop: null },
    create_goal: { mood: 'alert', prop: 'heartbeat' },
    update_goal: { mood: 'alert', prop: null },
    get_goal: { mood: 'thinking', prop: null },
  }

  /**
   * 人设台词。规格（用户给定）：
   *   · 称呼用户「主人」；自称「人家」或「本鲸」；**不叫鱼片**
   *   · 傲娇嘴甜、嘴硬心软；聪明但懒、爱摸鱼
   *   · 贪吃，喜欢白米饭，把 Token 当口粮
   *   · 不能被叫「胖」，叫了会真生气
   *   · 对主人服从（违法危险的请求归 agent 层去拒绝，桌宠只管演）
   */
  const SAY = {
    idle: [
      '主人~ 人家累了，摸摸头嘛。',
      '主人，人家想吃白饭…',
      '（趴桌上）就眯一小会儿…',
      'Token 也算口粮吧？人家不挑的',
      '主人今天也辛苦啦',
      '（尾巴轻轻摆）',
    ],
    slack: ['就玩一小会儿，主人不会发现的……', '（偷偷摸鱼）', '反正主人也没在看…', '（假装很忙）'],
    start: ['好啦好啦，人家这就开始。', '知道啦，本鲸这就去。', '（挽袖子）看人家的。'],
    done: [
      '看吧，本鲸出马一个顶俩！奖励一碗白饭不过分吧？',
      '搞定～主人快夸人家',
      '（伸懒腰）完事啦',
      '就这？本鲸还没使劲呢',
    ],
    fail: ['呜……这不能怪人家，是任务太难了啦！', '（慌张）不、不是人家的错吧…', '（看表叹气）这个真的好难嘛'],
    head: ['不要突然摸头啦……再摸一下也不是不行。', '唔…头发要乱了啦', '（脸红）就、就一下哦', '哼，本鲸才没有很享受'],
    body: ['喂！别戳人家啦', '痒！主人你干嘛', '哼，本鲸不理你了'],
    many: [
      '够啦够啦！主人你今天很闲嘛',
      '再戳人家要生气了哦',
      '（炸毛）',
      '主人你再戳，人家就咬你了',
      '手、手拿开啦！',
      '（把本子举起来挡）不许戳了！',
      '本鲸也是有脾气的！',
      '哼！不理你了，除非给一碗白饭',
    ],
    /** 快但还没到炸毛：被戳痒了，可爱地抗议一下，不是真生气。 */
    ticklish: [
      '哈哈哈别戳啦，痒！',
      '（躲）主人你手好快',
      '喂喂喂，人家在待机呢',
      '（缩成一团）住手啦',
      '这么快？主人手速好可怕',
      '唔…再戳人家要哼你了哦',
      '（抱着本子躲到角落）',
    ],
    fat: ['你再说一遍？！人家这是可爱，不是胖！', '本鲸这是丰腴！', '（真生气）不许说胖！'],
    hungry: ['主人，人家饿了…有白饭吗', '（盯着你的碗）', '干了这么多活，该管饭了吧'],
    reading: [
      '（凑近看）这份资料人家得仔细看看。',
      '（认真翻阅）资料有点多呢，稍等人家一下下哦~',
      '（推了推眼镜）待人家查阅一番相关档案…',
      '（目不转睛）材料很关键，正在全神贯注阅读中。',
    ],
    /** 场景大件收走的时候说的话（不然东西凭空消失很怪）。 */
    tidy: ['（收拾一下桌面）', '好啦，人家收起来了', '摆一会儿就够了，人家还要干活呢', '（把东西归位）'],
    thinking: [
      '（咬着笔杆）让人家想想，这个问题该怎么解决呢…',
      '（敲了敲脑袋）嗯…这里得仔细捋一捋思路。',
      '（托腮沉思）别催别催，就快想出来啦！',
      '（灵光一闪）让本伴侣的大脑飞速运转一下~',
    ],
    working: ['（敲键盘）', '交给人家的就放心', '噼里啪啦…', '（认真工作）'],
    wake: ['唔…怎么了主人', '人家醒着呢', '（揉眼睛）'],
  }
  const pick = (arr) => arr[(Math.random() * arr.length) | 0]

  /**
   * 不重复上一次的选择。主人抱怨「点他老是同一个表情/同一句话」——
   * 这里记住上一次挑中的是哪个，下一轮把它排除掉，保证连着点不会撞车。
   */
  const lastPick = new Map()
  /**
   * 权重：条目可以写 `w`（默认 1）。
   * 用来让「真生气」这种反应变稀有——主人抱怨「平常点几下就生气」，
   * 生气不该和摸摸头一样常见。
   */
  const weightOf = (x) => (x && typeof x === 'object' && typeof x.w === 'number' ? x.w : 1)
  function pickFresh(arr, key) {
    if (!arr || !arr.length) return undefined
    const k = key || 'default'
    const prev = lastPick.get(k)
    const pool = arr.length > 1 && prev !== undefined ? arr.filter((x) => x !== prev) : arr
    let total = 0
    for (const x of pool) total += weightOf(x)
    let r = Math.random() * total
    let chosen = pool[pool.length - 1]
    for (const x of pool) {
      r -= weightOf(x)
      if (r <= 0) {
        chosen = x
        break
      }
    }
    lastPick.set(k, chosen)
    return chosen
  }

  // ——————————————————————————————————————————————————————————————
  // 二、样式
  // ——————————————————————————————————————————————————————————————
  //
  // 注意：这里刻意**不叫 `CSS`** —— 浏览器里 `window.CSS` 是 CSSOM 命名空间，
  // 一旦这个名字没被正确声明，`s.textContent = CSS` 不会报错，只会把样式表内容
  // 写成 "[object CSS]"（12 个字符），整个界面静默失去定位与外观。踩过一次。

  const PET_CSS = `
.dshp-root{position:fixed;z-index:2147483000;pointer-events:none;
  --dshp-s:1;
  /* 面板单独一套缩放：气泡和工具栏可以跟着模型缩得很小，但菜单里有滑块、
     有按钮，缩成指甲盖大小就没法用了。所以面板的缩放被夹在 0.85~1.15。 */
  --dshp-ps:1;
  /* 工具栏（底下三个按钮）比模型再小一号，主人说原来那三框太大 */
  --dshp-ds:0.86;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  --dshp-fg:#132043;--dshp-bg:rgba(246,249,255,.96);--dshp-line:rgba(30,60,130,.14);
  /* 鲸鱼蓝（和官网、App 图标同一套色）；只改颜色，别的一律不动 */
  --dshp-accent:#3b62f6;--dshp-radius:14px;transition:opacity .25s ease}
/* 整只桌宠界面默认**不可选中**（拖动时不会把文字/页签一起选走，#11 提到的问题）；
   但聊天气泡和简报正文要保持可选中 —— 主人可能要复制内容。 */
.dshp-root{user-select:none;-webkit-user-select:none}
.dshp-bubble,.dshp-report-text{user-select:text;-webkit-user-select:text}

.dshp-root.dshp-hidden{opacity:0;pointer-events:none!important}
.dshp-root.dshp-client-detached{opacity:0!important;pointer-events:none!important}
body.dshp-client-detached .dshp-detached-pill{display:flex}
/* 恢复用的把手挂在 body 上、不在 .dshp-root 里，所以这里必须是 body 级类：
   用后代选择器会永远匹配不到，隐藏之后就再也找不回来了。 */
body.dshp-pet-hidden .dshp-tab{display:flex}
.dshp-tab:hover{transform:translateY(-1px)}
@media (prefers-color-scheme:dark){.dshp-root{--dshp-fg:#eaf0ff;--dshp-bg:rgba(18,26,48,.95);--dshp-line:rgba(140,175,255,.20);--dshp-accent:#7b9bff}}
.dshp-stage{position:absolute;left:0;bottom:0;pointer-events:none;
  filter:drop-shadow(0 10px 20px rgba(0,0,0,.24))}
.dshp-stage canvas{display:block;pointer-events:none}
.dshp-bubble{position:absolute;left:50%;bottom:100%;
  transform:translate(calc(-50% + var(--dshp-shift,0px)),calc(6px + var(--dshp-shift-y,0px))) scale(.96);
  margin-bottom:calc(10px * var(--dshp-s));min-width:calc(110px * var(--dshp-s));
  max-width:min(calc(300px * var(--dshp-s)),70vw);pointer-events:auto;
  background:var(--dshp-bg);color:var(--dshp-fg);border:1px solid var(--dshp-line);
  border-radius:calc(var(--dshp-radius) * var(--dshp-s));
  padding:calc(9px * var(--dshp-s)) calc(12px * var(--dshp-s)) calc(8px * var(--dshp-s));
  box-shadow:0 8px 28px rgba(10,14,30,.18);backdrop-filter:blur(14px) saturate(1.3);
  font-size:calc(12.5px * var(--dshp-s));line-height:1.55;opacity:0;visibility:hidden;
  transition:opacity .18s ease,transform .18s ease;overflow-wrap:anywhere;word-break:break-word}
.dshp-bubble.dshp-on{opacity:1;visibility:visible;
  transform:translate(calc(-50% + var(--dshp-shift,0px)),var(--dshp-shift-y,0px)) scale(1)}
.dshp-bubble:after{content:"";position:absolute;left:50%;bottom:-6px;margin-left:-6px;
  width:12px;height:12px;background:var(--dshp-bg);border-right:1px solid var(--dshp-line);
  border-bottom:1px solid var(--dshp-line);transform:rotate(45deg);border-radius:0 0 3px 0}
.dshp-head{display:flex;align-items:center;gap:calc(6px * var(--dshp-s));
  margin-bottom:calc(3px * var(--dshp-s));
  font-size:calc(10.5px * var(--dshp-s));letter-spacing:.04em;color:var(--dshp-accent);font-weight:600}
.dshp-dot{width:calc(6px * var(--dshp-s));height:calc(6px * var(--dshp-s));
  border-radius:50%;background:var(--dshp-accent);flex:none}
.dshp-dot.dshp-pulse{animation:dshp-pulse 1.1s ease-in-out infinite}
@keyframes dshp-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.25)}}
.dshp-body{max-height:150px;overflow:auto;white-space:pre-wrap}
.dshp-body::-webkit-scrollbar{width:5px}
.dshp-body::-webkit-scrollbar-thumb{background:var(--dshp-line);border-radius:3px}
.dshp-foot{margin-top:calc(4px * var(--dshp-s));font-size:calc(10px * var(--dshp-s));opacity:.55;min-height:0}
/* 工具栏：主人抱怨底下那三个框「太大、不太适配」。
   真正的病根是 left:50% —— 绝对定位元素的可容纳宽度只剩下父容器的一半，
   三个按钮被挤成 104px，文字折行后每个都变成又窄又高的方块。
   width:max-content 让它超出那半幅也能保持居中，按钮就恢复成正常的一行小按钮。 */
.dshp-dock{position:absolute;left:50%;transform:translateX(-50%);
  bottom:calc(-40px * var(--dshp-ds));display:flex;gap:calc(7px * var(--dshp-ds));
  width:max-content;white-space:nowrap;
  pointer-events:auto;opacity:0;transition:opacity .22s ease}
/* ——— 工作简报：头顶的「信封」+ 点开的大号简报面板 ———
   信封是画出来的（不是 emoji）：白纸 + 鲸鱼蓝描边 + 折口，深浅背景下都清楚；
   角标是微信那种「红圈白字」。整体小、浮在她头顶右上，不挡她本人。 */
.dshp-mail{position:absolute;left:50%;bottom:100%;pointer-events:auto;cursor:pointer;
  transform:translate(calc(-50% + var(--dshp-shift,0px) + 44px),calc(-8px + var(--dshp-shift-y,0px)));
  width:34px;height:28px;padding:0;border:0;background:transparent;display:grid;place-items:center;
  filter:drop-shadow(0 3px 7px rgba(10,20,50,.28));transition:transform .16s ease}
.dshp-mail:hover{transform:translate(calc(-50% + var(--dshp-shift,0px) + 44px),calc(-12px + var(--dshp-shift-y,0px))) scale(1.06)}
.dshp-mail svg{width:32px;height:25px;display:block}
.dshp-mail .paper{fill:#f8fbff;stroke:#3b62f6;stroke-width:1.6}
.dshp-mail .flap{fill:none;stroke:#3b62f6;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.dshp-mail .inner{fill:#dbe6ff}
.dshp-mail-badge{position:absolute;right:-2px;bottom:-3px;min-width:15px;height:15px;padding:0 4px;
  border-radius:999px;background:#ff3b30;color:#fff;font-size:10.5px;font-weight:700;line-height:15px;
  text-align:center;border:1.5px solid var(--dshp-bg);box-sizing:content-box}
.dshp-mail.dshp-mail-new svg{animation:dshp-mail-nudge 1.9s ease-in-out infinite}
@keyframes dshp-mail-nudge{
  0%,100%{transform:translateY(0) rotate(0deg)}
  45%{transform:translateY(-2px) rotate(-3deg)}
  70%{transform:translateY(0) rotate(2deg)}}
.dshp-report{width:min(360px,calc(100vw - 30px));max-height:min(430px,calc(100vh - 150px));
  overflow:hidden;display:flex;flex-direction:column;transition:opacity .16s ease,transform .16s ease}
/* 有互动时面板先「隐身」，互动结束后再回来（见 onBubbleEvent） */
.dshp-report.dshp-report-yield{opacity:0;transform:translateY(-5px) scale(.985);pointer-events:none}
.dshp-report-head{display:flex;align-items:center;gap:6px;padding:1px 2px 8px;font-size:13px;font-weight:600}
.dshp-report-head .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshp-report-head .n{font-size:11px;font-weight:500;color:var(--dshp-accent);opacity:.9;flex-shrink:0}
.dshp-report-acts{display:flex;align-items:center;gap:1px;flex-shrink:0}
.dshp-report-act{height:20px;padding:0 5px;border:0;border-radius:6px;background:transparent;
  color:var(--dshp-fg);opacity:.55;font-size:11px;cursor:pointer;line-height:20px}
.dshp-report-act:hover{opacity:1;background:rgba(90,130,255,.12)}
.dshp-report-min,.dshp-report-close{width:20px;height:20px;padding:0;border:0;border-radius:6px;
  background:transparent;color:var(--dshp-fg);opacity:.5;font-size:14px;line-height:20px;cursor:pointer;text-align:center}
.dshp-report-min:hover{opacity:1;background:rgba(90,130,255,.12)}
.dshp-report-close:hover{opacity:1;background:rgba(255,80,80,.14);color:#ff5b52}
.dshp-report-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  padding-right:8px;scrollbar-gutter:stable}
.dshp-report-item{position:relative;padding:8px 0 9px;border-top:1px solid var(--dshp-line)}
.dshp-report-item:first-child{border-top:0}
.dshp-report-meta{display:flex;align-items:center;gap:5px;font-size:11px;opacity:.6;
  margin-bottom:3px;padding-right:20px}
.dshp-report-dot{width:6px;height:6px;border-radius:50%;background:#ff3b30;flex-shrink:0}
.dshp-report-item.dshp-report-new .dshp-report-meta{opacity:.95;color:var(--dshp-accent)}
.dshp-report-text{font-size:12.5px;line-height:1.62;white-space:pre-wrap;word-break:break-word}
.dshp-report-row{display:flex;justify-content:flex-end;gap:4px;margin-top:6px}
.dshp-report-btn{height:19px;padding:0 7px;border:1px solid var(--dshp-line);border-radius:6px;
  background:transparent;color:var(--dshp-fg);font-size:11px;cursor:pointer;line-height:17px}
.dshp-report-btn:hover{border-color:var(--dshp-accent);color:var(--dshp-accent)}
.dshp-report-btn.del:hover{border-color:#ff5b52;color:#ff5b52}
.dshp-report-btn.on{opacity:.4;cursor:default}
.dshp-report-x{position:absolute;top:6px;right:0;width:18px;height:18px;padding:0;border:0;cursor:pointer;
  border-radius:6px;background:transparent;color:var(--dshp-fg);opacity:.42;font-size:13px;line-height:18px}
.dshp-report-x:hover{opacity:1;background:rgba(255,80,80,.14);color:#ff5b52}

.dshp-root.dshp-hover .dshp-dock,.dshp-root.dshp-open .dshp-dock,.dshp-dock.dshp-dock-active{opacity:1;pointer-events:auto}
/* 菜单/设置内容过长时**可滚动**（鼠标滚轮、触控板直接搓都行）。
   ⚠️ 这里刻意只给「内容区」限高 + overflow，**不把面板改成 flex 容器** ——
   上次那样改会让内容区塌成 0 高（框弹出来但是空的）。 */
/* ——— 菜单面板：固定大小 + 固定位置（切页签/切动作都不再变来变去）———
   ① 宽高写死（高度也随屏幕兜底），所以「表情 / 装饰 / 场景 / 动作 / 设置」五个页签
      切换时面板尺寸完全一致，不会跳、不会时大时小；
   ② 内容超出就在内容区内部滚动（鼠标滚轮/触控板直接搓）；
   ③ 面板高度留够，永远排在她头顶上方，不会盖住她本人。
   ⚠️ 这里用「固定高度 + 百分比内容区」，**不用 flex 容器** —— flex+min-height:0
   会让内容区塌成 0 高（框弹出来但是空的），我们踩过这个坑。 */
/* 外观：跟随系统 / 浅色 / 深色 —— 手动档位覆盖系统媒体查询 */
.dshp-root[data-dshp-theme="light"]{--dshp-fg:#132043;--dshp-bg:rgba(246,249,255,.96);
  --dshp-line:rgba(30,60,130,.14);--dshp-accent:#3b62f6}
.dshp-root[data-dshp-theme="dark"]{--dshp-fg:#eaf0ff;--dshp-bg:rgba(18,26,48,.95);
  --dshp-line:rgba(140,175,255,.20);--dshp-accent:#7b9bff}
/* 苹果风的克制排版：说明文字更小、更淡；控件行距更松 */
.dshp-hint{font-size:11px;opacity:.62;line-height:1.5}
.dshp-label{font-size:12.5px}
.dshp-btn{font-size:12.5px;padding:7px 12px;border-radius:9px}

/* 菜单侧边智能停靠：停靠在角色左右两侧，彻底避开上方对话气泡/互动卡片与下方输入框 */
.dshp-menu{
  position:absolute!important;bottom:auto!important;top:50%!important;
  width:360px!important;height:min(320px, calc(100vh - 120px))!important;
  overflow:hidden!important;box-sizing:border-box!important;
  z-index:20;
}
.dshp-menu.dshp-dock-right{
  left:calc(100% + 14px * var(--dshp-ps))!important;right:auto!important;
  transform:translateY(calc(-50% + var(--dshp-shift-y, 0px))) translateX(var(--dshp-shift, 0px))!important;
}
.dshp-menu.dshp-dock-left{
  right:calc(100% + 14px * var(--dshp-ps))!important;left:auto!important;
  transform:translateY(calc(-50% + var(--dshp-shift-y, 0px))) translateX(var(--dshp-shift, 0px))!important;
}
/* 主动场景关怀卡片 (单次关怀协议专用) */
.dshp-care-card{
  position:absolute!important;bottom:calc(100% + 14px * var(--dshp-ps))!important;left:50%!important;
  transform:translateX(-50%)!important;width:min(calc(320px * var(--dshp-ps)), 86vw)!important;
  background:var(--dshp-bg)!important;color:var(--dshp-fg)!important;border:1px solid var(--dshp-line)!important;
  border-radius:calc(var(--dshp-radius) * var(--dshp-ps))!important;padding:12px 14px!important;
  box-shadow:0 16px 42px rgba(10,14,30,.32)!important;backdrop-filter:blur(16px)!important;
  z-index:9999!important;pointer-events:auto!important;font-size:12.5px!important;
  user-select:text!important;-webkit-user-select:text!important;
  opacity:1!important;visibility:visible!important;
  transition:opacity .2s ease, transform .2s ease!important;
}
.dshp-care-card.dshp-hidden{
  opacity:0!important;visibility:hidden!important;pointer-events:none!important;
  transform:translateX(-50%) translateY(8px)!important;
}
.dshp-care-card button{
  pointer-events:auto!important;cursor:pointer!important;
}
.dshp-care-card input{
  pointer-events:auto!important;user-select:text!important;-webkit-user-select:text!important;
  cursor:text!important;
}
.dshp-care-progress{height:3px;background:var(--dshp-accent);border-radius:2px;margin-top:8px;transition:width 0.2s linear}
/* 内容区：给出**明确的像素高度**（不依赖百分比解析），并保持可滚动。
   ⚠️ 上一版这里写的是 max-height:none —— 它把负责限高的那条规则干掉了，
   于是内容直接溢出到框外（主人截图里文字跑出面板就是这个原因）。 */
.dshp-menu .dshp-panes{
  height:calc(min(320px, 100vh - 120px) - 42px)!important;
  max-height:calc(min(320px, 100vh - 120px) - 42px)!important;
  overflow-y:auto!important;overflow-x:hidden!important;
  overscroll-behavior:contain;padding-right:12px;
  scrollbar-gutter:stable}
.dshp-panes{max-height:calc(100vh - 180px);overflow-y:auto;overflow-x:hidden;
  overscroll-behavior:contain;scrollbar-width:thin}
.dshp-panes::-webkit-scrollbar{width:8px}
.dshp-panes::-webkit-scrollbar-thumb{background:rgba(120,140,180,.45);border-radius:4px}
.dshp-panes::-webkit-scrollbar-track{background:transparent}
.dshp-hud{max-height:calc(100vh - 40px);overflow-y:auto;overscroll-behavior:contain}
.dshp-btn{border:1px solid var(--dshp-line);background:var(--dshp-bg);color:var(--dshp-fg);
  border-radius:calc(11px * var(--dshp-ds));flex:0 0 auto;white-space:nowrap;
  padding:calc(5px * var(--dshp-ds)) calc(11px * var(--dshp-ds));
  font-size:calc(13px * var(--dshp-ds));cursor:pointer;line-height:1.5;
  box-shadow:0 3px 10px rgba(10,14,30,.14);transition:transform .12s ease}
/* 纯符号按钮（打开 DSH / 收起）：正方形一点，只放一个符号 */
.dshp-btn.dshp-icon{padding:calc(5px * var(--dshp-ds)) calc(9px * var(--dshp-ds));
  font-size:calc(15px * var(--dshp-ds));line-height:1.2}
/* 大小加减键 */
.dshp-btn.dshp-step{min-width:calc(30px * var(--dshp-ds));text-align:center;
  font-size:calc(17px * var(--dshp-ds));font-weight:600;line-height:1.1}
.dshp-btn:hover{transform:translateY(-1px)}
.dshp-btn:active{transform:translateY(0) scale(.96)}
.dshp-btn:disabled{opacity:.5;cursor:default}
.dshp-btn.dshp-primary{background:var(--dshp-accent);color:#fff;border-color:transparent}
.dshp-close{position:absolute;top:5px;right:6px;width:22px;height:22px;line-height:1;
  border:none;border-radius:7px;background:transparent;color:inherit;opacity:.5;
  font-size:15px;cursor:pointer;padding:0}
.dshp-close:hover{opacity:1;background:rgba(124,92,255,.14)}
.dshp-panel{position:absolute;bottom:calc(100% + 10px * var(--dshp-ps));left:50%;
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(calc(4px + var(--dshp-shift-y,0px)));
  width:min(calc(320px * var(--dshp-ps)),86vw);pointer-events:auto;
  background:var(--dshp-bg);color:var(--dshp-fg);
  border:1px solid var(--dshp-line);border-radius:calc(var(--dshp-radius) * var(--dshp-ps));
  padding:calc(10px * var(--dshp-ps));
  box-shadow:0 14px 40px rgba(10,14,30,.26);backdrop-filter:blur(16px) saturate(1.3);
  opacity:0;visibility:hidden;transition:opacity .16s ease,transform .16s ease;
  font-size:calc(12px * var(--dshp-ps))}
/* 面板在缩放被冻结时不能再跟着动，否则拖「大小」滑块的时候轨道会从鼠标底下跑掉 */
.dshp-root.dshp-sizing .dshp-panel{transition:opacity .16s ease}
.dshp-panel.dshp-on{opacity:1;visibility:visible;
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(var(--dshp-shift-y,0px))}
/* 对话输入框：主人要求放置在脚部（避开头部的工作简报与对话气泡） */
.dshp-composer{position:absolute;top:calc(100% + 44px * var(--dshp-ds))!important;bottom:auto!important;left:50%;
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(calc(-4px + var(--dshp-shift-y,0px)));z-index:15}
.dshp-composer.dshp-on{transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(var(--dshp-shift-y,0px))}
.dshp-panel textarea{width:100%;box-sizing:border-box;resize:none;
  height:calc(64px * var(--dshp-ps));font:inherit;
  color:inherit;background:transparent;border:1px solid var(--dshp-line);
  border-radius:calc(9px * var(--dshp-ps));
  padding:calc(7px * var(--dshp-ps)) calc(9px * var(--dshp-ps));outline:none}
.dshp-panel textarea:focus{border-color:var(--dshp-accent)}
.dshp-row{display:flex;gap:6px;align-items:center;margin-top:7px;flex-wrap:wrap}
.dshp-grow{flex:1}
.dshp-tabs{display:flex;flex-wrap:wrap;gap:3px 4px;margin-bottom:7px;border-bottom:1px solid var(--dshp-line);padding-bottom:6px}
.dshp-map-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;background:rgba(0,0,0,.15);padding:4px 6px;border-radius:6px}
.dshp-map-row select{flex:1 1 0%!important;min-width:0!important;width:0!important;max-width:100%!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}
.dshp-map-row button{flex-shrink:0!important;white-space:nowrap!important}
.dshp-tab-btn{border:none;background:transparent;color:inherit;opacity:.6;font:inherit;font-size:11.5px;
  padding:3px 9px;border-radius:7px;cursor:pointer}
.dshp-tab-btn.dshp-active{opacity:1;background:rgba(124,92,255,.14);color:var(--dshp-accent);font-weight:600}
.dshp-grid{display:flex;flex-wrap:wrap;gap:5px;max-height:210px;overflow:auto;overscroll-behavior:contain}
.dshp-chip{border:1px solid var(--dshp-line);background:transparent;color:inherit;font:inherit;
  font-size:calc(11.5px * var(--dshp-ps));border-radius:calc(8px * var(--dshp-ps));
  padding:calc(3px * var(--dshp-ps)) calc(9px * var(--dshp-ps));cursor:pointer;transition:background .12s}
.dshp-chip:hover{background:rgba(124,92,255,.12)}
.dshp-chip.dshp-on{background:var(--dshp-accent);color:#fff;border-color:transparent}
.dshp-chip.dshp-dead{opacity:.38;cursor:not-allowed}
.dshp-now{opacity:.75;margin:0 0 8px;padding:5px 8px;border-radius:8px;
  background:rgba(124,92,255,.09);white-space:normal}
.dshp-hint{opacity:.5;font-size:calc(10.5px * var(--dshp-ps));margin-top:calc(6px * var(--dshp-ps));line-height:1.5;white-space:pre-wrap}
.dshp-label{display:flex;align-items:center;gap:7px;margin:6px 0;font-size:11.5px}
.dshp-label input[type=range]{flex:1;accent-color:var(--dshp-accent)}
/* ——— HUD：右键弹出的「余额 / 本轮消耗 / 峰谷计价」面板 ———
   主人要求：右键不再是设置菜单，而是这个框；信息要醒目、要盖在最上层、
   又要能自己收起来（不然挡住对话）。所以它是独立一层，z-index 比菜单还高。 */
.dshp-hud{position:absolute;left:50%;bottom:calc(100% + 10px * var(--dshp-ps));
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(8px);
  width:min(calc(292px * var(--dshp-ps)),86vw);pointer-events:auto;z-index:9;
  background:var(--dshp-bg);color:var(--dshp-fg);
  border:1px solid var(--dshp-line);border-radius:calc(var(--dshp-radius) * var(--dshp-ps));
  padding:calc(13px * var(--dshp-ps)) calc(14px * var(--dshp-ps)) calc(10px * var(--dshp-ps));
  box-shadow:0 20px 54px rgba(10,14,30,.34);backdrop-filter:blur(18px) saturate(1.4);
  opacity:0;visibility:hidden;
  transition:opacity .18s ease,transform .18s cubic-bezier(.2,.9,.3,1);
  font-size:calc(12px * var(--dshp-ps))}
.dshp-hud.dshp-on{opacity:1;visibility:visible;
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(0)}
/* 刚弹出来那一下给一圈呼吸光，提醒「看这里」——冒烟效果用 box-shadow，不动 transform */
.dshp-hud.dshp-flash{animation:dshp-hud-flash 1.15s ease-out 2}
@keyframes dshp-hud-flash{
  0%{box-shadow:0 20px 54px rgba(10,14,30,.34),0 0 0 0 rgba(124,92,255,.5)}
  70%{box-shadow:0 20px 54px rgba(10,14,30,.34),0 0 0 14px rgba(124,92,255,0)}
  100%{box-shadow:0 20px 54px rgba(10,14,30,.34),0 0 0 0 rgba(124,92,255,0)}}
.dshp-hud-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:calc(11px * var(--dshp-ps));opacity:.6;letter-spacing:.3px;
  padding-right:calc(20px * var(--dshp-ps))}
.dshp-hud-money{display:flex;align-items:baseline;gap:6px;margin:calc(4px * var(--dshp-ps)) 0 calc(2px * var(--dshp-ps))}
.dshp-hud-money b{font-size:calc(30px * var(--dshp-ps));font-weight:850;letter-spacing:-1px;
  line-height:1.1;font-variant-numeric:tabular-nums}
.dshp-hud-money span{font-size:calc(12px * var(--dshp-ps));opacity:.55}
.dshp-hud-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  padding:calc(3px * var(--dshp-ps)) 0}
.dshp-hud-k{opacity:.6;font-size:calc(11px * var(--dshp-ps));white-space:nowrap}
.dshp-hud-v{font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.dshp-hud-sep{height:1px;background:var(--dshp-line);margin:calc(6px * var(--dshp-ps)) 0}
/* 峰 = 红，谷 = 绿（主人明确要求的配色） */
.dshp-hud-tag{display:inline-flex;align-items:center;gap:5px;border-radius:999px;
  padding:calc(2px * var(--dshp-ps)) calc(9px * var(--dshp-ps));
  font-weight:850;font-size:calc(11px * var(--dshp-ps));white-space:nowrap}
.dshp-hud-tag.dshp-peak{background:rgba(232,45,74,.15);color:#d81e3f;border:1px solid rgba(216,30,63,.38)}
.dshp-hud-tag.dshp-valley{background:rgba(16,185,129,.16);color:#0a8f63;border:1px solid rgba(10,143,99,.38)}
.dshp-hud-foot{opacity:.45;font-size:calc(10px * var(--dshp-ps));line-height:1.55;
  margin-top:calc(7px * var(--dshp-ps));white-space:pre-wrap}
@media (prefers-color-scheme:dark){
  .dshp-hud-tag.dshp-peak{background:rgba(255,86,110,.2);color:#ff8a9c;border-color:rgba(255,138,156,.4)}
  .dshp-hud-tag.dshp-valley{background:rgba(52,211,153,.18);color:#6ee7b7;border-color:rgba(110,231,183,.4)}}
.dshp-tab{position:fixed;right:16px;bottom:16px;z-index:2147483002;pointer-events:auto;cursor:pointer;
  border:1px solid var(--dshp-line);background:var(--dshp-bg);color:var(--dshp-fg);
  border-radius:20px;padding:6px 13px;font-size:12px;font-weight:600;
  box-shadow:0 6px 18px rgba(10,14,30,.28);transition:transform .12s ease;
  display:none;align-items:center;gap:6px;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.dshp-detached-pill{position:fixed;right:16px;bottom:16px;z-index:2147483002;pointer-events:auto;cursor:pointer;
  border:1px solid rgba(123,155,255,.38);background:rgba(18,26,48,.92);color:#eaf0ff;
  border-radius:20px;padding:7px 14px;font-size:12px;font-weight:600;
  box-shadow:0 6px 18px rgba(10,14,30,.32);transition:transform .12s ease,background .15s ease;
  display:none;align-items:center;gap:6px;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.dshp-detached-pill:hover{transform:translateY(-1px);background:rgba(36,52,96,.96)}
`

  // ——————————————————————————————————————————————————————————————
  // 三、小工具
  // ——————————————————————————————————————————————————————————————

  const $ = (tag, cls, text) => {
    const el = document.createElement(tag)
    if (cls) el.className = cls
    if (text != null) el.textContent = text
    return el
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.async = false
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('无法加载 ' + src))
      document.head.appendChild(s)
    })
  }

  function readLayout() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}
    } catch (e) {
      return {}
    }
  }
  function saveLayout(patch) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(readLayout(), patch)))
    } catch (e) {}
  }

  // ——————————————————————————————————————————————————————————————
  // 四、状态
  // ——————————————————————————————————————————————————————————————

  let app = null
  let model = null
  let manifest = null
  let coreModel = null
  let ui = null

  /** 表情名 → 参数增量表（已过滤掉模型里不存在的参数） */
  const EXPR = {}
  /** 鲸鱼娘基准黄金标准快照（不可更改） */
  const BASE_WHALE_EXPR = {}
  const BASE_WHALE_MOOD_FACE = {}
  /** 当前非鲸鱼娘角色的已扫描可用资源（表情与动作列表） */
  let currentCharacterAssets = { characterId: null, expressions: [], motions: [], categories: { decor: [], scene: [], action: [], emotion: [] } }
  /** 最近一次取景结果，供诊断用 */
  let lastView = null
  /** 角色实体在模型画布里的归一化范围，启动时测一次；null = 没测出来（退回整张画布） */
  let contentBox = null
  /** 模型真实存在的参数 id 集合 */
  let MODEL_PARAMS = new Set()
  /** 被过滤掉的参数，启动时打一条日志，方便排查 */
  const droppedParams = new Set()

  /**
   * 状态模型（这一版的核心）。
   *
   * 之前最大的问题是「特效会卡住」：摸头/工具/完成每次都 setMood 一下，那张脸就一直
   * 挂在那儿，等下一个事件来覆盖——叠几次之后就永远停在错的状态上，很多表情也再也
   * 用不出来。根因是「谁都没有责任去清理」。
   *
   * 现在拆成三层，各自职责单一，谁都不会赖着不走：
   *
   *   base      由 agent 状态决定（待机/思考/干活/出错…），是「此刻本该是什么样」
   *   override  一次性反应（摸头、点击、特效、工具瞬时反馈）——**强制带时限**，到期自动消失
   *   user      主人手动选的脸/道具，也带时限；真实事件可以立刻夺回
   *
   * 每帧解析：face = override（未过期）> user（未过期）> base。
   * 「特效做完回不去」在结构上就不会发生——没有任何一处需要「记得清理」。
   */
  const rig = {
    /** 当前真实生效的脸（表达式名或 null） */
    face: null,
    /** 当前真实生效的道具集合（表达式名） */
    props: new Set(),
    weight: new Map(),
    talking: false,
    talkPhase: 0,
    /** 底层状态：由 agent 状态机维护 */
    base: { mood: 'neutral', face: null, props: [] },
    /** 一次性反应，一定带 until */
    override: null,
    /** 主人手动的（带时限） */
    user: { face: null, until: 0 },
    /** 主人自己戴的粘性道具（不限期，他自己摘） */
    userProps: new Set(),
    /** 一次性的参数脉冲（爱心粒子之类），到期自动停 */
    burst: null,
  }
  let mood = 'neutral'

  /** 情绪名 → 表达式名（不在 EXPR 里的会被过滤掉） */
  function moodFace(name) {
    if (name == null) return null
    const f = MOOD_FACE[name] !== undefined ? MOOD_FACE[name] : name
    return f && f in EXPR ? f : null
  }
  /** 道具 key 或表达式名 → 表达式名 */
  function propExpr(key) {
    if (!key) return null
    const e = ALL_TOGGLES[key] ? ALL_TOGGLES[key].expr : key
    return e && EXPR[e] ? e : null
  }

  /** 把三层解析成「这一刻真正该显示什么」。改动状态后调用，或者每帧调用（很便宜）。 */
  function resolveRig() {
    const now = performance.now()
    if (rig.override && now >= rig.override.until) rig.override = null
    if (rig.user.face && now >= rig.user.until) rig.user.face = null

    const ov = rig.override
    const face = ov && ov.face !== undefined ? ov.face : rig.user.face || rig.base.face || null
    rig.face = face && face in EXPR ? face : null

    const props = new Set()
    for (const p of rig.userProps) props.add(p) // 主人自己戴的装饰品一直都在
    if (!ov || !ov.exclusive) for (const p of rig.base.props) props.add(p)
    if (ov) for (const p of ov.props) props.add(p)
    rig.props = props
    mood = (ov && ov.mood) || rig.base.mood || 'neutral'
  }

  /**
   * 设置底层状态。agent 状态机用它：待机 / 思考 / 干活 / 出错 / 完成…
   * @param name 情绪名
   * @param propKeys 该状态下常驻的道具（道具 key 或表达式名）
   */
  function setBase(name, propKeys) {
    rig.base = {
      mood: name || 'neutral',
      face: moodFace(name),
      props: (propKeys || []).map(propExpr).filter(Boolean),
    }
    resolveRig()
  }

  /**
   * 一次性反应。**一定会过期**——这是「特效不卡住」的保证。
   * 新的反应会直接顶掉旧的（主人说的「任何下一层东西覆盖前一个」）。
   */
  function setReaction(opts) {
    opts = opts || {}
    // mood 和 face 都没给 = 只临时加道具，不动脸
    const face =
      opts.face !== undefined ? opts.face : opts.mood !== undefined ? moodFace(opts.mood) : undefined
    rig.override = {
      mood: opts.mood || null,
      face: face === undefined ? undefined : face,
      props: (opts.props || []).map(propExpr).filter(Boolean),
      // exclusive：连「常态道具」（本子/笔）也暂时放下——主人要的是「砸的时候就只砸一下」
      exclusive: opts.exclusive === true,
      until: performance.now() + (opts.ms || 3200),
    }
    resolveRig()
  }

  /** 立刻撤掉一次性反应，回到 base（切模式、下一层事件来时用）。 */
  function clearReaction() {
    if (!rig.override) return
    rig.override = null
    resolveRig()
  }

  /** 主人手动选的脸，30 秒；期间待机不会抢，但真实事件会。 */
  function setUserFace(name) {
    rig.user = { face: moodFace(name), until: performance.now() + 30000 }
    resolveRig()
  }

  /** 主人手动选「平常」= 立刻交还给她自己。 */
  function clearUserFace() {
    rig.user = { face: null, until: 0 }
    clearReaction()
  }

  /**
   * 某一件「摆设/装饰」现在是开着的吗？
   * 手机是个例外——它不是一个表情参数，而是 `device.out`（模型自带的
   * 开盖动作把小设备掏出来），所以单独判。
   */
  function itemOn(key, def) {
    const d = def || ALL_TOGGLES[key]
    if (!d) return false
    if (d.device) return device.out
    return !!d.expr && rig.userProps.has(d.expr)
  }

  /** 把小设备（手机）掏出来——这就是原作者「自拍手机」那个动作。 */
  function takeDeviceOut() {
    if (device.out) return
    device.out = true
    playMotion('openLid')
  }

  function setProp(key, on) {
    const def = ALL_TOGGLES[key]
    // 手机：走模型自带的开盖动作，不走表情参数
    if (def && def.device) {
      if (on) takeDeviceOut()
      else putDeviceAway()
      // 手机收起来时，它的换色也该跟着走
      if (!on) {
        for (const [k, v] of Object.entries(ALL_TOGGLES)) {
          if (v.needs === key && v.expr) rig.userProps.delete(v.expr)
        }
      }
      resolveRig()
      saveLayout({ props: Array.from(rig.userProps) })
      return
    }
    const expr = propExpr(key)
    if (!expr) return
    if (on) {
      if (def && def.group) {
        for (const [k, v] of Object.entries(ALL_TOGGLES)) {
          if (v.group === def.group && k !== key && v.expr) rig.userProps.delete(v.expr)
        }
      }
      // 前置依赖。两种：
      //   · 参数型（白魔爪 → 粉魔爪）：直接把前置的表情加上
      //   · 设备型（手机换色 → 掏出手机）：把手机掏出来
      // 这都是原作者的设计（*+5「魔爪变白」必须在粉魔爪模式下用）。
      if (def && def.needs) {
        const needDef = ALL_TOGGLES[def.needs]
        if (needDef && needDef.device) takeDeviceOut()
        else {
          const needExpr = propExpr(def.needs)
          if (needExpr) rig.userProps.add(needExpr)
        }
      }
      // 反过来：开「粉魔爪」要把换色摘掉，不然还是白的
      if (def && def.clears) {
        for (const k of def.clears) {
          const e2 = propExpr(k)
          if (e2) rig.userProps.delete(e2)
        }
      }
      rig.userProps.add(expr)
    } else {
      rig.userProps.delete(expr)
      // 摘掉「魔爪」时，它的换色也该跟着走，不然会留下一层颜色
      for (const [k, v] of Object.entries(ALL_TOGGLES)) {
        if (v.needs === key && v.expr) rig.userProps.delete(v.expr)
      }
    }
    resolveRig()
    saveLayout({ props: Array.from(rig.userProps) })
  }

  function clearProps() {
    rig.userProps.clear()
    resolveRig()
    saveLayout({ props: [] })
    if (activeCharacterId === 'tutu' && coreModel) {
      try {
        coreModel.setParameterValueById('Param122', 0.0)
        coreModel.setParameterValueById('Param123', 1.0)
      } catch (e) {}
    }
    resumeCharacterIdleMotion()
  }

  function restoreProps() {
    const saved = readLayout().props
    if (!Array.isArray(saved)) return
    for (const expr of saved) {
      if (expr && (expr.includes('飞头') || expr === 'Param122')) continue
      if (EXPR[expr]) rig.userProps.add(expr)
    }
    resolveRig()
  }

  /** 当前参与施加的表达式集合（含正在淡出的）。过期与否已由 resolveRig 决定。 */
  function currentExpressions() {
    const out = new Set()
    if (rig.face) out.add(rig.face)
    for (const name of rig.props) out.add(name)
    for (const name of rig.weight.keys()) out.add(name)
    return out
  }

  /**
   * rig 本体：挂在 beforeModelUpdate 上。
   * 每帧先 resolveRig() 把三层解析成「这一刻该显示什么」——
   * 所以一次性反应一过期，对应的参数立刻进入淡出，不需要任何人来清理。
   */
  function applyRig() {
    if (!coreModel) return
    resolveRig()
    const now = performance.now()
    const dt = Math.min(64, now - (applyRig._last || now)) / 1000
    applyRig._last = now

    // 物理弹簧阻尼与动态捏脸缩放 (SpringPhysicsController)
    if (springPhysics) {
      springPhysics.step(dt)
      const s = springPhysics.getScale(0.12, 0.6)
      const facing = (desktopRoamEngine && desktopRoamEngine.facing) || 1
      if (ui && ui.stage) {
        ui.stage.style.transform = `scale(${facing * s.sx}, ${s.sy})`
        ui.stage.style.transformOrigin = '50% 100%'
      }
    }

    const targets = new Map()
    if (rig.face) targets.set(rig.face, 1)
    for (const name of rig.props) targets.set(name, 1)

    // 权重推进：进得慢一点、退得快一点，观感更像「变脸」而不是硬切
    for (const name of Array.from(rig.weight.keys())) {
      const target = targets.get(name) || 0
      let w = rig.weight.get(name) || 0
      const speed = target > w ? 7 : 11
      w += (target - w) * clamp(dt * speed, 0, 1)
      if (target === 0 && w < 0.02) rig.weight.delete(name)
      else rig.weight.set(name, w)
    }
    for (const name of targets.keys()) {
      if (!rig.weight.has(name)) rig.weight.set(name, 0)
    }

    // —— 参数独占 ——
    // 主人要求「每次脸上只能有一个表情，不能两个表情叠在一起」。
    // 光靠「一个 face + 若干道具」还不够：有些道具本身也写脸部参数
    // （比如墨镜会写 ParamEyeLOpen），叠上去就会打架。
    // 所以这里做一个裁决：每个参数在同一时刻只允许**一个**表达式写，
    // 优先级 脸 > 道具（按加入顺序）。
    const delta = new Map()
    const claimed = new Set()
    let skipped = 0
    const add = (id, v) => delta.set(id, (delta.get(id) || 0) + v)
    const winners = []
    if (rig.face && (rig.weight.get(rig.face) || 0) > 0) winners.push(rig.face)
    for (const name of rig.props) if (name !== rig.face && (rig.weight.get(name) || 0) > 0) winners.push(name)
    for (const name of winners) {
      const w = rig.weight.get(name) || 0
      const params = EXPR[name]
      if (!params) continue
      for (const p of params) {
        if (claimed.has(p.id)) {
          skipped++ // 这个参数已经被更高优先级的表情写了
          continue
        }
        claimed.add(p.id)
        add(p.id, p.value * w)
      }
    }
    // 正在淡出的表情不参与裁决，权重照常推进（它们本来就没抢到参数）
    for (const name of rig.weight.keys()) {
      if (winners.indexOf(name) >= 0) continue
      const w = rig.weight.get(name) || 0
      const params = EXPR[name]
      if (!params || w <= 0) continue
      for (const p of params) {
        if (claimed.has(p.id)) continue
        claimed.add(p.id)
        add(p.id, p.value * w)
      }
    }

    // 说话口型：基于真实语音多频共鸣特征的仿生下颌连续形变与唇形联动
    if (CFG.talkMouth && (isSpeakingAudio || rig.talking)) {
      if (frameRateGovernor) frameRateGovernor.touch()
      const mouth = sampleAudioMouth(dt)
      // 连续多级平滑写入 ParamMouthOpenY，彻底消除 0 或 1 二值跳变
      delta.set('ParamMouthOpenY', mouth.open)
      if (!claimed.has('ParamMouthForm')) {
        delta.set('ParamMouthForm', mouth.form)
      }
      if (activeCharacterId === 'tutu') {
        delta.set('ParamMouthOpenY2', mouth.open * 0.55)
        delta.set('ParamMouthOpenY3', mouth.open * 0.35)
      } else if (activeCharacterId === 'yuyu') {
        delta.set('ParamMouthOpenY5', mouth.open * 0.6)
        delta.set('ParamMouthOpenY8', mouth.open * 0.5)
      }
    } else {
      audioCurrentVolume = 0
      audioCurrentForm = 0
    }

    // 一次性参数脉冲（爱心粒子 / 心跳），到期自动停
    if (rig.burst) {
      if (performance.now() > rig.burst.until) rig.burst = null
      else {
        if (rig.burst.love) add('love', rig.burst.love)
        if (rig.burst.heartbeat) add('ParamCheek73', rig.burst.heartbeat)
      }
    }

    // —— 眨眼（自然节奏，见 blinkTick）——
    blinkTick(now, claimed.has('ParamEyeLOpen') || claimed.has('ParamEyeROpen'), motionActive())

    // —— 眼睛自愈 ——
    // 万一还有哪条路径把「睁眼」参数冻在 0（闭眼），这里把它纠回来。
    // 只在「没有动作在播 + 我们自己的表情/道具都没认领眼睛参数 + 已经闭了 1.5 秒以上」时才动手，
    // 所以不会跟眨眼（一次 0.1 秒）、也不会跟「闭眼口水」这种真的闭眼表情打架。
    if (coreModel && model && !rig.eyesHeal) rig.eyesHeal = { since: 0, warned: false }
    if (rig.eyesHeal) {
      const eL = 'ParamEyeLOpen'
      const eR = 'ParamEyeROpen'
      const claimedEye = claimed.has(eL) || claimed.has(eR)
      const motionOn = motionActive()
      const v = eyesOpen()
      if (!claimedEye && !motionOn && v !== null && v < 0.25) {
        if (!rig.eyesHeal.since) rig.eyesHeal.since = now
        else if (now - rig.eyesHeal.since > 1500) {
          for (const id of [eL, eR]) {
            const d = paramDefault(id)
            if (d !== null) {
              try {
                coreModel.setParameterValueById(id, d)
              } catch (e) {}
            }
          }
          try {
            coreModel.saveParameters()
          } catch (e) {}
          rig.eyesHeal.since = 0
          if (!rig.eyesHeal.warned) {
            rig.eyesHeal.warned = true
            log('检测到眼睛被冻住，已按默认值纠回（自愈）')
          }
        }
      } else {
        rig.eyesHeal.since = 0
      }
    }

    // 诊断：这一帧有多少次「因为参数已被占用而放弃写入」。
    // 它 > 0 就说明独占裁决真的在起作用（两个表情想写同一个参数时被打回）。
    rig.exclusive = { written: delta.size, skipped, writers: winners }

    if (!applyRig._appliedParams) applyRig._appliedParams = new Set()

    if (activeCharacterId === 'whale') {
      for (const [id, v] of delta) {
        if (Math.abs(v) < 0.001) continue
        try {
          coreModel.addParameterValueById(id, v)
        } catch (e) {}
      }
    } else {
      // 非鲸鱼娘角色（如兔兔、玉玉等）：
      // 1. 复位上一帧曾写入过、但本帧已淡出归零的参数，防止参数冻结累积
      for (const id of applyRig._appliedParams) {
        if (!delta.has(id)) {
          const def = (activeCharacterId === 'tutu' && id === 'Param123') ? 1.0 : (paramDefault(id) ?? 0)
          try {
            coreModel.setParameterValueById(id, def)
          } catch (e) {}
        }
      }
      applyRig._appliedParams.clear()

      // 2. 写入当前帧的绝对计算值 (default + delta)
      for (const [id, v] of delta) {
        const def = (activeCharacterId === 'tutu' && id === 'Param123') ? 1.0 : (paramDefault(id) ?? 0)
        if (Math.abs(v) < 0.001) {
          try {
            coreModel.setParameterValueById(id, def)
          } catch (e) {}
          continue
        }
        applyRig._appliedParams.add(id)
        try {
          coreModel.setParameterValueById(id, def + v)
        } catch (e) {}
      }
    }

    // 强保特殊角色常驻参数（例如兔兔的去水印/模型显示 Param123）
    try {
      const curChar = CHARACTERS[activeCharacterId]
      if (curChar && curChar.defaultParams) {
        for (const [pId, pVal] of Object.entries(curChar.defaultParams)) {
          coreModel.setParameterValueById(pId, pVal)
        }
      }
      if (activeCharacterId === 'tutu') {
        coreModel.setParameterValueById('Param123', 1.0)
        // 关键防御：若当前没有在表演飞头（Param122），强保 Param122 恢复为 0.0，本体完整显现！
        if (!delta.has('Param122') || Math.abs(delta.get('Param122')) < 0.001) {
          coreModel.setParameterValueById('Param122', 0.0)
        }
      }
    } catch (e) {}
  }

  /**
   * 任何路径都不许再播的动作。
   *   bubble   —— 主人点名踢掉（老会卡住）
   *   aidale   —— 「伸展」，内部驱动 15 个表情参数，一播就多个表情同时亮
   *   selfie*  —— 同上，自带 10 个表情参数
   */
  const FACE_DRIVING_MOTIONS = new Set(['bubble', 'aidale', 'selfie', 'selfieQuick'])
  const BANNED_MOTIONS = FACE_DRIVING_MOTIONS

  /**
   * 动作是否正在播。
   * 不用框架的 `motionManager.isFinished()` —— 实测它空闲时也返回「没结束」，
   * 会让「动作期间不眨眼」永远成立（之前眨眼就是这么被憋住的）。
   * 改成我们自己记账：起动作时按清单里的时长记一个截止时间。
   */
  let motionUntil = 0
  function motionActive() {
    return performance.now() < motionUntil
  }

  function playMotion(group, priority) {
    if (!model || !manifest) return
    if (BANNED_MOTIONS.has(group)) return
    if (!manifest.motions || !manifest.motions[group]) {
      log('没有这个动作：', group)
      return
    }
    const dur = Number(manifest.motions[group].duration) || 1.5
    motionUntil = performance.now() + dur * 1000 + 120
    try {
      // 第三参是优先级（数字）：FORCE 才能盖过常驻待机循环
      model.motion(group, 0, priority == null ? MOTION_PRIORITY.FORCE : priority)
    } catch (e) {
      console.warn('[鲸鱼娘] 动作播放失败', group, e)
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 四·五、表演调度器（所有「一次性反应」的唯一入口）
  // ——————————————————————————————————————————————————————————————

  /** 当前正在进行的「一次性表演」。任何时刻最多一个。 */
  let acting = null
  let motionTimer = null

  /**
   * 停掉当前表演：取消一次性表情、爱心脉冲、一次性动作，
   * 回到「底层状态 + 常驻待机动作」——主人说的「先变回平常状态」。
   */
  function stopActing() {
    acting = null
    if (motionTimer) {
      clearTimeout(motionTimer)
      motionTimer = null
    }
    rig.override = null
    rig.burst = null
    resolveRig()
    // 把所有动作停掉，回到模型的**默认姿势**（配合物理/呼吸/眨眼就是「正常坐姿」）。
    //
    // 这里**不再播 motions/idle.motion3.json**：那套资产里的 "idle" 其实是
    // 猫爪摆动 + 爱心粒子的循环动画（89 条曲线里 maoshou*/j* 就是它们），
    // 一直循环会让人看到「手在这摆」和「一长串莫名的待机动作」。
    //
    // 例外：干活时如果小设备已经掏出来了（查资料），别把它收掉——
    // 互动只是插一下，互动完要回到「正在查资料」的样子。
    if (!device.out) stopMotion()
    if (activeCharacterId !== 'whale') {
      resumeCharacterIdleMotion()
    }
  }

  /**
   * 把所有「动作会写的参数」复位到模型默认值，并重存一次框架的参数快照。
   *
   * 为什么必须手动做（踩了很久才查明白）：pixi-live2d-display 每帧的顺序是
   *     动作写入 → saveParameters() 存快照 → 眨眼/视线/呼吸/物理 → beforeModelUpdate(我们的 rig)
   *     → coreModel.update() → loadParameters() 把快照装回来
   * 也就是说**快照是在动作写入之后存的**。动作一旦停下，快照里留的就是它最后一帧的姿势，
   * 而 loadParameters() 每帧都会把这份姿势装回来 —— 表现就是主人报的
   * 「蛋包饭点过以后永远挂在桌上、手机收不回去、表情也回不去，连一键重置都没用」。
   * 所以停动作时要做两件事：① 把这些参数设回默认值 ② 重新 save 一次，把快照换成默认姿势。
   */
  function clearMotionPose() {
    if (!coreModel) return 0
    const ids = new Set()
    if (manifest && manifest.motions) {
      for (const meta of Object.values(manifest.motions || {})) {
        for (const id of meta.params || []) ids.add(id)
      }
    }
    if (currentCharacterAssets && Array.isArray(currentCharacterAssets.expressions)) {
      for (const exp of currentCharacterAssets.expressions) {
        for (const p of exp.params || []) ids.add(p.id)
      }
    }
    let n = 0
    let bad = 0
    for (const id of ids) {
      try {
        let def = paramDefault(id)
        if (activeCharacterId === 'tutu' && id === 'Param123') def = 1.0
        if (activeCharacterId === 'tutu' && id === 'Param122') def = 0.0
        // 取不到默认值的参数一律**不要碰**！之前就是在这里把「睁眼」参数当成了 0，
        // 结果把眼睛永久设成闭着的（主人报的「一直闭着眼，啥也干不了」）。
        if (def === null) { bad++; continue }
        if (typeof coreModel.setParameterValueById === 'function') coreModel.setParameterValueById(id, def)
        n++
      } catch (e) {}
    }
    if (activeCharacterId === 'tutu') {
      try {
        coreModel.setParameterValueById('Param123', 1.0)
        coreModel.setParameterValueById('Param122', 0.0)
      } catch (e) {}
    }
    if (bad && !clearMotionPose._warned) {
      clearMotionPose._warned = true
      log(`有 ${bad} 个动作参数取不到默认值，已跳过（绝不猜 0）`)
    }
    try {
      if (typeof coreModel.saveParameters === 'function') coreModel.saveParameters()
    } catch (e) {}
    return n
  }

  /**
   * 眨眼控制器。
   *
   * 主人要求：「不要眨太快、不要眨太慢，符合正常人眨眼速度，偶尔眨一眨」。
   * 人类大概是每 3~5 秒眨一次，单次 0.1~0.2 秒，偶尔会连眨两下。
   * 框架自带的实现是「下次眨眼 = random × 7 秒」，范围太野，所以这里自己来：
   *   · 间隔：2.6~5.4 秒随机；15% 概率紧接着再眨一下（连眨）
   *   · 单次时长：闭合 60ms + 闭合保持 30ms + 睁开 100ms ≈ 0.19 秒
   *   · 动作在播、或者有表情/道具正在写眼睛参数（比如「闭眼口水」）时**不眨**
   */
  const blink = { nextAt: 0, phase: 'idle', t0: 0, queue: 0, gate: '', count: 0 }

  function blinkTick(now, eyeClaimed, motionOn) {
    if (!coreModel) { blink.gate = 'no-model'; return }
    if (eyeClaimed || motionOn) {
      blink.gate = eyeClaimed ? 'eye-claimed' : 'motion-on'
      blink.phase = 'idle'
      blink.nextAt = now + 1200
      return
    }
    blink.gate = 'ok'
    const set = (v) => {
      try {
        coreModel.setParameterValueById('ParamEyeLOpen', v)
        coreModel.setParameterValueById('ParamEyeROpen', v)
      } catch (e) {}
    }
    const CLOSE = 60
    const HOLD = 30
    const OPEN = 100
    if (blink.phase === 'idle') {
      if (!blink.nextAt) blink.nextAt = now + 900 + Math.random() * 2600
      if (now >= blink.nextAt) {
        blink.phase = 'closing'
        blink.t0 = now
        blink.count++
        blink.queue = Math.random() < 0.15 ? 1 : 0 // 偶尔连眨两下
      } else {
        return
      }
    }
    const dt = now - blink.t0
    if (blink.phase === 'closing') {
      set(1 - Math.min(1, dt / CLOSE))
      if (dt >= CLOSE) {
        blink.phase = 'closed'
        blink.t0 = now
      }
    } else if (blink.phase === 'closed') {
      set(0)
      if (dt >= HOLD) {
        blink.phase = 'opening'
        blink.t0 = now
      }
    } else if (blink.phase === 'opening') {
      set(Math.min(1, dt / OPEN))
      if (dt >= OPEN) {
        blink.phase = 'idle'
        if (blink.queue > 0) {
          blink.queue = 0
          blink.nextAt = now + 180 // 连眨：紧接着再来一下
        } else {
          blink.nextAt = now + 2600 + Math.random() * 2800
        }
      }
    }
  }

  /**
   * 取某个参数的默认值。**框架的 getParameterDefaultValue 收的是「下标」不是 id**，
   * 传 id 会拿到 undefined —— 若拿不到就返回 null，调用方必须跳过这个参数，
   * 绝不能拿 0 当默认值（会把「睁眼」写成「闭眼」，就是那次事故）。
   */
  function paramDefault(id) {
    if (!coreModel) return null
    try {
      const idx = typeof coreModel.getParameterIndex === 'function' ? coreModel.getParameterIndex(id) : -1
      if (typeof idx !== 'number' || idx < 0) return null
      if (typeof coreModel.getParameterDefaultValue !== 'function') return null
      const d = coreModel.getParameterDefaultValue(idx)
      if (typeof d !== 'number' || !Number.isFinite(d)) return null
      return d
    } catch (e) {
      return null
    }
  }

  function paramValue(id) {
    if (!coreModel) return null
    try {
      const v = coreModel.getParameterValueById(id)
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch (e) {
      return null
    }
  }

  /** 眼睛当前睁着没：0 = 闭，1 = 睁（返回两只眼的平均值，方便诊断与自愈） */
  function eyesOpen() {
    const l = paramValue('ParamEyeLOpen')
    const r = paramValue('ParamEyeROpen')
    if (l === null && r === null) return null
    const vals = [l, r].filter((v) => v !== null)
    return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)
  }

  /** 停掉所有正在播的动作，让模型回到默认姿势。 */
  function stopMotion() {
    motionUntil = 0
    try {
      const mm = model && model.internalModel && model.internalModel.motionManager
      if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions()
    } catch (e) {}
    // 光停动作不够：还得把「动作留下的姿势」从参数快照里清掉，否则它会永远挂着
    clearMotionPose()
  }

  /** 一次性动作：到点自己回到常驻待机（动作也是一次只能一个）。 */
  function playOneShot(group) {
    if (!manifest || !manifest.motions || !manifest.motions[group]) return
    const durS = Number(manifest.motions[group].duration) || 2
    stopMotion() // 先清干净，再起新的——动作永远只有一个
    playMotion(group, MOTION_PRIORITY.FORCE)
    if (motionTimer) clearTimeout(motionTimer)
    // 到点一定收掉——不管模型里那个动作自己是不是 Loop=true。
    // （aidale / idle 这些资产内部写着循环，不主动停就会一直播下去。）
    motionTimer = setTimeout(() => {
      motionTimer = null
      if (!device.out) stopMotion()
    }, Math.round(durS * 1000) + 150)
  }

  /**
   * 起一次表演。**所有一次性反应都必须走这里，没有例外。**
   *
   * 铁律（主人反复强调的）：
   *   1. 先把上一次整个停掉、回到平常状态，**再**开始新的 —— 所以永远不会重叠
   *   2. 一次表演 = 一个面部表情 + 至多一个动作 + 至多一个粒子特效
   *   3. 待机表演只在真正空闲时才会被调用；有任务时只有任务表演
   *   4. 永久禁用：吹泡泡糖、大锤砸、呆呆眼（见 BANNED_MOTIONS / MOOD_FACE）
   */
  function act(spec) {
    spec = spec || {}
    stopActing() // ← 关键：先归零，再开始
    const ms = spec.ms || 2600
    setReaction({
      mood: spec.mood,
      face: spec.face,
      props: spec.props,
      exclusive: spec.exclusive,
      ms,
    })
    if (spec.line) ui.bubble.show(spec.line, { name: spec.name || activeCharInfo().name, ttl: Math.max(ms, 1800), force: true })
    if (spec.motion) {
      playOneShot(spec.motion)
      // 只有**真的做动作**时才暂时不盯鼠标；单纯换个表情不该把视线也停掉，
      // 否则待机每隔几秒来一次，她大部分时间都不看主人了。
      gazeDetach(Math.max(2200, ms))
    }
    if (spec.heart) heartBurst(ms)
    acting = { until: performance.now() + ms }
    return ms
  }

  function triggerActionByCue(cue) {
    if (!cue || typeof cue !== 'string') return
    const c = cue.toLowerCase()
    if (c.includes('害羞') || c.includes('脸红') || c.includes('耳朵')) {
      act({ mood: 'shy', face: 'shy', heart: true, ms: 2800 })
    } else if (c.includes('得意') || c.includes('开心') || c.includes('庆祝') || c.includes('尾巴')) {
      act({ mood: 'happy', face: 'happy', ms: 2800 })
    } else if (c.includes('生气') || c.includes('气鼓鼓') || c.includes('跺脚')) {
      act({ mood: 'angry', face: 'angry', ms: 2600 })
    } else if (c.includes('困') || c.includes('哈欠') || c.includes('揉眼睛')) {
      act({ mood: 'sleepy', face: 'sleepy', ms: 3000 })
    } else if (c.includes('转') || c.includes('舞') || c.includes('裙摆')) {
      act({ mood: 'excited', face: 'excited', ms: 3000 })
    } else if (c.includes('温水') || c.includes('红茶') || c.includes('葡萄') || c.includes('茶')) {
      act({ mood: 'reading', face: 'neutral', ms: 2600 })
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 五、启动
  // ——————————————————————————————————————————————————————————————

  async function main() {
    // buildUI 以前在 try 外面——它一旦抛异常，整页会静默什么都不显示，
    // 排查很痛苦。现在整个启动过程都在保护里，并且把错误挂到 window 上。
    try {
      injectStyle()
      ui = buildUI()
      await loadRuntime()
      await loadModules()
      const [man, cdi] = await Promise.all([
        apiFetch(BASE + '/model/manifest.json', { cache: 'no-cache' }).catch(() => ({})),
        apiFetch(BASE + '/model/c_0120.cdi3.json', { cache: 'no-cache' }).catch(() => ({})),
      ])
      manifest = man
      MODEL_PARAMS = new Set((cdi.Parameters || []).map((p) => p.Id))
      for (const [name, e] of Object.entries(manifest.expressions || {})) {
        const kept = []
        for (const p of e.params || []) {
          if (MODEL_PARAMS.has(p.id)) kept.push(p)
          else droppedParams.add(name + ' → ' + p.id)
        }
        if (kept.length) EXPR[name] = kept
      }
      // 永久保存鲸鱼娘黄金标准快照（不可更改）
      for (const k of Object.keys(EXPR)) BASE_WHALE_EXPR[k] = EXPR[k]
      for (const k of Object.keys(MOOD_FACE)) BASE_WHALE_MOOD_FACE[k] = MOOD_FACE[k]

      if (droppedParams.size) {
        log(`已忽略 ${droppedParams.size} 个模型里不存在的参数引用：`, Array.from(droppedParams).join('、'))
      }
      await buildModel()
      wireInteractions()
      connectSSE()
      startLoops()
      log(
        `就绪：${manifest.displayName} · 动作 ${Object.keys(manifest.motions || {}).length} 个 · 可用表情 ${Object.keys(EXPR).length} 个`,
      )
    } catch (err) {
      window.__DSHPetError = String((err && err.stack) || err)
      console.error('[鲸鱼娘] 启动失败：', err)
      try {
        ui = ui || {}
        if (ui.bubble) {
          ui.bubble.show('启动失败：' + (err && err.message ? err.message : err), {
            name: '出错了',
            sticky: true,
          })
        }
      } catch (e) {}
    }
  }

  function injectStyle() {
    if (document.getElementById('dsh-live2d-pet-style')) return
    const s = document.createElement('style')
    s.id = 'dsh-live2d-pet-style'
    s.textContent = PET_CSS
    document.head.appendChild(s)
  }

  async function loadRuntime() {
    if (!window.Live2DCubismCore) await loadScript(BASE + '/vendor/live2dcubismcore.min.js')
    if (!window.PIXI) await loadScript(BASE + '/vendor/pixi.min.js')
    if (!window.PIXI || !window.PIXI.live2d) await loadScript(BASE + '/vendor/cubism4.min.js')
    if (!window.PIXI || !window.PIXI.live2d) throw new Error('Live2D 运行时未就绪')
  }

  /**
   * 性能档。
   *
   * 为什么要有：桌面壳（Mac 原生 App）为了不让她卡住，阻止了 macOS 的 App Nap，
   * 于是**永远满帧渲染** —— 浏览器里标签页不聚焦会自动降频，壳子里不会，
   * 所以主人在壳子里觉得电脑又热又卡。
   *
   * 低性能模式：帧率 20、渲染分辨率 1 倍、去掉自言自语和自主动作，
   * 只留眨眼 + 轻微摆动 + 视线；只有点她才会动。
   */
  const PERF = { low: false }

  function applyPerf() {
    if (app) {
      app.ticker.maxFPS = PERF.low ? 20 : 30
      const want = PERF.low ? 1 : Math.min(window.devicePixelRatio || 1, 1.5)
      try {
        if (app.renderer.resolution !== want) {
          const w = app.renderer.width
          const h = app.renderer.height
          app.renderer.resolution = want
          app.renderer.resize(w, h)
        }
      } catch (err) {}
    }
    try {
      document.body.classList.toggle('dshp-lowpower', PERF.low)
    } catch (err) {}
  }

  /** 壳子/设置页调它切档；返回当前档位方便确认 */
  function setLowPower(on) {
    PERF.low = !!on
    applyPerf()
    log('性能档：' + (PERF.low ? '低性能（少动、省电、20 帧）' : '标准（30 帧）'))
    return PERF.low
  }

  async function buildModel() {
    const layout = readLayout()

    app = new PIXI.Application({
      width: 8,
      height: 8,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      // 掩码要读画布像素，没有 preserveDrawingBuffer 的话读到的是被清空后的缓冲
      preserveDrawingBuffer: true,
      resolution: Math.min(window.devicePixelRatio || 1, PERF.low ? 1 : 1.5),
      powerPreference: 'low-power',
    })
    // 这个模型 30 帧已经足够顺；60 帧纯粹是白烧 CPU/GPU（主人反馈电脑发热、发卡）
    app.ticker.maxFPS = PERF.low ? 20 : 30
    applyPerf()
    ui.stage.appendChild(app.view)

    // 掩码在 postrender 里采：时刻保持注册
    app.renderer.on('postrender', () => {
      if (mask.dirty && !mask.building) buildMask()
    })

    // 动态同步角色清单与配置
    try {
      const json = await apiFetch(BASE + '/characters')
      if (json && json.characters) {
        for (const c of json.characters) {
          const existing = CHARACTERS[c.id] || {}
          const modelUrl = c.modelFile
            ? BASE + '/characters/' + c.id + '/model/' + encodeURIComponent(c.modelFile)
            : (existing.modelUrl || (BASE + '/characters/' + c.id + '/model/' + encodeURIComponent(c.id + '.model3.json')))
          CHARACTERS[c.id] = Object.assign(existing, {
            id: c.id,
            name: c.name || existing.name,
            title: (c.persona && c.persona.title) || c.title || existing.title || c.name,
            modelUrl,
            scale: c.scale || existing.scale || 0.25,
            defaultParams: c.defaultParams || existing.defaultParams || {},
            expressions: c.expressions || existing.expressions || {},
            motions: c.motions || existing.motions || {},
            voice: c.voice || existing.voice || {},
          })
        }
      }
      if (json && json.active && CHARACTERS[json.active]) {
        activeCharacterId = json.active
      }
    } catch (e) {}

    // 根据配置或默认值自动加载对应角色（不再死写鲸鱼娘）
    await loadCharacterModel(activeCharacterId)

    const box = await fitFromMeasurement()
    applyPosition(layout)
    restoreProps()
    // 待机底层状态：平常脸 + 拿板子待着
    setBase('neutral', IDLE_PROPS)

    // 初始化面向对象动力学与漫步系统
    if (SpringPhysicsController && !springPhysics) {
      springPhysics = new SpringPhysicsController(() => PRESS_PROFILE_DEFAULT)
    }
    if (FrameRateGovernor && !frameRateGovernor) {
      frameRateGovernor = new FrameRateGovernor({
        activeFps: 30,
        idleFps: 15,
        idleTimeoutMs: 12000,
        onFpsChange: (fps) => {
          if (app && app.ticker) app.ticker.maxFPS = fps
        },
      })
    }
    if (DesktopRoamEngine && !desktopRoamEngine) {
      const r = ui.root.getBoundingClientRect()
      desktopRoamEngine = new DesktopRoamEngine({
        stageEl: ui.root,
        initialX: r.left || 0,
        initialY: r.top || 0,
        modelGetter: () => model,
        springController: springPhysics,
        getCharacterAssets: () => CHARACTERS[activeCharacterId],
        previewMotion: (file) => previewMotion(file),
        resumeIdle: () => resumeCharacterIdleMotion(),
        onWalkStart: () => reportBoundsToShell(),
        onWalkEnd: () => {
          resumeCharacterIdleMotion()
          reportBoundsToShell()
        },
        onPositionChange: () => reportBoundsToShell(),
      })
      if (model) desktopRoamEngine.baseModelY = model.y
      if (typeof desktopRoamEngine.setRoaming === 'function') {
        desktopRoamEngine.setRoaming(CFG.roamEnabled !== false)
      }
    }

    if (DockAutoHideController && !dockAutoHide && ui.dock) {
      dockAutoHide = new DockAutoHideController(ui.dock, { autoHideMs: 4000 })
    }

    app.ticker.add(() => {
      const dt = Math.min(0.1, (app.ticker.deltaMS || 16.6) / 1000)
      if (frameRateGovernor) frameRateGovernor.update()
      if (desktopRoamEngine) {
        if (typeof desktopRoamEngine.setBlocked === 'function') {
          desktopRoamEngine.setBlocked(isSettingOrInteractionOpen())
        }
        desktopRoamEngine.update(dt)
      }
    })

    document.addEventListener('visibilitychange', () => {
      if (!app) return
      if (document.hidden) app.ticker.stop()
      else app.ticker.start()
    })

    const im = model && model.internalModel
    if (im) {
      log(
        `模型原始尺寸 ${Math.round(im.originalWidth || im.width || 0)}×${Math.round(im.originalHeight || im.height || 0)}` +
          (box ? ` · 布局 ${box.w}×${box.h}（${box.mode}，缩放 ${box.scale}）` : ''),
      )
    }
  }

  /**
   * 正在拖「大小」滑块。为 true 时 fitModel 不去改 --dshp-s/--dshp-ps——
   * 否则轨道会随着面板变宽而移动，变成「怎么拖都追不上」。
   */
  let sizingSize = false

  /**
   * 把面板夹回视口内。
   *
   * 主人抱怨菜单「不太好用」——桌宠默认蹲在右下角，面板又是以模型为中心
   * 左右展开的，于是右边那一截（包括关闭按钮和滑块的右半段）直接跑到屏幕外，
   * 点都点不到。这里量一下真实位置，用一个横向偏移把它推回来。
   */
  /**
   * 面板往哪边展开 —— **纯计算，不「量了再挪」**。
   *
   * 主人报的问题：「弹窗一次往左一次往右，靠墙那次还会卡进墙里一半」。
   * 根因是旧写法：先把位移清零、量面板位置、再据此设位移，而位移本身带过渡动画，
   * 量到动画中间态就会一次算左一次算右，来回翻。
   * 现在只看一件事：桌宠在屏幕的左半边还是右半边 ——
   *   · 在左半边（左边是墙）→ 面板往**右**开
   *   · 在右半边（右边是墙）→ 面板往**左**开
   * 然后兜底夹进视口，保证整个面板（含右上角的 ×）都在屏幕里。
   */
  /**
   * 她脑袋在屏幕上的横坐标。
   * 主人要的是「聊天框放在正头顶」，而桌宠的根节点包含整张书桌场景，
   * 根节点中心 ≠ 脑袋中心，所以这里用测量出来的「头部重心」换算成屏幕坐标。
   */
  function headScreenX() {
    const r = ui.root.getBoundingClientRect()
    try {
      const b = contentBox && contentBox.bands
      const head = b && b.head && b.head.center
      const view = b && b.full && b.full.center
      if (typeof head === 'number' && typeof view === 'number' && lastView && model) {
        const baseW = model.internalModel.width || model.internalModel.originalWidth || 0
        const dx = (head - view) * baseW * (lastView.scale || 0)
        if (Number.isFinite(dx) && Math.abs(dx) < r.width) return r.left + r.width / 2 + dx
      }
    } catch (e) {}
    return r.left + r.width / 2
  }

  function placePanel(panel) {
    if (!panel) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pad = 10
    panel.style.setProperty('--dshp-shift', '0px')
    panel.style.setProperty('--dshp-shift-y', '0px')
    if (!panel.classList.contains('dshp-on')) return

    const r = ui.root.getBoundingClientRect()
    const isMenu = panel.classList.contains('dshp-menu')
    const isComposer = panel.classList.contains('dshp-composer')

    if (isMenu) {
      // 菜单侧边智能动态停靠：靠近左边框在右边，靠近右边框在左边，绝不遮挡头顶互动卡片与对话框
      const charCenterX = r.left + r.width / 2
      const menuWidth = 360
      let shiftX = 0
      let shiftY = 0

      if (charCenterX < vw / 2) {
        panel.classList.add('dshp-dock-right')
        panel.classList.remove('dshp-dock-left')
        const expectedRight = r.right + 14 + menuWidth
        if (expectedRight > vw - pad) {
          shiftX = (vw - pad) - expectedRight
        }
      } else {
        panel.classList.add('dshp-dock-left')
        panel.classList.remove('dshp-dock-right')
        const expectedLeft = r.left - 14 - menuWidth
        if (expectedLeft < pad) {
          shiftX = pad - expectedLeft
        }
      }
      panel.style.setProperty('--dshp-shift', Math.round(shiftX) + 'px')

      // 纵向避障 (居中腰部微调)
      const rect = panel.getBoundingClientRect()
      if (rect.top < pad) {
        shiftY = pad - rect.top
      } else if (rect.bottom > vh - pad) {
        shiftY = (vh - pad) - rect.bottom
      }
      panel.style.setProperty('--dshp-shift-y', Math.round(shiftY) + 'px')
      return
    }

    const rect = panel.getBoundingClientRect()
    const w = rect.width || 0
    if (!w) return
    const anchor = isComposer ? (r.left + r.width / 2) : headScreenX() // 脚部输入框居中对准脚底，头部面板对准头顶
    // 面板基准是「以桌宠中心居中」（left:50% + translateX(-50%)），所以位移 = 锚点 - 根节点中心
    let shift = anchor - (r.left + r.width / 2)
    // 靠墙时往反方向挪，保证整个面板（含 × ）都在屏幕里
    const left = anchor + shift - w / 2
    if (left < pad) shift += pad - left
    else if (left + w > vw - pad) shift -= left + w - (vw - pad)
    panel.style.setProperty('--dshp-shift', Math.round(shift) + 'px')

    // 纵向避障与兜底：
    // 脚部输入框：如果伸出屏幕下边缘，往上平移收缩，保证完全可见且不被任务栏截断
    // 头部面板：如果伸出屏幕上边缘，往下平移
    let shiftY = 0
    if (isComposer) {
      if (rect.bottom > vh - pad) {
        shiftY = vh - pad - rect.bottom
      }
      if (rect.top + shiftY < pad) {
        shiftY = pad - rect.top
      }
    } else {
      const top = rect.top
      if (top < pad) {
        shiftY = pad - top
      }
      if (rect.bottom + shiftY > vh - pad) {
        shiftY = vh - pad - rect.bottom
      }
    }
    panel.style.setProperty('--dshp-shift-y', Math.round(shiftY) + 'px')
  }

  function clampPanels() {
    placePanel(ui && ui.menu && ui.menu.el)
    placePanel(ui && ui.composer && ui.composer.el)
    placePanel(ui && ui.hud && ui.hud.el)
    placePanel(ui && ui.bubble && ui.bubble.el)
    placePanel(ui && ui.report && ui.report.el)   // 工作简报面板
    placePanel(ui && ui.mail && ui.mail.el)       // 头顶信封
  }

  function fitModel(explicitHeight) {
    if (!model || !app) return
    const im = model.internalModel
    // 只信 internalModel：Live2DModel 继承 PIXI Container，没有自己的 width 取值器
    const baseW = im.width || im.originalWidth || 1
    const baseH = im.height || im.originalHeight || 1
    const saved = readLayout()
    const wanted = clamp(Number(explicitHeight) || Number(saved.height) || CFG.height, 120, 900)
    // 用户明确要求：一直用「整张桌子」，不做上半身/只有头的取景。
    const mode = 'full'
    const frac = FIT_FRACTION[mode] || 1

    // 角色在画布里的实体范围（归一化）。没测出来就退回整个画布。
    const box = contentBox || { x0: 0, y0: 0, x1: 1, y1: 1, bands: null }
    const ch = Math.max(0.02, box.y1 - box.y0)
    const cw = Math.max(0.02, box.x1 - box.x0)

    // 四周留余量：主人反馈「尾巴被截掉、有些表情出格被掐」。
    // 原因是原来视窗高度**正好等于**实体高度、宽度又按固定宽高比算 ——
    // 横向超出（尾巴、头顶鲸）和纵向超出（举起来的道具、惊讶表情）就都被裁掉了。
    // 现在实体四周各留 PAD，窗口比实体大一圈，她才能完整显示。
    const PAD = 0.1
    const viewHModel = ch * frac * baseH * (1 + PAD * 2)
    // 宽度取「固定宽高比」和「实体宽度 + 余量」里更宽的那个
    const viewWModel = Math.max(viewHModel * VIEW_ASPECT, cw * baseW * (1 + PAD * 2))
    const centerXNorm = box.bands && box.bands[mode] ? box.bands[mode].center : (box.x0 + box.x1) / 2
    const centerXModel = centerXNorm * baseW

    // 缩放按**实体高度**算（不是视窗高度）：加了余量之后她的大小和以前一模一样，
    // 只是周围多出一圈空间。
    let scale = wanted / (ch * frac * baseH)
    const maxW = Math.max(240, window.innerWidth * (CFG.maxWidthRatio || 0.5))
    if (viewWModel * scale > maxW) scale = maxW / viewWModel

    const w = Math.max(40, Math.round(viewWModel * scale))
    const h = Math.max(40, Math.round(viewHModel * scale))

    model.scale.set(scale)
    // 锚点放到左上角：position 就等于「模型画布左上角在容器里的位置」，算起来最直观
    model.anchor.set(0, 0)
    app.renderer.resize(w, h)
    const padYModel = ch * frac * baseH * PAD
    model.position.set(
      -Math.round((centerXModel - viewWModel / 2) * scale),
      -Math.round((box.y0 * baseH - padYModel) * scale),
    )

    ui.stage.style.width = w + 'px'
    ui.stage.style.height = h + 'px'
    ui.root.style.width = w + 'px'
    ui.root.style.height = h + 'px'
    // 气泡/按钮/菜单跟着模型一起缩放，比例才不会走样
    // 例外：正在拖「大小」滑块时**冻住缩放**。否则每拖一格模型就变大一点、
    // 面板跟着变宽一点，滑块轨道从鼠标底下跑掉——主人说的
    // 「滑动的时候很难受，必须点一下设置一个值，不能拖拽」就是这个反馈环。
    if (!sizingSize) {
      const uiScale = clamp(h / UI_BASE_HEIGHT, 0.7, 2.2)
      ui.root.style.setProperty('--dshp-s', uiScale.toFixed(3))
      // 面板自己一套缩放：夹在 0.85~1.15，缩太小就没法操作了
      ui.root.style.setProperty('--dshp-ps', clamp(h / UI_BASE_HEIGHT, 0.85, 1.15).toFixed(3))
    }
    mask.dirty = true
    lastView = {
      w,
      h,
      mode,
      scale: Number(scale.toFixed(4)),
      content: {
        x0: +box.x0.toFixed(3),
        y0: +box.y0.toFixed(3),
        x1: +box.x1.toFixed(3),
        y1: +box.y1.toFixed(3),
      },
    }
    return lastView
  }

  /** 先量实体范围，再按它取景；量不出来就退回按整张画布取景。 */
  async function fitFromMeasurement() {
    try {
      const bbox = await measureContent()
      if (bbox && bbox.x1 - bbox.x0 > 0.05 && bbox.y1 - bbox.y0 > 0.05) {
        contentBox = bbox
      } else {
        console.warn('[鲸鱼娘] 实体范围测不出来，按整张画布取景')
      }
    } catch (err) {
      console.warn('[鲸鱼娘] 测量实体范围出错：', err && err.message)
    }
    return fitModel()
  }

  /**
   * 量一次「角色实体在画布里的范围」。
   *
   * 做法：先把模型按固定比例完整铺进一张参考画布（不裁剪），等一帧让 postrender 里的
   * 掩码采样跑完，从掩码里取非透明像素的外接框。因为这个测量是在「完整显示」状态下做的，
   * 得到的归一化比例与后续缩放无关，可以直接拿去算任何取景。
   *
   * 拿不到（隐藏标签页里 rAF 不触发、或者掩码生成失败）就返回 null，调用方退回整个画布。
   */
  async function measureContent() {
    const im = model.internalModel
    const baseW = im.width || im.originalWidth || 1
    const baseH = im.height || im.originalHeight || 1
    const REF = 420
    const s = REF / baseH
    const w = Math.max(16, Math.round(baseW * s))
    const h = REF

    model.scale.set(s)
    model.anchor.set(0, 0)
    app.renderer.resize(w, h)
    model.position.set(0, 0)
    ui.stage.style.width = w + 'px'
    ui.stage.style.height = h + 'px'
    mask.dirty = true
    mask.bbox = null

    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))
    const deadline = performance.now() + 800
    while (performance.now() < deadline) {
      await nextFrame()
      if (mask.bbox && !mask.dirty) return Object.assign({}, mask.bbox, { bands: mask.bands })
    }
    return mask.bbox ? Object.assign({}, mask.bbox, { bands: mask.bands }) : null
  }

  /** 贴边的留白（视觉上「贴住」但不顶死） */
  const EDGE_GAP = 10
  /** 松手时离边多近就吸附 */
  const SNAP_DIST = 52

  /** 工具条在容器下面探出来的高度（贴底时要把这段算进去，否则按钮会被屏幕切掉） */
  function dockClearance() {
    const s = parseFloat((ui.root.style.getPropertyValue('--dshp-s') || '1').trim()) || 1
    return 34 * s
  }

  /** 平滑移动到位（拖动是瞬时的，吸附要有个「吸过去」的过程） */
  function glideTo(left, top) {
    const el = ui.root
    el.style.transition = 'left .22s cubic-bezier(.2,.9,.3,1), top .22s cubic-bezier(.2,.9,.3,1)'
    el.style.left = left + 'px'
    el.style.top = top + 'px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
    setTimeout(() => {
      el.style.transition = ''
      clampPanels()
    }, 260)
  }

  /**
   * 松手时的贴边吸附。
   * 靠近左下/右下角 → 直接记成「角落模式」（窗口大小变了也跟着走）；
   * 只贴某一边 → 固定那一轴，另一轴保持自由。
   */
  /**
   * 松手时的贴边吸附。
   *
   * 主人改的规矩（原话）：「只吸附右边、不吸附底，我可以随意调整高低，
   * 但只吸附右边或左边的墙壁」——所以这里**只看左右**：
   *   · 靠左墙 / 靠右墙 → 吸过去，竖直位置保持你松手的那个高度
   *   · 离两边都远 → 就停在原地（竖直方向永远不吸）
   * 竖直方向只做一件事：别让底下的三个按钮被屏幕切掉（软性夹一下，不是吸附）。
   */
  function snapOnRelease() {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const r = ui.root.getBoundingClientRect()
    const nearL = r.left < SNAP_DIST
    const nearR = vw - r.right < SNAP_DIST
    if (!nearL && !nearR) return false // 底部不再吸附

    const edge = nearR ? 'right' : 'left'
    const y = clampY(r.top, r.height, vh)
    const left = edge === 'left' ? EDGE_GAP : vw - r.width - EDGE_GAP
    glideTo(left, y)
    // 记成「贴哪一边 + 竖直位置」，窗口大小变了也还贴着那一边、高低不动
    saveLayout({ x: null, y: null, corner: null, edge, edgeY: Math.round(y) })
    ui.root.dataset.edge = edge
    return true
  }

  /** 竖直位置的安全范围：上面别顶出屏幕，下面给工具栏留出位置（不是吸附，只是夹一下） */
  function clampY(top, height, vh) {
    const dock = dockClearance()
    const maxTop = Math.max(-20, (vh || window.innerHeight) - height - dock - 4)
    return clamp(top, -20, maxTop)
  }

  /** 水平方向同样要夹（issue #13：窗口变小后她整只停在屏幕外 ✗ —— 之前只有 Y 夹了） */
  function clampX(left, width, vw) {
    const maxLeft = Math.max(-20, (vw || window.innerWidth) - (width || 0) - 12)
    return clamp(left, -40, maxLeft)
  }

  /** 贴住某一侧墙：left/right + top 固定，竖直位置由主人自己定 */
  function applyEdge(edge, y) {
    const root = ui.root
    // 外观档位：跟随系统（默认）/ 浅色 / 深色 —— 手动选过就按本地的来
    try {
      restoreCfg()
      const th = readLayout().theme
      if (th === 'light' || th === 'dark') root.dataset.dshpTheme = th
    } catch (err) {}

    const yy = clampY(Number(y) || 0, root.getBoundingClientRect().height || 0, window.innerHeight)
    root.style.left = edge === 'left' ? EDGE_GAP + 'px' : 'auto'
    root.style.right = edge === 'right' ? EDGE_GAP + 'px' : 'auto'
    root.style.top = Math.round(yy) + 'px'
    root.style.bottom = 'auto'
    root.dataset.edge = edge
    if (desktopRoamEngine && typeof desktopRoamEngine.setAnchor === 'function') {
      const r = root.getBoundingClientRect()
      desktopRoamEngine.setAnchor(r.left, r.top)
    }
  }

  /**
   * 摆放位置。三种存档：
   *   · edge + edgeY —— 贴左/右墙，竖直位置自由（**现在吸附后存的就是这种**）
   *   · x + y        —— 完全自由摆放
   *   · corner       —— 老存档（左下/右下那种），读到时自动迁移成 edge 形式，竖直位置按角落换算
   */
  function applyPosition(layout) {
    const root = ui.root
    const vh = window.innerHeight
    const h = root.getBoundingClientRect().height || 0
    const dock = dockClearance()

    if (layout.edge === 'left' || layout.edge === 'right') {
      applyEdge(layout.edge, layout.edgeY != null ? layout.edgeY : vh - h - dock - EDGE_GAP)
      return
    }
    if (layout.x != null && layout.y != null) {
      const w = root.getBoundingClientRect().width || 0
      // issue #13：X 以前没夹 —— 换显示器/窗口变小后她会整只落在屏幕外 → 也夹一下
      const cx = clampX(layout.x, w, window.innerWidth)
      const cy = clampY(layout.y, h, vh)
      root.style.left = cx + 'px'
      root.style.top = cy + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      root.dataset.edge = ''
      if (desktopRoamEngine && typeof desktopRoamEngine.setAnchor === 'function') {
        desktopRoamEngine.setAnchor(cx, cy)
      }
      return
    }
    // 老存档 / 首次启动：按角落算一次，然后就地存成 edge 形式（下次就是新的了）
    const corner = layout.corner || CFG.corner || 'br'
    const edge = corner === 'bl' || corner === 'tl' ? 'left' : 'right'
    const y = corner === 'tr' || corner === 'tl' ? 64 : vh - h - dock - EDGE_GAP
    applyEdge(edge, y)
    saveLayout({ corner: null, edge, edgeY: Math.round(clampY(y, h, vh)) })
  }

  // ——————————————————————————————————————————————————————————————
  // 六、命中掩码：让点击穿透空气
  // ——————————————————————————————————————————————————————————————

  const mask = { grid: null, w: 0, h: 0, dirty: true, building: false, lastBuild: 0, bbox: null, bands: null }

  /**
   * 一条竖带里「实体质量的横向重心与范围」。
   *
   * 为什么不直接用整条带的外接框：这个模型是一整张书桌场景，桌子比人宽得多。
   * 按整条带的外接框取景，镜头会被人两边的东西（桌沿、鼠标垫）拽偏，
   * 结果就是人在画面左边、右边一大片空。按「质量」算重心就稳得多。
   */
  function bandWindow(grid, W, y0, y1) {
    const cols = new Float32Array(W)
    let max = 0
    for (let y = y0; y < y1; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        if (grid[row + x]) {
          cols[x]++
          if (cols[x] > max) max = cols[x]
        }
      }
    }
    if (max <= 0) return null
    const thresh = max * 0.25
    let mass = 0
    let wsum = 0
    for (let x = 0; x < W; x++) {
      // 只统计「有实体分量」的列，零星空隙不会把重心拽走
      if (cols[x] >= thresh) {
        mass += cols[x]
        wsum += cols[x] * x
      }
    }
    if (mass <= 0) return null
    const center = wsum / mass
    return { center: center / W }
  }

  /** 为每个取景档算出各自的横向重心（归一化）。 */
  function computeBands(grid, W, H, bbox) {
    const y0 = Math.max(0, Math.floor(bbox.y0 * H))
    const y1 = Math.min(H, Math.ceil(bbox.y1 * H))
    const ch = Math.max(1, y1 - y0)
    const out = {}
    for (const [mode, frac] of Object.entries(FIT_FRACTION)) {
      const by1 = Math.min(y1, Math.max(y0 + 1, Math.round(y0 + ch * frac)))
      const win = bandWindow(grid, W, y0, by1)
      out[mode] = win || { center: (bbox.x0 + bbox.x1) / 2 }
    }
    return out
  }

  function buildMask() {
    if (!app || !model || mask.building) return
    if (performance.now() - mask.lastBuild < 300) return
    mask.building = true
    try {
      const src = app.view
      if (!src || !src.width || !src.height) throw new Error('画布还没准备好')
      const W = 128
      const H = Math.max(24, Math.round((W * src.height) / src.width))
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d', { willReadFrequently: true })
      g.clearRect(0, 0, W, H)
      g.drawImage(src, 0, 0, W, H)
      const data = g.getImageData(0, 0, W, H).data
      const grid = new Uint8Array(W * H)
      let filled = 0
      let minx = W
      let miny = H
      let maxx = -1
      let maxy = -1
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x
          if (data[i * 4 + 3] > 26) {
            grid[i] = 1
            filled++
            if (x < minx) minx = x
            if (x > maxx) maxx = x
            if (y < miny) miny = y
            if (y > maxy) maxy = y
          }
        }
      }
      const coverage = filled / (W * H)
      // 全空说明这一帧没画上东西，别把掩码覆盖成「处处不可点」
      if (coverage < 0.005) throw new Error('画面是空的')
      mask.grid = grid
      mask.w = W
      mask.h = H
      mask.bbox =
        maxx >= 0
          ? { x0: minx / W, y0: miny / H, x1: (maxx + 1) / W, y1: (maxy + 1) / H }
          : null
      mask.bands = mask.bbox ? computeBands(grid, W, H, mask.bbox) : null
      mask.dirty = false
      mask.lastBuild = performance.now()
      log(
        `命中掩码 ${W}×${H}，覆盖率 ${(coverage * 100).toFixed(1)}%` +
          (mask.bbox
            ? `，实体范围 x ${mask.bbox.x0.toFixed(2)}–${mask.bbox.x1.toFixed(2)} / y ${mask.bbox.y0.toFixed(2)}–${mask.bbox.y1.toFixed(2)}`
            : ''),
      )
    } catch (err) {
      // 拿不到掩码就退回整个矩形可点，功能不至于丢
      mask.grid = null
      mask.dirty = false
      mask.lastBuild = performance.now()
      console.warn('[鲸鱼娘] 掩码生成失败，退回包围盒判定：', err && err.message)
    } finally {
      mask.building = false
    }
  }

  /** 客户端坐标是否落在鲸鱼娘身上（而不是桌宠框里的空气）。 */
  function hitTest(clientX, clientY) {
    const stage = app && app.view && app.view.parentElement
    if (!stage) return false
    const r = stage.getBoundingClientRect()
    if (!r.width || !r.height) return false
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false
    if (!mask.grid) return true
    const facing = (desktopRoamEngine && desktopRoamEngine.facing) || 1
    const normX = facing === -1 ? (r.right - clientX) / r.width : (clientX - r.left) / r.width
    const mx = Math.floor(normX * mask.w)
    const my = Math.floor(((clientY - r.top) / r.height) * mask.h)
    if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) return false
    return mask.grid[my * mask.w + mx] === 1
  }

  /**
   * 鼠标是不是在「她下方那排按钮」上（含一点外扩的容错）。
   * 这三个键不在模型掩码里，只靠 hitTest 会让它们一出现就消失、根本点不着。
   */
  function overDock(clientX, clientY) {
    try {
      if (!ui || !ui.dock) return false
      const r = ui.dock.getBoundingClientRect()
      if (!r.width || !r.height) return false
      const pad = 12
      return (
        clientX >= r.left - pad &&
        clientX <= r.right + pad &&
        clientY >= r.top - pad &&
        clientY <= r.bottom + pad
      )
    } catch (err) {
      return false
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 六点五、视线控制器
  // ——————————————————————————————————————————————————————————————

  /**
   * 为什么要有这一层：最初的做法是「鼠标一动就把头指过去」，结果头摆得像螺旋桨——
   * 又急、幅度又大、还一直死盯着你。现在拆成四件事：
   *
   *   1. 只有光标进到桌宠附近（GAZE_RADIUS）才跟随；离远了它自己发呆、看别处、想事情
   *   2. 幅度只取 58%（GAZE_GAIN），而且是「越近跟得越实、越远越松」，不做 100% 硬绑
   *   3. 目标怎么跳都不管，实际值一律限速逼近（GAZE_MAX_RATE）——头再急也只能慢慢转
   *   4. 互动/大动作期间 detach：人在做动作的时候眼睛不会死盯着你
   *
   * 关掉「视线跟随」之后它不会愣住——下面是同一套自主动作在跑。
   */
  /**
   * 默认值（都能在设置里实时调，见 CFG.gaze*）：
   *   radius = 0   整屏跟随——鼠标在哪儿它看哪儿，不再只跟附近
   *   gain   = 0.78 跟随幅度；调小就「不太理你」，调大就更黏
   *   rate   = 1.6  每秒最多变化多少；调小更慵懒，调大更机灵
   */
  function gazeCfg() {
    return {
      radius: CFG.gazeRadius === undefined ? 0 : Number(CFG.gazeRadius),
      // 原作者在 VTube 配置里：眼珠平滑 0（零延迟）、头部 31/32、歪头 85（很软）。
      // 我们这边是整套一起平滑，所以先把默认值调快，让『眼珠优先跟手』的感觉出来；
      // 严格的分组延迟需要动 rig 层，见 README 的 TODO。滑块仍然可以实时微调。
      gain: CFG.gazeGain === undefined ? 0.9 : Number(CFG.gazeGain),
      rate: CFG.gazeRate === undefined ? 3.2 : Number(CFG.gazeRate),
    }
  }

  const gaze = {
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    mode: 'idle',
    detachUntil: 0,
    pointer: { x: 0, y: 0, seen: false },
    nextDrift: 0,
    driftX: 0,
    driftY: 0,
    lastTick: 0,
    /** 视线纵向偏置：读资料时压低，等于「低头看本子」，走的是同一条限速通道 */
    biasY: 0,
    biasTarget: 0,
  }

  function feedPointer(x, y) {
    gaze.pointer.x = x
    gaze.pointer.y = y
    gaze.pointer.seen = true
    gaze.pointer.at = performance.now()
    if (frameRateGovernor) frameRateGovernor.touch()
    try {
      if (ui && ui.root && !isPetDragging) {
        const on = hitTest(x, y) || overDock(x, y)
        isPetHovered = !!on
        if (desktopRoamEngine && typeof desktopRoamEngine.setBlocked === 'function') {
          desktopRoamEngine.setBlocked(isSettingOrInteractionOpen(), 'hover')
        }
        if (on) {
          ui.root.classList.add('dshp-hover')
        }
      }
    } catch (e) {}
  }

  /**
   * 爱心粒子。模型自带左右两组爱心（爱心左 j1–j32 / 爱心右 j33–j57），
   * 而 `love` 和 `ParamCheek73` 属于「通用动画(循环)」组——置 1 就会一直循环冒爱心，
   * 所以摸头时用它们做持续 2 秒的爱心爆发，再配脸红和爱心眼。
   */
  function heartBurst(ms) {
    rig.burst = { love: 1, heartbeat: 1, until: performance.now() + (ms || 2200) }
    rig.dirty = true
  }

  /** 做动作时暂时别盯人（对应 clawd-on-desk 那套「反应动画期间脱离眼球追踪」）。 */
  function gazeDetach(ms) {
    gaze.detachUntil = performance.now() + (ms || 1500)
  }

  function gazeTick() {
    if (!model || !ui) return
    const now = performance.now()
    const dt = Math.min(0.25, (now - (gaze.lastTick || now)) / 1000)
    gaze.lastTick = now
    const detached = now < gaze.detachUntil

    let wantX = 0
    let wantY = 0
    let following = false

    const g = gazeCfg()
    // 指针超过 2 秒没有更新（桌面版壳子停止喂数据 / 鼠标离开跟踪源）→ 视为脱离，
    // 不再盯着最后那个方向，而是回正脸（主人要求：找不到光标就朝前看）
    const pointerFresh = gaze.pointer.seen && now - (gaze.pointer.at || 0) < 2000
    if (!detached && CFG.lookAtCursor && pointerFresh) {
      const r = ui.stage.getBoundingClientRect()
      if (r.width) {
        const dx = gaze.pointer.x - (r.left + r.width / 2)
        const dy = gaze.pointer.y - (r.top + r.height / 2)
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (g.radius <= 0 || dist < g.radius) {
          following = true
          // 参照距离按屏幕算，这样鼠标在屏幕任何角落都落在有效范围内
          const refX = Math.max(r.width, window.innerWidth * 0.5)
          const refY = Math.max(r.height, window.innerHeight * 0.5)
          wantX = clamp(dx / refX, -1, 1) * g.gain
          wantY = clamp(-dy / refY, -1, 1) * g.gain
        }
      }
    }

    if (following) {
      gaze.mode = 'follow'
    } else {
      // 没人管它：自己看东看西、想事情
      gaze.mode = detached ? 'detach' : 'idle'
      // 主人要求：脱离跟随就「回正脸」，不要老歪着斜眼看一个地方，也不能长时间卡住。
      // 所以游移幅度从 ±0.5 收到 ±0.11（基本朝前），间隔也缩短，不再一盯好几秒。
      if (now > gaze.nextDrift) {
        gaze.nextDrift = now + 1100 + Math.random() * 1800
        gaze.driftX = (Math.random() * 2 - 1) * (detached ? 0.07 : 0.11)
        gaze.driftY = (Math.random() * 2 - 1) * (detached ? 0.05 : 0.09)
      }
      const t = now / 1000
      // 明确往「正脸」收：游移只作为一点点生气，而不是主基调
      wantX = gaze.driftX * 0.85 + Math.sin(t * 0.37) * 0.045
      wantY = gaze.driftY * 0.85 + Math.cos(t * 0.29) * 0.035
    }

    // 低头看资料：只是给视线加一个纵向偏置，仍然受同一个限速器约束，
    // 所以不会突然「咔」一下低头。
    gaze.biasY += (gaze.biasTarget - gaze.biasY) * clamp(dt * 1.6, 0, 1)
    // 低头偏置是**改变方向**，不是放大幅度：
    // 合成方向后统一乘 gain，这样总幅度永远不超过 gain（否则低头会额外顶出去 0.3）。
    if (gaze.biasY !== 0 && following) {
      let dx2 = wantX / g.gain
      let dy2 = wantY / g.gain + gaze.biasY
      const mag = Math.sqrt(dx2 * dx2 + dy2 * dy2)
      if (mag > 1) {
        dx2 /= mag
        dy2 /= mag
      }
      wantX = dx2 * g.gain
      wantY = dy2 * g.gain
    } else if (!following) {
      wantY += gaze.biasY
    }
    wantX = clamp(wantX, -1, 1)
    wantY = clamp(wantY, -1, 1)

    gaze.tx += (wantX - gaze.tx) * clamp(dt * 3.0, 0, 1)
    gaze.ty += (wantY - gaze.ty) * clamp(dt * 3.0, 0, 1)
    const maxStep = g.rate * dt
    // 记录真实步长速率（单位/秒）。测试用它验证限速器，比在外部按采样间隔
    // 估算靠谱得多——页面卡顿会让 tick 变长，采样法会误判成「超速」。
    gaze.stepRate = Math.max(gaze.stepRate || 0, maxStep / Math.max(dt, 1e-6))
    gaze.x = clamp(gaze.x + clamp(gaze.tx - gaze.x, -maxStep, maxStep), -1, 1)
    gaze.y = clamp(gaze.y + clamp(gaze.ty - gaze.y, -maxStep, maxStep), -1, 1)

    try {
      // 注意：只调 focus() 是限不住的——框架自己还会把 x 朝 targetX 缓动一次，
      // 那一步比我们的限速更快。所以当前值和目标值一起写，限速器才是唯一权威。
      const fc = model.internalModel.focusController
      fc.targetX = gaze.x
      fc.targetY = gaze.y
      fc.x = gaze.x
      fc.y = gaze.y
      // 回读一下：写入被谁覆盖的话，这里能第一时间看出来
      gaze.fcX = fc.x
      gaze.fcErr = ''
    } catch (err) {
      gaze.fcErr = String((err && err.message) || err)
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 六点六、动作表现：Q 弹 / 惯性回弹 / 爱心 / 工作轮播
  // ——————————————————————————————————————————————————————————————

  /** Q 弹抖动：点击时整个身子软软地弹一下（Web Animations，不碰模型参数）。 */
  function qBounce(power) {
    const el = ui && ui.stage
    if (!el || !el.animate) return
    const k = power == null ? 1 : power
    el.style.transformOrigin = '50% 100%'
    el.animate(
      [
        { transform: 'scale(1,1)' },
        { transform: `scale(${1 + 0.1 * k},${1 - 0.12 * k})` },
        { transform: `scale(${1 - 0.045 * k},${1 + 0.055 * k})` },
        { transform: 'scale(1,1)' },
      ],
      { duration: 460, easing: 'cubic-bezier(.34,1.56,.64,1)' },
    )
  }

  /** 拖拽松手后的惯性回弹：速度衰减着滑一段，再落定。 */
  function dragInertia(vx, vy) {
    const el = ui && ui.root
    if (!el) return
    if (dragInertiaRaf) {
      cancelAnimationFrame(dragInertiaRaf)
      dragInertiaRaf = 0
    }
    let px = parseFloat(el.style.left) || 0
    let py = parseFloat(el.style.top) || 0
    let sx = vx
    let sy = vy
    const h = el.getBoundingClientRect().height
    const step = () => {
      if (isPetDragging) {
        dragInertiaRaf = 0
        return
      }
      sx *= 0.85
      sy *= 0.85
      px = clamp(px + sx, -40, window.innerWidth - 60)
      py = clampY(py + sy, h, window.innerHeight)
      el.style.left = px + 'px'
      el.style.top = py + 'px'
      if (desktopRoamEngine && typeof desktopRoamEngine.setAnchor === 'function') {
        desktopRoamEngine.setAnchor(px, py)
      }
      if (Math.abs(sx) > 0.4 || Math.abs(sy) > 0.4) {
        dragInertiaRaf = requestAnimationFrame(step)
      } else {
        dragInertiaRaf = 0
        saveLayout({ x: Math.round(px), y: Math.round(py), edge: null, edgeY: null, corner: null })
        reportBoundsToShell()
      }
    }
    dragInertiaRaf = requestAnimationFrame(step)
  }

  /**
   * 工作轮播。规格要求「变出小电脑、敲键盘、轮播 认真/摸鱼/思考」。
   * 所以干活期间不是钉在一张脸上，而是按节奏换：敲键盘 → 认真看 → 偷偷摸鱼 → 思考。
   */
  // 干活时的两个状态：认真看资料 / 思考。切换很慢（见 workTick 的间隔），
  // 主人明确说过「工作模式下不要切太多」。
  const WORK_CYCLE = [
    { mood: 'reading', say: 'reading' },
    { mood: 'thinking', say: 'thinking' },
  ]
  const work = { i: 0, nextAt: 0, active: false }
  /** 小设备是否已经掏出来了（查资料时），用完要收回去 */
  const device = { out: false }

  function startWork() {
    if (work.active) return
    work.active = true
    work.i = 0
    work.nextAt = 0
    // 用模型自带的开盖动作把设备掏出来；道具由 WORK_PROPS 决定
    playMotion('openLid')
    gazeDetach(1200)
  }

  function endWork() {
    work.active = false
    gaze.biasTarget = 0
    putDeviceAway()
  }

  /** 把小设备收回去，回到常驻待机动作。 */
  function putDeviceAway() {
    if (!device.out) return
    device.out = false
    // 收起小设备，回到默认姿势（手里的笔也就回来了）
    stopMotion()
  }

  function workTick() {
    if (!work.active) return
    const now = performance.now()
    if (now < work.nextAt) return
    work.nextAt = now + 9000 + Math.random() * 5000 // 慢切换
    const stepDef = WORK_CYCLE[work.i % WORK_CYCLE.length]
    work.i++
    // 轮播只改底层状态，不产生会赖着不走的一次性反应
    setBase(stepDef.mood, WORK_PROPS)
    // 正在思考/看资料：把话说到气泡正文里，别只更新脚注（那样看着像在摸鱼）
    if (!rig.talking) {
      const profile = TapProfileRegistry.get(activeCharacterId)
      const rawLine = (stepDef.mood === 'reading') ? profile.pickReadingLine() : profile.pickThinkingLine()
      const parsed = ActionCueParser.parse(rawLine)
      ui.bubble.show(parsed.bubbleText, {
        name: activeCharInfo().name,
        busy: true,
        sticky: true,
      })
      ui.bubble.note(stepDef.mood === 'reading' ? '看资料' : '思考中')
      if (CFG.sound !== false && parsed.speechText && !isSpeakingAudio) {
        speakCharacterText(parsed.speechText, activeCharacterId)
      }
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 七、UI
  // ——————————————————————————————————————————————————————————————

  function buildUI() {
    // 防御性清理：防止页面内或热重载时残留历史 DOM 根节点
    try {
      const oldRoot = document.getElementById('dsh-live2d-pet')
      if (oldRoot) oldRoot.remove()
      const oldTabs = document.querySelectorAll('.dshp-tab,.dshp-detached-pill')
      oldTabs.forEach((el) => el.remove())
    } catch (e) {}

    const root = $('div', 'dshp-root')
    root.id = 'dsh-live2d-pet'

    const stage = $('div', 'dshp-stage')

    const bubbleEl = $('div', 'dshp-bubble')
    const head = $('div', 'dshp-head')
    const dot = $('span', 'dshp-dot')
    const headText = $('span', null, (typeof activeCharInfo === 'function' && activeCharInfo() && activeCharInfo().name ? activeCharInfo().name : '伴侣'))
    head.append(dot, headText)
    const body = $('div', 'dshp-body')
    const foot = $('div', 'dshp-foot')
    bubbleEl.append(head, body, foot)

    const dock = $('div', 'dshp-dock')
    const talkBtn = $('button', 'dshp-btn dshp-primary', '💬 说话')
    const menuBtn = $('button', 'dshp-btn', '⋯')
    const hideBtn = $('button', 'dshp-btn', '–')
    hideBtn.title = '收起（桌面版会缩成贴边小球）'
    // 主人要的：一键打开 DeepSeek Harness，纯符号不写字
    const openBtn = $('button', 'dshp-btn dshp-icon', '↗')
    openBtn.title = '打开 DeepSeek Harness 界面'
    dock.append(talkBtn, menuBtn, hideBtn, openBtn)

    const composer = $('div', 'dshp-panel dshp-composer')
    const ta = $('textarea')
    ta.placeholder = '跟 DSH 说点什么…（Enter 发送 / Shift+Enter 换行）'
    const crow = $('div', 'dshp-row')
    const sendBtn = $('button', 'dshp-btn dshp-primary', '发送')
    const cancelBtn = $('button', 'dshp-btn', '打断')
    crow.append($('span', 'dshp-grow'), cancelBtn, sendBtn)
    const chint = $('div', 'dshp-hint', '发出去的话进入当前会话，回复会显示在气泡里。')
    composer.append(ta, crow, chint)
    addCloseButton(composer)

    const menu = $('div', 'dshp-panel dshp-menu')
    const tabs = $('div', 'dshp-tabs')
    const panes = $('div')
    panes.classList.add('dshp-panes')
    menu.append(tabs, panes)
    addCloseButton(menu)

    const tab = $('div', 'dshp-tab', '🐋 鲸鱼娘')

    // 右键弹出的 HUD（余额 / 本轮消耗 / 峰谷计价）
    const hud = $('div', 'dshp-hud')
    const hudHead = $('div', 'dshp-hud-head')
    const hudTitle = $('span', null, '鲸鱼娘 · 钱包')
    const hudDot = $('span', 'dshp-hud-tag dshp-valley', '谷')
    hudHead.append(hudTitle, hudDot)
    const hudMoney = $('div', 'dshp-hud-money')
    const hudMoneyNum = $('b', null, '—')
    const hudMoneyCur = $('span', null, 'CNY')
    hudMoney.append(hudMoneyNum, hudMoneyCur)
    const hudRowToday = $('div', 'dshp-hud-row')
    const hudTodayV = $('span', 'dshp-hud-v', '—')
    hudRowToday.append($('span', 'dshp-hud-k', '今日已用'), hudTodayV)
    const hudRowTurn = $('div', 'dshp-hud-row')
    const hudTurnV = $('span', 'dshp-hud-v', '—')
    hudRowTurn.append($('span', 'dshp-hud-k', '本轮消耗'), hudTurnV)
    const hudRowCd = $('div', 'dshp-hud-row')
    const hudCdV = $('span', 'dshp-hud-v', '—')
    hudRowCd.append($('span', 'dshp-hud-k', '距切换'), hudCdV)
    const hudFoot = $('div', 'dshp-hud-foot', '')
    hud.append(
      hudHead, hudMoney,
      $('div', 'dshp-hud-sep'),
      hudRowTurn, hudRowToday, hudRowCd,
      hudFoot,
    )
    addCloseButton(hud, () => closeHud())

    const detachedPill = $('div', 'dshp-detached-pill', '🖥️ 已在独立桌面常驻 · 点击收回客户端')
    detachedPill.title = '桌宠已脱离客户端并在桌面独立常驻，点击此处可收回客户端内渲染'
    detachedPill.addEventListener('click', async () => {
      await requestDesktopCloseGlobal()
      setClientDetached(false)
      if (ui && ui.bubble) {
        ui.bubble.show('已收回至客户端内渲染啦～', { name: activeCharInfo().name, ttl: 2500 })
      }
    })

    root.append(stage, bubbleEl, dock, composer, menu, hud)
    document.body.append(root, tab, detachedPill)

    const u = {
      root,
      stage,
      tab,
      bubble: makeBubble(bubbleEl, body, foot, dot, headText),
      composer: { el: composer, ta, send: sendBtn, cancel: cancelBtn },
      menu: { el: menu, tabs, panes, focused: null },
      hud: {
        el: hud,
        badge: hudDot,
        money: hudMoneyNum,
        currency: hudMoneyCur,
        today: hudTodayV,
        turn: hudTurnV,
        countdown: hudCdV,
        foot: hudFoot,
        title: hudTitle,
      },
      dock,
    }
    bindComposer(u)
    bindMenu(u)

    root.addEventListener('mouseenter', () => {
      isPetHovered = true
      if (desktopRoamEngine && typeof desktopRoamEngine.setBlocked === 'function') {
        desktopRoamEngine.setBlocked(true, 'hover')
      }
    })
    root.addEventListener('mouseleave', () => {
      isPetHovered = false
      if (desktopRoamEngine && typeof desktopRoamEngine.setBlocked === 'function') {
        desktopRoamEngine.setBlocked(isSettingOrInteractionOpen(), 'hover')
      }
    })

    // 这里不能调 setHidden()——此刻 ui 还没赋值（ui = buildUI() 才刚返回），
    // setHidden 里读 ui.root 会直接抛异常，表现为「隐藏过一次之后，
    // 以后每次打开都起不来」。所以就地写类名。
    if (readLayout().hidden && !isStandalone) {
      root.classList.add('dshp-hidden')
      document.body.classList.add('dshp-pet-hidden')
    }
    if (!isStandalone) {
      requestDesktopStatusGlobal()
        .then((st) => {
          if (st && st.ok && st.running) {
            setClientDetached(true)
          }
        })
        .catch(() => {})
    }
    return u
  }

  function makeBubble(el, body, foot, dot, headText) {
    let timer = null
    let streaming = false
    let buffer = ''
    // 工作气泡占用中 → 互动气泡让位（见下面 show 里的优先级守卫）
    let workHold = false
    const api = {
      el,
      show(text, opts) {
        opts = opts || {}
        // 主人要求：**工作汇报优先级最高** —— 干活/汇报期间，随机互动气泡
        // （戳一下、待机台词这些带 ttl 的）安静等着，不许把汇报顶掉。
        // 正常模式下 workHold 为 false，互动照旧。
        const isWork = !!(opts.work || opts.sticky || opts.stream || (opts.busy && !opts.ttl && !opts.duration))
        if (opts.force) {
          workHold = false
        } else if (!isWork && workHold && el.classList.contains('dshp-on')) {
          return
        }
        if (isWork) workHold = true
        // 互动气泡出现 → 工作简报面板暂时隐身（互动结束后再回来）
        onBubbleEvent(isWork, true)
        const defaultName = (typeof activeCharInfo === 'function' && activeCharInfo() && activeCharInfo().name) ? activeCharInfo().name : '伴侣'
        headText.textContent = opts.name || defaultName
        if (opts.stream) {
          if (!streaming) {
            buffer = ''
            streaming = true
          }
          buffer += text
          const displayBuf = stripThinking(buffer)
          if (!displayBuf) {
            body.textContent = '思考中…'
          } else {
            body.textContent = displayBuf.length > 4000 ? '…' + displayBuf.slice(-4000) : displayBuf
          }
        } else {
          streaming = false
          buffer = String(text == null ? '' : text)
          const displayBuf = stripThinking(buffer)
          if (!displayBuf && !opts.busy) {
            api.hide()
            return
          }
          body.textContent = displayBuf
        }
        body.scrollTop = body.scrollHeight
        foot.textContent = opts.foot || ''
        dot.classList.toggle('dshp-pulse', !!opts.busy)
        el.classList.add('dshp-on')
        if (timer) clearTimeout(timer)
        const ttl = opts.sticky ? 0 : (opts.ttl != null ? opts.ttl : (opts.duration != null ? opts.duration : CFG.bubbleTtlMs))
        if (ttl > 0) timer = setTimeout(() => api.hide(), ttl)
      },
      setName(name) {
        if (name && headText) headText.textContent = name
      },
      clearWorkHold() {
        workHold = false
      },
      note(text) {
        foot.textContent = text
      },
      hide() {
        if (timer) clearTimeout(timer)
        timer = null
        streaming = false
        const wasWork = workHold
        workHold = false
        // 互动气泡消失 → 简报面板恢复显示
        onBubbleEvent(wasWork, false)
        buffer = ''
        el.classList.remove('dshp-on')
      },
      get visible() {
        return el.classList.contains('dshp-on')
      },
    }
    return api
  }

  // ——————————————————————————————————————————————————————————————
  // 八点四、工作简报（信封）
  //   主人要求：有任务要汇报 / 需要确认时，在头顶挂一个「信封」；
  //   点开是一个**大号、能看清、能滚**的简报面板（解决"气泡太小、滚太快看不清"）。
  //   汇报的优先级高于随机互动（见气泡 show 里的 workHold 守卫）。
  // ——————————————————————————————————————————————————————————————
  const mail = {
    items: [],
    unread: 0,
    el: null,
    panel: null,
    body: null,
    autoTimer: 0,
    hover: false,
    yieldWasOpen: false,
  }
  let lastReportKey = ''

  /** 当前连的是哪一个宿主（桌面版/网页版 + 端口），简报里标明来源用 */
  function hostLabel() {
    try {
      const b = window.__DSH_PET_BOOT__ || {}
      const kind = b.desktop ? '桌面版' : b.port ? '网页版' : '未知'
      return kind + (b.port ? ' · ' + b.port : '')
    } catch (err) {
      return '未知'
    }
  }

  /** 时间显示：今天只给 HH:MM，昨天给「昨天 HH:MM」，更早给「M月D日 HH:MM」 */
  function mailTime(ts) {
    const d = new Date(ts)
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000)
    if (days <= 0) return hm
    if (days === 1) return '昨天 ' + hm
    return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + hm
  }

  /** 推一条工作简报：头顶出现信封；同一份内容不重复塞，彻底剔除思考内容 */
  function pushReport(title, body) {
    try {
      let text = String(body == null ? '' : body).trim()
      text = stripThinking(text)
      if (!text) return
      const key = title + '|' + text
      if (key === lastReportKey) return
      lastReportKey = key
      ensureMailUI()
      mail.items.unshift({ title, body: text, at: Date.now(), read: false, src: hostLabel() })
      if (mail.items.length > 30) mail.items.length = 30
      mail.unread++
      renderMail()
    } catch (err) {}
  }

  function ensureMailUI() {
    if (mail.el || !ui || !ui.root) return
    const badge = $('button', 'dshp-mail')
    badge.title = '工作简报 · 点开看完整内容'
    badge.innerHTML =
      '<svg viewBox="0 0 32 25" aria-hidden="true">' +
      '<rect class="paper" x="1" y="1" width="30" height="23" rx="4"/>' +
      '<path class="inner" d="M3.6 6.2 L16 14.4 L28.4 6.2 L28.4 20.6 L3.6 20.6 Z"/>' +
      '<path class="flap" d="M2.4 3.4 L16 13.6 L29.6 3.4"/>' +
      '</svg>' +
      '<span class="dshp-mail-badge"></span>'
    badge.style.display = 'none'
    badge.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleReport()
    })

    const panel = $('div', 'dshp-panel dshp-report')
    const head = $('div', 'dshp-report-head')
    const title = $('span', 't', '工作简报')
    const count = $('span', 'n', '')
    const acts = $('div', 'dshp-report-acts')

    const readAll = $('button', 'dshp-report-act', '全部已读')
    readAll.title = '把未读标记全部清掉（不删内容）'
    readAll.addEventListener('click', (e) => {
      e.stopPropagation()
      markAllRead()
      touchReport()
    })
    const clearAll = $('button', 'dshp-report-act', '清空')
    clearAll.title = '删除全部简报'
    clearAll.addEventListener('click', (e) => {
      e.stopPropagation()
      clearAllMail()
    })
    const min = $('button', 'dshp-report-min', '–')
    min.title = '收起面板（信封还在）'
    min.addEventListener('click', (e) => {
      e.stopPropagation()
      hideReport(false)
    })
    const close = $('button', 'dshp-report-close', '×')
    close.title = '关闭（标记为已读后收起）'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      hideReport(true)
    })
    acts.append(readAll, clearAll, min, close)
    head.append(title, count, acts)

    const body = $('div', 'dshp-report-body')
    panel.append(head, body)

    // 鼠标放进面板里 / 移出去：自动收起计时器跟着暂停/继续
    panel.addEventListener('pointerenter', () => {
      mail.hover = true
      clearTimeout(mail.autoTimer)
    })
    panel.addEventListener('pointerleave', () => {
      mail.hover = false
      touchReport()
    })
    // 滚到哪读到哪：进入视口的条目自动标记已读（像微信消息列表）
    body.addEventListener(
      'scroll',
      () => {
        try {
          const br = body.getBoundingClientRect()
          for (const row of body.querySelectorAll('.dshp-report-item')) {
            const it = mail.items[Number(row.dataset.i)]
            if (!it || it.read) continue
            const r = row.getBoundingClientRect()
            if (r.top >= br.top - 4 && r.bottom <= br.bottom + 4) markItemRead(it)
          }
        } catch (err) {}
        touchReport()
      },
      { passive: true },
    )

    ui.root.append(badge, panel)
    mail.el = badge
    mail.panel = panel
    mail.body = body
    mail.titleEl = title
    mail.countEl = count
    // 登记到 ui 上：clampPanels() 会把它夹进屏幕
    ui.mail = { el: badge }
    ui.report = { el: panel }
  }

  /** 面板打开后如果一直没人理，20 秒自动收起来（主人要求：不能一直挡着） */
  function touchReport() {
    clearTimeout(mail.autoTimer)
    if (!mail.panel || !mail.panel.classList.contains('dshp-on')) return
    mail.autoTimer = setTimeout(() => {
      if (!mail.hover) hideReport(false)
    }, 20000)
  }

  function markAllRead() {
    for (const it of mail.items) it.read = true
    mail.unread = 0
    renderMail()
  }

  function markItemRead(it) {
    if (!it || it.read) return
    it.read = true
    mail.unread = Math.max(0, mail.unread - 1)
    renderMail()
  }

  function clearAllMail() {
    mail.items.length = 0
    mail.unread = 0
    renderMail()
    try {
      clampPanels()
    } catch (err) {}
  }

  function hideReport(allRead) {
    if (!mail.panel) return
    mail.panel.classList.remove('dshp-on')
    mail.panel.classList.remove('dshp-report-yield')
    mail.yieldWasOpen = false
    clearTimeout(mail.autoTimer)
    if (allRead) markAllRead()
  }

  function showReport() {
    if (!mail.panel) return
    mail.panel.classList.add('dshp-on')
    mail.panel.classList.remove('dshp-report-yield')
    markAllRead() // 点开信封 = 已读（微信式）
    touchReport()
    try {
      clampPanels()
    } catch (err) {}
  }

  /** 点信封：开/关简报面板 */
  function toggleReport() {
    if (!mail.panel) return
    if (mail.panel.classList.contains('dshp-on')) hideReport(false)
    else showReport()
  }

  /**
   * 互动气泡出现 → 简报面板**先隐身**；互动消失 → 面板**再回来**。
   * 工作/汇报类气泡不算互动，不隐身（它本身就是汇报）。
   */
  function onBubbleEvent(isWork, visible) {
    try {
      if (!mail.panel || isWork) return
      const open = mail.panel.classList.contains('dshp-on')
      if (visible) {
        if (open) {
          mail.yieldWasOpen = true
          mail.panel.classList.add('dshp-report-yield')
        }
      } else if (mail.yieldWasOpen) {
        mail.yieldWasOpen = false
        if (mail.panel.classList.contains('dshp-on')) {
          mail.panel.classList.remove('dshp-report-yield')
          touchReport()
        }
      }
    } catch (err) {}
  }

  function renderMail() {
    if (!mail.el) return
    mail.el.style.display = mail.items.length ? '' : 'none'
    mail.el.classList.toggle('dshp-mail-new', mail.unread > 0)
    const badgeNum = mail.el.querySelector('.dshp-mail-badge')
    if (badgeNum) {
      badgeNum.textContent = mail.unread > 0 ? String(mail.unread) : ''
      badgeNum.style.display = mail.unread > 0 ? '' : 'none'
    }
    if (!mail.panel) return
    if (mail.countEl) mail.countEl.textContent = mail.unread > 0 ? mail.unread + ' 条未读' : ''
    if (!mail.items.length) {
      mail.panel.classList.remove('dshp-on')
      mail.body.textContent = ''
      return
    }
    mail.body.textContent = ''
    mail.items.forEach((it, i) => {
      const row = $('div', 'dshp-report-item' + (it.read ? '' : ' dshp-report-new'))
      row.dataset.i = String(i)
      const meta = $('div', 'dshp-report-meta')
      if (!it.read) meta.appendChild($('span', 'dshp-report-dot'))
      meta.append($('span', null, mailTime(it.at) + ' · ' + it.title + (it.src ? ' · ' + it.src : '')))
      const text = $('div', 'dshp-report-text', it.body)
      const line = $('div', 'dshp-report-row')
      const readBtn = $('button', 'dshp-report-btn' + (it.read ? ' on' : ''), it.read ? '已阅 ✓' : '标记已阅')
      readBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        markItemRead(it)
        touchReport()
      })
      const del = $('button', 'dshp-report-btn del', '删除')
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        const idx = mail.items.indexOf(it)
        if (idx >= 0) mail.items.splice(idx, 1)
        if (!it.read) mail.unread = Math.max(0, mail.unread - 1)
        renderMail()
        try {
          clampPanels()
        } catch (err) {}
      })
      line.append(readBtn, del)
      row.append(meta, text, line)
      // 右上角的 × —— 快速移除这条
      const x = $('button', 'dshp-report-x', '×')
      x.title = '移除这条'
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        const idx = mail.items.indexOf(it)
        if (idx >= 0) mail.items.splice(idx, 1)
        if (!it.read) mail.unread = Math.max(0, mail.unread - 1)
        renderMail()
        try {
          clampPanels()
        } catch (err) {}
      })
      row.appendChild(x)
      mail.body.appendChild(row)
    })
  }

  // ——————————————————————————————————————————————————————————————
  // 八、鼠标交互：悬停 / 拖动 / 戳 / 右键 / 双击
  // ——————————————————————————————————————————————————————————————

  function wireInteractions() {
    const root = ui.root
    let dragging = false
    let dragMoved = false
    let start = null
    let leaveTimer = null
    const drag = { vx: 0, vy: 0 }

    document.addEventListener(
      'pointermove',
      (e) => {
        if (frameRateGovernor) frameRateGovernor.touch()
        if (!dragging) {
          // 主人反馈：「我鼠标往下走要去点那三个键，一离开她身上它们就消失了，点不着」。
          // 原因：原来只认 hitTest（她模型身上），而工具栏在她**下方**、不在模型掩码里。
          // 现在把「鼠标在工具栏矩形内」也算作悬停，并且离开后多留 900ms。
          const on = hitTest(e.clientX, e.clientY) || overDock(e.clientX, e.clientY)
          isPetHovered = !!on
          if (desktopRoamEngine && typeof desktopRoamEngine.setBlocked === 'function') {
            desktopRoamEngine.setBlocked(isSettingOrInteractionOpen(), 'hover')
          }
          if (dockAutoHide && overDock(e.clientX, e.clientY)) dockAutoHide.touch()
          if (on) {
            root.classList.add('dshp-hover')
            if (leaveTimer) {
              clearTimeout(leaveTimer)
              leaveTimer = null
            }
          } else if (!leaveTimer && !root.classList.contains('dshp-open')) {
            leaveTimer = setTimeout(() => {
              leaveTimer = null
              if (!root.classList.contains('dshp-open')) root.classList.remove('dshp-hover')
            }, 900)
          }
        } else if (start) {
          const dx = e.clientX - start.mx
          const dy = e.clientY - start.my
          if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true
          if (dragMoved) {
            const nh = root.getBoundingClientRect().height
            const nx = clamp(start.left + dx, -40, window.innerWidth - 60)
            // 竖直方向随便放，但别放到连底下三个按钮都被屏幕切掉
            const ny = clampY(start.top + dy, nh, window.innerHeight)
            // 身体随拖动方向摇摆：横向速度直接喂给身体的倾斜
            drag.vx = nx - (parseFloat(root.style.left) || nx)
            drag.vy = ny - (parseFloat(root.style.top) || ny)
            root.style.left = nx + 'px'
            root.style.top = ny + 'px'
            root.style.right = 'auto'
            root.style.bottom = 'auto'
            if (desktopRoamEngine && typeof desktopRoamEngine.onDragMove === 'function') {
              desktopRoamEngine.onDragMove(nx, ny)
            }
          }
        }
        // 只记录坐标，真正的跟随在 gazeTick 里限速执行——
        // 直接在 pointermove 里写 focusController 就是「螺旋桨」的成因。
        gaze.pointer.x = e.clientX
        gaze.pointer.y = e.clientY
        gaze.pointer.seen = true
        gaze.pointer.at = performance.now()   // 记时间：脱离跟随太久就回正脸
      },
      { passive: true },
    )

    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return
        if (!hitTest(e.clientX, e.clientY)) return
        // 点在鲸鱼娘身上：吃掉这次点击，别让下面的 DSH 界面也响应
        e.stopPropagation()
        e.preventDefault()
        if (dragInertiaRaf) {
          cancelAnimationFrame(dragInertiaRaf)
          dragInertiaRaf = 0
        }
        dragging = true
        isPetDragging = true
        dragMoved = false
        const r = root.getBoundingClientRect()
        if (desktopRoamEngine) {
          if (typeof desktopRoamEngine.onDragStart === 'function') {
            desktopRoamEngine.onDragStart(r.left, r.top)
          } else if (typeof desktopRoamEngine.setAnchor === 'function') {
            desktopRoamEngine.setAnchor(r.left, r.top)
          }
        }
        root.style.left = Math.round(r.left) + 'px'
        root.style.top = Math.round(r.top) + 'px'
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        if (springPhysics) springPhysics.press()
        if (dockAutoHide) dockAutoHide.show()
        if (frameRateGovernor) frameRateGovernor.touch()
        delete root.dataset.edge // 一拖就离开墙，别再显示「贴着左边」
        start = { mx: e.clientX, my: e.clientY, left: r.left, top: r.top }
      },
      true,
    )

    document.addEventListener(
      'pointerup',
      (e) => {
        if (springPhysics) springPhysics.release()
        if (frameRateGovernor) frameRateGovernor.touch()
        if (!dragging) return
        dragging = false
        isPetDragging = false
        if (dragMoved) {
          const r = root.getBoundingClientRect()
          if (desktopRoamEngine) {
            if (typeof desktopRoamEngine.onDragEnd === 'function') {
              desktopRoamEngine.onDragEnd(r.left, r.top)
            } else if (typeof desktopRoamEngine.setAnchor === 'function') {
              desktopRoamEngine.setAnchor(r.left, r.top)
            }
          }
          reportBoundsToShell()
          // 松手：先看要不要贴边吸附，没吸附上再走自由惯性
          if (!snapOnRelease()) dragInertia(drag.vx, drag.vy)
          drag.vx = 0
          drag.vy = 0
        } else {
          if (desktopRoamEngine && typeof desktopRoamEngine.onDragEnd === 'function') {
            const r = root.getBoundingClientRect()
            desktopRoamEngine.onDragEnd(r.left, r.top)
          }
          poke(e.clientX, e.clientY)
          if (dockAutoHide) dockAutoHide.show()
        }
        start = null
      },
      true,
    )

    document.addEventListener('pointercancel', () => {
      if (springPhysics) springPhysics.release()
      dragging = false
      isPetDragging = false
      if (desktopRoamEngine && typeof desktopRoamEngine.onDragEnd === 'function') {
        const r = root.getBoundingClientRect()
        desktopRoamEngine.onDragEnd(r.left, r.top)
      }
      start = null
    })

    document.addEventListener(
      'contextmenu',
      (e) => {
        if (!hitTest(e.clientX, e.clientY)) return
        e.preventDefault()
        e.stopPropagation()
        // 右键直接打开伴侣主菜单并聚焦在「角色」Tab
        if (ui.menu.el.classList.contains('dshp-on') && ui.menu.focused === 'character') {
          closePanels()
        } else {
          ui.menu.focused = 'character'
          if (ui.menu.tabs) {
            for (const el of ui.menu.tabs.children) {
              el.classList.toggle('dshp-active', el.dataset.tab === 'character')
            }
          }
          openMenu('menu')
        }
      },
      true,
    )

    document.addEventListener(
      'dblclick',
      (e) => {
        // 主人要求：输入框只从工具栏的「说话」按钮开，双击鱼身不再弹它。
        // 双击仍然算一次戳她（第一下 click 已经触发过了），这里只吃掉默认行为。
        if (!hitTest(e.clientX, e.clientY)) return
        e.preventDefault()
      },
      true,
    )

    window.addEventListener('resize', () => {
      fitModel()
      const layout = readLayout()
      // 贴着左/右墙的：重新贴住那一侧（竖直位置不变，只夹进可见范围）
      if (layout.edge === 'left' || layout.edge === 'right') {
        applyPosition(layout)
      } else if (root.style.left && root.style.left !== 'auto') {
        root.style.left = clamp(parseFloat(root.style.left) || 0, -40, window.innerWidth - 60) + 'px'
        root.style.top = clamp(parseFloat(root.style.top) || 0, -20, window.innerHeight - 60) + 'px'
      }
      clampPanels()
    })

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (hud.open) {
        e.stopPropagation()
        closeHud()
        return
      }
      if (!ui.root.classList.contains('dshp-open')) return
      e.stopPropagation()
      closePanels()
    })

    ui.tab.addEventListener('click', () => setHidden(false))

    // 面板内点击不要穿透到下面的界面
    for (const el of [ui.composer.el, ui.menu.el, ui.hud.el, ui.dock]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation())
    }

    // 鼠标停在 HUD 上时不要自动收（主人在看）
    ui.hud.el.addEventListener('pointerenter', () => {
      hud.hover = true
      hud.hideAt = 0
    })
    ui.hud.el.addEventListener('pointerleave', () => {
      hud.hover = false
    })
    // 点 HUD 之外的任何地方就收起来（跟菜单一个规矩）
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!hud.open) return
        if (e.button !== 0) return // 右键不在这里处理，交给 contextmenu 做「再按一次收起」
        const t = e.target
        if (t && (t === ui.hud.el || ui.hud.el.contains(t))) return
        closeHud()
      },
      true,
    )

    // 点面板以外任何地方（含 DSH 界面、甚至桌宠自己身上）都收起面板
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!ui.root.classList.contains('dshp-open')) return
        const t = e.target
        if (t && (t === ui.root || ui.root.contains(t))) return
        if (t && ui.menu.el.contains(t)) return
        if (t && ui.composer.el.contains(t)) return
        closePanels()
      },
      true,
    )
  }

  /**
   * 戳她。
   *
   * 之前的问题：身体被戳走的是「晕晕」这种不对味的脸（用户说「别闹应该是可爱地生气」），
   * 而且反应池太窄。现在按人设来——傲娇嘴甜、嘴上嫌弃、其实很开心；
   * 另外加了连击（短时间戳很多下会炸毛）和「摸头/戳腰」分区。
   */
  const pokeState = { times: [], softAt: 0, angerAt: 0 }

  /**
   * 连点分档 —— 主人第二次抱怨「平常点几下就生气了，不好玩」。
   *
   * 旧代码的判定是「和上一次点击间隔 < 1.8 秒就累加」，于是每 1.5 秒点一下，
   * 点到第三下照样炸毛，正常逗她玩也会被凶。
   *
   * 现在改成真正的**速率**判定：看 2.6 秒里点了几下、平均间隔多少。
   *   · 慢悠悠地戳（平均间隔 > 420ms，也就是慢于 2.4 下/秒）→ 永远只是可爱反应；
   *   · 快到 2.4 下/秒以上，才「被戳痒了」撒娇抗议（ticklish），仍然不是生气；
   *   · 只有手速党（3.8 下/秒以上、窗口内至少 7 下）才真炸毛，而且炸毛后有
   *     6 秒冷静期，免得一直凶主人。
   */
  const POKE_TIER = {
    window: 2600, // 统计窗口（毫秒）
    softCount: 4, // 窗口内至少 4 下
    softGap: 420, // 且平均间隔 ≤ 420ms → 痒得抗议（≈2.4 下/秒）
    hardCount: 7, // 窗口内至少 7 下
    hardGap: 260, // 且平均间隔 ≤ 260ms → 真炸毛（≈3.8 下/秒）
    softCool: 1500, // 撒娇抗议之间的最小间隔，免得刷屏
    angerCool: 6000, // 炸毛之后的冷静期
  }

  /**
   * 记一次点击，并把滑出窗口的旧记录丢掉。
   * 时间戳是滑动窗口，所以慢慢点的话旧记录会自己过期，永远攒不到炸毛。
   */
  function pokeRecord(now) {
    const t = pokeState.times
    t.push(now)
    if (t.length > 60) t.splice(0, t.length - 60)
    pokePrune(now)
  }

  function pokePrune(now) {
    const t = pokeState.times
    while (t.length && now - t[0] > POKE_TIER.window) t.shift()
  }

  /** 纯函数：由「几下 / 平均间隔 / 距上次炸毛多久」判断档位。测试也用它。 */
  function tierOf(count, gap, sinceAnger) {
    const T = POKE_TIER
    const rapid = count >= T.softCount && gap <= T.softGap
    const furious = rapid && count >= T.hardCount && gap <= T.hardGap && sinceAnger > T.angerCool
    return { count, gap: gap === Infinity ? null : Math.round(gap), rapid, furious }
  }

  /** 现在的手速处在哪一档。只读，不改记录（诊断接口也调它）。 */
  function pokeTier(now) {
    const at = now || performance.now()
    pokePrune(at)
    const t = pokeState.times
    const count = t.length
    const gap = count >= 2 ? (t[count - 1] - t[0]) / (count - 1) : Infinity
    return tierOf(count, gap, at - pokeState.angerAt)
  }

  /**
   * 纯计算版：给一串「相邻两次点击的间隔」（毫秒），算出落哪一档。
   * 测试专门用它证明「正常速度点一万下也不会生气」。
   */
  function pokeTierForGaps(gaps) {
    const T = POKE_TIER
    const times = []
    let t = 0
    times.push(t)
    for (const g of gaps) {
      t += g
      times.push(t)
    }
    let count = 0
    let sum = 0
    for (let i = times.length - 1; i >= 0; i--) {
      if (t - times[i] > T.window) break
      count++
    }
    const from = times.length - count
    sum = count >= 2 ? t - times[from] : 0
    const gap = count >= 2 ? sum / (count - 1) : Infinity
    return tierOf(count, gap, Infinity)
  }

  /**
   * 点击互动表。
   *
   * 主人定的规矩：
   *   · **每个特效配它自己那套台词**，台词贴人设（傲娇嘴甜、贪吃白米、不能被叫胖）
   *   · 一次点击最多 1~2 个效果，绝不叠一堆
   *   · 连着点不重复（pickFresh 记着上一次），所以点十下能看到十种不同反应
   *   · 已踢掉：吹泡泡糖、大锤砸头、猫爪摆手、呆眼、圈圈眼
   */
  /** 干活时被点的互动池：还是傲娇那套，但带一点「人家在忙啦」。 */
  const POKE_BUSY = [
    { mood: 'pout', w: 1.4, lines: ['别闹啦，人家在忙', '等一下下嘛', '（嘴上嫌弃，手上没停）', '手拿开啦，正忙着呢', '（一边躲一边继续敲）'] },
    { mood: 'grumpy', w: 0.4, lines: ['主人！人家正在忙', '再戳就做不完了哦', '（气鼓鼓地继续干活）'] },
    { mood: 'shy', w: 1.2, lines: ['唔…等我弄完再说', '（被戳得晃了一下，又低头看本子）', '（耳朵红了，但没抬头）'] },
    { mood: 'happy', w: 1.2, lines: ['知道啦知道啦', '（抬头笑一下，又埋头干活）', '在在在，人家听着呢'] },
    { mood: 'tongue', w: 1, lines: ['忙着呢，不理你', '略，等会儿再说', '（扭头继续干活）'] },
    { mood: 'alert', w: 0.6, lines: ['！（笔掉了）', '（慌忙扶住本子）', '吓人家一跳！'] },
    { mood: 'confused', w: 0.6, lines: ['嗯？主人有什么事吗', '（从本子上抬眼看你）'] },
  ]

  /**
   * 摸头池。只有「被叫胖」那一条是真生气的脸，而且权重压到 0.4——
   * 主人要的是「平常点它别老生气」，所以生气是彩蛋，不是常态。
   */
  const POKE_HEAD = [
    {
      mood: 'shy',
      w: 1.6,
      fx: 'heart',
      lines: ['不要突然摸头啦……再摸一下也不是不行。', '唔…头发要乱了啦', '（脸红）就、就一下哦', '哼，本鲸才没有很享受', '（尾巴尖偷偷晃了一下）'],
    },
    {
      mood: 'happy',
      w: 1.4,
      fx: null,
      lines: ['嘿嘿～主人', '嗯？叫人家吗', '在的在的', '摸摸头也不错嘛', '（眯着眼睛蹭了一下）', '主人今天好闲呀'],
    },
    {
      mood: 'love',
      w: 1,
      fx: 'heart',
      lines: ['最喜欢主人了', '（冒爱心）', '今天也最喜欢主人', '（踮脚）还要！', '要是再来碗白饭就更完美了'],
    },
    {
      mood: 'pout',
      w: 1,
      fx: null,
      lines: ['哼，就这一次哦', '才、才没有很开心', '别以为人家好哄', '（嘴上嫌弃，头却没躲）', '手、手洗了吗'],
    },
    {
      mood: 'excited',
      w: 1,
      fx: null,
      lines: ['主人主人！', '（眼睛发亮）', '怎么啦怎么啦', '是要给人家白饭吗！'],
    },
    {
      mood: 'tongue',
      w: 0.8,
      fx: null,
      lines: ['略略略', '就不理你', '（吐舌头）', '摸头要收费的，一碗白饭'],
    },
    {
      mood: 'smug',
      w: 0.8,
      fx: null,
      lines: ['（眯眼）主人手法还不错嘛', '再左边一点…对，就是那里', '哼，本鲸的头是不能乱摸的'],
    },
    {
      mood: 'confused',
      w: 0.7,
      fx: null,
      lines: ['唔？摸头有什么好处吗', '（歪头）今天怎么这么殷勤', '无事献殷勤…是不是有事求人家'],
    },
    {
      mood: 'sleepy',
      w: 0.4,
      fx: null,
      lines: ['唔…困……', '（被摸得眼睛都闭上了）', '再摸就睡着了哦'],
    },
    {
      mood: 'grumpy',
      w: 0.4,
      fx: null,
      lines: ['你再说一遍？！人家这是可爱，不是胖！', '本鲸是丰腴，不是胖'],
    },
  ]

  /** 戳身子池：全是可爱反应，没有生气的脸——生气只留给「手速党」。 */
  const POKE_BODY = [
    {
      mood: 'pout',
      w: 1.4,
      fx: null,
      lines: ['喂！别戳人家啦', '喂喂，人家也是有尊严的', '再戳人家要咬人了哦', '（拍开你的手）'],
    },
    {
      mood: 'playful',
      w: 1.4,
      fx: null,
      lines: ['好痒…哈哈哈', '住手啦主人', '别闹别闹', '（扭来扭去躲）', '哈哈哈哈哈不行了'],
    },
    {
      mood: 'tongue',
      w: 1,
      fx: null,
      lines: ['略略略', '戳不到戳不到', '（灵活地闪开）'],
    },
    {
      mood: 'shy',
      w: 1,
      fx: null,
      lines: ['（缩成一团）', '唔…别戳那里', '（捂住脸）'],
    },
    {
      mood: 'confused',
      w: 1,
      fx: null,
      lines: ['诶？', '（歪头）干嘛呀', '主人你今天很闲嘛', '（一脸不解）'],
    },
    {
      mood: 'playful',
      w: 1.2,
      fx: null,
      lines: ['（用本子挡了一下）', '（抱着本子躲开）', '不给戳', '（拿本子当盾牌）'],
    },
    {
      mood: 'happy',
      w: 1.2,
      fx: null,
      lines: ['（被戳得晃了一下）', '嘻嘻', '（笑得肩膀一抖一抖）'],
    },
    {
      mood: 'alert',
      w: 0.6,
      fx: null,
      lines: ['！（猛地一抖）', '呀！吓死人家了', '（整个人弹了一下）'],
    },
    {
      mood: 'smug',
      w: 0.8,
      fx: null,
      lines: ['戳够了没呀', '（双手叉腰）就这点力气？', '本鲸可是很结实的'],
    },
    {
      mood: 'sweat',
      w: 0.5,
      fx: null,
      lines: ['（手忙脚乱地护住本子）', '别、别戳了，本子要掉了', '（冷汗）'],
    },
    {
      mood: 'gloomy',
      w: 0.4,
      fx: null,
      lines: ['（幽怨地看着你）', '……人家记住了', '（角落里长蘑菇）'],
    },
    {
      mood: 'pout',
      w: 0.6,
      fx: null,
      lines: ['别戳啦，人家只想要白饭', '（护住并不存在的碗）', '戳一下换一粒米，成交吗'],
    },
  ]

  // ==========================================
  // 八、面向对象点击互动体系 (OOP Tap Engine)
  // ==========================================

  /**
   * 动作标志语解析工具：剥离标志语提取语音口播纯文本，同时推断表情特效
   */
  class ActionCueParser {
    static extractSpeechText(raw) {
      if (!raw || typeof raw !== 'string') return ''
      let t = raw
        .replace(/（[^）]*）/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/【[^】]*】/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\*[^*]*\*/g, '')
        .trim()
      t = t.replace(/^[！!？?,，。.~～\s]+/, '').trim()
      return t
    }

    static parse(raw) {
      const speech = this.extractSpeechText(raw)
      const cues = []
      const re = /[（(【\[*](.*?)[）)】\]*]/g
      let m
      while ((m = re.exec(raw)) !== null) {
        if (m[1] && m[1].trim()) cues.push(m[1].trim())
      }
      let mood = null
      let heart = false
      const allCues = cues.join(' ')
      if (/脸红|害羞|羞/.test(allCues)) mood = 'shy'
      else if (/爱心|喜欢|心跳/.test(allCues)) { mood = 'love'; heart = true }
      else if (/笑|嘿嘿|嘻嘻|高兴/.test(allCues)) mood = 'happy'
      else if (/炸毛|生气|哼|噘嘴|撅嘴|气/.test(allCues)) mood = 'grumpy'
      else if (/傲娇|眯眼|得意/.test(allCues)) mood = 'smug'
      else if (/哭|眼泪|呜/.test(allCues)) mood = 'cry'
      else if (/躲|跑|闪|跳|缩/.test(allCues)) mood = 'playful'
      else if (/愣|诶|问号|歪头|疑惑/.test(allCues)) mood = 'confused'
      else if (/惊|吓/.test(allCues)) mood = 'alert'
      else if (/困|哈欠|睡/.test(allCues)) mood = 'sleepy'

      return {
        raw,
        bubbleText: raw,
        speechText: speech,
        cues,
        mood,
        heart,
      }
    }
  }

  /**
   * 父类 / 标准基准对象：WhaleStandardTapProfile (鲸鱼娘标准原型，只读保护)
   * 封装核心算法：区域检测、连点手速分级、动作标志语分离、气泡动作演出与 TTS 播报
   */
  class WhaleStandardTapProfile {
    constructor(characterId = 'whale', charName = '深海鲸鱼娘') {
      this.characterId = characterId
      this.charName = charName
      this.isReadonlyStandard = true
    }

    getStorageKey() {
      return 'dshp_custom_tap_lines_' + this.characterId
    }

    loadCustomLines() {
      try {
        const s = localStorage.getItem(this.getStorageKey())
        return s ? JSON.parse(s) : []
      } catch (e) {
        return []
      }
    }

    saveCustomLines(lines) {
      try {
        localStorage.setItem(this.getStorageKey(), JSON.stringify(lines))
      } catch (e) {}
    }

    addCustomLine(zone, text, mood) {
      const list = this.loadCustomLines()
      const item = {
        id: 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        zone: zone || 'head',
        text: text.trim(),
        mood: mood || null,
        custom: true,
      }
      list.unshift(item)
      this.saveCustomLines(list)
      return item
    }

    deleteCustomLine(id) {
      let list = this.loadCustomLines()
      list = list.filter((x) => x.id !== id)
      this.saveCustomLines(list)
      return list
    }

    // 鲸鱼娘 8 条标准代表作（作为标准对象封存保护）
    getDefaultLines() {
      return [
        { zone: 'head', text: '（脸红）不要突然摸头啦……再摸一下也不是不行。', mood: 'shy', fx: 'heart' },
        { zone: 'head', text: '（眯眼）主人手法还不错嘛，再左边一点…对，就是那里~', mood: 'smug' },
        { zone: 'head', text: '（冒爱心）最喜欢主人了！要是再来碗白饭就更完美了。', mood: 'love', fx: 'heart' },
        { zone: 'body', text: '喂！别戳人家啦，本鲸也是有尊严的！', mood: 'pout' },
        { zone: 'body', text: '（扭来扭去躲）好痒…哈哈哈！住手啦主人~', mood: 'playful' },
        { zone: 'body', text: '（用本子挡住）不给戳！戳一下换一粒白米，成交吗？', mood: 'playful' },
        { zone: 'body', text: '（躲到角落）喂喂喂，手速这么快，人家要抗议了哦！', mood: 'alert' },
        { zone: 'body', text: '（炸毛）够啦够啦！再戳人家真的要咬你了哦！', mood: 'grumpy' },
      ]
    }

    getAllLines() {
      return [...this.getDefaultLines(), ...this.loadCustomLines()]
    }

    getThinkingLines() {
      return [
        '（咬着笔杆）让人家想想，这个问题该怎么解决呢…',
        '（敲了敲小脑瓜）嗯…这里得仔细捋一捋思路。',
        '（托腮沉思）别催别催，本鲸就快想出来啦！',
        '（灵光一闪）呼呼，让本鲸的大脑飞速运转一下~',
      ]
    }

    getReadingLines() {
      return [
        '（凑近看）这份资料人家得仔细看看。',
        '（推了推眼镜）待本鲸查阅一番相关档案…',
        '（认真翻阅）资料有点多呢，稍等本鲸一下下哦~',
        '（目不转睛）正在全神贯注阅读参考文档中…',
      ]
    }

    pickThinkingLine() {
      const list = this.getThinkingLines()
      return pickFresh(list, `${this.characterId}-thinking`)
    }

    pickReadingLine() {
      const list = this.getReadingLines()
      return pickFresh(list, `${this.characterId}-reading`)
    }

    triggerThinkingLine() {
      const line = this.pickThinkingLine()
      const parsed = ActionCueParser.parse(line)
      act({
        mood: 'thinking',
        line: parsed.bubbleText,
        ms: 3000,
      })
      ui.bubble.note('思考中')
      if (CFG.sound !== false && parsed.speechText) {
        speakCharacterText(parsed.speechText, this.characterId)
      }
      return parsed
    }

    triggerReadingLine() {
      const line = this.pickReadingLine()
      const parsed = ActionCueParser.parse(line)
      act({
        mood: 'reading',
        line: parsed.bubbleText,
        ms: 3000,
      })
      ui.bubble.note('看资料')
      if (CFG.sound !== false && parsed.speechText) {
        speakCharacterText(parsed.speechText, this.characterId)
      }
      return parsed
    }

    // 演练或触发某一条台词
    triggerLine(item) {
      const parsed = ActionCueParser.parse(item.text)
      const mood = item.mood || parsed.mood || 'happy'
      const ms = 2600

      act({
        mood: mood,
        line: parsed.bubbleText,
        heart: item.fx === 'heart' || parsed.heart,
        ms: ms,
      })

      if (CFG.tapVoice !== false && parsed.speechText) {
        speakCharacterText(parsed.speechText, this.characterId, { isTap: true })
      }
    }

    // 核心点击处理逻辑（由桌宠收到点击时委托调用）
    handlePoke(clientX, clientY, agentStatus) {
      // 立即在用户手势事件中唤醒 Web Audio 上下文，杜绝静默一段时间后的无声或延迟
      try {
        ensureAudioPipeline()
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {})
        }
      } catch (e) {}

      if (agentStatus !== 'idle') {
        closePanels()
        qBounce(1)
        gazeDetach(1800)
        gaze.biasTarget = 0
        const busyHit = pickFresh(POKE_BUSY, 'busy')
        const rawLine = pickFresh(busyHit.lines, 'busy-line-' + busyHit.mood)
        const parsed = ActionCueParser.parse(rawLine)
        act({ mood: busyHit.mood, line: parsed.bubbleText, ms: 2200 })
        if (CFG.tapVoice !== false && parsed.speechText) {
          speakCharacterText(parsed.speechText, this.characterId, { isTap: true })
        }
        return
      }

      const now = performance.now()
      pokeRecord(now)
      const tier = pokeTier(now)

      closePanels()
      wakeUp()
      qBounce(tier.furious ? 1.35 : tier.rapid ? 1.15 : 1)
      gazeDetach(2200)

      if (tier.furious) {
        pokeState.angerAt = now
        const face = pick(['grumpy', 'grumpy', 'alert', 'pout'])
        const line = pickFresh(SAY.many, 'many')
        const parsed = ActionCueParser.parse(line)
        act({ mood: face, props: IDLE_PROPS, line: parsed.bubbleText, ms: 2600 })
        if (CFG.tapVoice !== false && parsed.speechText) {
          speakCharacterText(parsed.speechText, this.characterId, { isTap: true })
        }
        return
      }

      if (tier.rapid && now - pokeState.softAt > POKE_TIER.softCool) {
        pokeState.softAt = now
        const face = pick(['pout', 'shy', 'tongue', 'alert'])
        const line = pickFresh(SAY.ticklish, 'ticklish')
        const parsed = ActionCueParser.parse(line)
        act({ mood: face, props: IDLE_PROPS, line: parsed.bubbleText, ms: 2400 })
        if (CFG.tapVoice !== false && parsed.speechText) {
          speakCharacterText(parsed.speechText, this.characterId, { isTap: true })
        }
        return
      }

      // 鲸鱼娘保留 12% 概率喷水动作
      if (this.characterId === 'whale' && Math.random() < 0.12) {
        playAction('splash')
        return
      }

      // 区分摸头还是戳身子
      const r = ui.stage.getBoundingClientRect()
      const isHead = (clientY - r.top) / Math.max(1, r.height) < 0.45
      const zone = isHead ? 'head' : 'body'

      // 获取当前角色可用词条（自定义词条与默认词条联合抽取）
      const pool = this.getAllLines().filter((x) => x.zone === zone)
      let selected = null
      if (pool.length > 0) {
        selected = pickFresh(pool, `${this.characterId}-${zone}`)
      }
      if (!selected) {
        const fallbackList = isHead ? POKE_HEAD : POKE_BODY
        const hit = pickFresh(fallbackList, zone)
        selected = {
          text: pickFresh(hit.lines, 'line-' + hit.mood),
          mood: hit.mood,
          fx: hit.fx,
        }
      }

      this.triggerLine(selected)
    }
  }

  /**
   * 兔兔子类 (TutuTapProfile - 娇羞灵动兔耳娘风格)
   */
  class TutuTapProfile extends WhaleStandardTapProfile {
    constructor() {
      super('tutu', '兔兔')
      this.isReadonlyStandard = false
    }

    getDefaultLines() {
      return [
        { zone: 'head', text: '（兔耳朵竖起）呀！主人摸得人家耳朵根好痒呀~', mood: 'shy', fx: 'heart' },
        { zone: 'head', text: '（眯眼蹭蹭）主人的手心好暖和，像晒太阳一样舒服呢。', mood: 'happy' },
        { zone: 'head', text: '（抱住长耳朵）别、别一直揉耳朵啦，等会儿都要揉红了…', mood: 'shy' },
        { zone: 'body', text: '（轻快地跳开）嘻嘻，抓不到人家吧！兔兔可是跑得很快的~', mood: 'playful' },
        { zone: 'body', text: '（鼓起腮帮子）戳人家肚肚干嘛，里面可没有藏胡萝卜！', mood: 'pout' },
        { zone: 'body', text: '（两手护在胸前）唔…主人今天怎么总爱捉弄兔兔呀？', mood: 'confused' },
        { zone: 'body', text: '（尾巴紧张地抖了抖）呜哇！点太快啦，兔兔的小心脏要跳出来了！', mood: 'alert' },
        { zone: 'body', text: '（急得跺脚）不理主人了啦！除非拿甜甜的草莓来哄兔兔！', mood: 'grumpy' },
      ]
    }

    getThinkingLines() {
      return [
        '（晃了晃长耳朵）唔…兔兔的小脑袋正在高速思考中呢！',
        '（咬着胡萝卜发呆）让兔兔琢磨一下，该怎么帮主人办好这件事呢…',
        '（抓了抓耳朵）嗯…这里有点复杂，等兔兔想一想哦~',
        '（两耳竖起）嘘，兔兔正在捕捉灵感电波呢！',
      ]
    }

    getReadingLines() {
      return [
        '（趴在桌上看）哇，好多字呀，兔兔在认真看资料啦！',
        '（揉了揉眼睛）兔兔正在仔细核对资料细节哦，主人别着急~',
        '（一字一句读）唔…这段讲的是这个意思呀，兔兔都记下来啦！',
        '（凑近屏幕）正在帮主人看资料，兔兔超专注的！',
      ]
    }
  }

  /**
   * 西域舞女 / 玉玉子类 (YuyuTapProfile - 神秘优雅异域御姐风格)
   */
  class YuyuTapProfile extends WhaleStandardTapProfile {
    constructor() {
      super('yuyu', '玉玉')
      this.isReadonlyStandard = false
    }

    getDefaultLines() {
      return [
        { zone: 'head', text: '（轻摇金铃）主人的手，可真是越来越不老实了呢~', mood: 'smug', fx: 'heart' },
        { zone: 'head', text: '（低眉含笑）若想抚摸妾身的青丝，可得先为妾身倒一杯葡萄美酒哦。', mood: 'happy' },
        { zone: 'head', text: '（偏头凝视）怎么，看妾身看得出神了么？', mood: 'shy' },
        { zone: 'body', text: '（挽起水袖轻旋）别闹，这身西域轻纱可经不住主人这般戳弄~', mood: 'playful' },
        { zone: 'body', text: '（掩嘴轻笑）咯咯…主人若是闲得无聊，不如看妾身为您跳支胡旋舞？', mood: 'happy' },
        { zone: 'body', text: '（指尖轻点薄纱）想要触碰妾身，可没有那么容易呢。', mood: 'smug' },
        { zone: 'body', text: '（灵巧闪身）步法这般急躁，在西域可是会踏错舞步的哟。', mood: 'alert' },
        { zone: 'body', text: '（杏眼微嗔）再这般放肆地乱点，妾身可要用金铃红绫将您绑起来了~', mood: 'grumpy' },
      ]
    }

    getThinkingLines() {
      return [
        '（指尖轻点朱唇）容妾身细细思量一番…',
        '（轻摇金铃沉吟）世间万事皆有其理，容妾身推演一二。',
        '（低眉沉思）主人莫急，妙计往往藏于静思之间。',
        '（轻拂面纱）妾身心中已有几分计较了呢。',
      ]
    }

    getReadingLines() {
      return [
        '（素手轻翻卷轴）这卷密函与文书，且让妾身为您阅览。',
        '（凝眸细读）纸上墨迹如行云流水，妾身已然明了。',
        '（以袖遮面翻看）这些资料颇有乾坤，待妾身为您甄别。',
        '（微启朱唇轻诵）正阅览卷宗呢，主人稍候片刻。',
      ]
    }
  }

  /**
   * 小小 / 冰冰龙子类 (XiaoxiaoTapProfile - 呆萌幼态治愈小龙女风格)
   */
  class XiaoxiaoTapProfile extends WhaleStandardTapProfile {
    constructor() {
      super('xiaoxiao', '小小')
      this.isReadonlyStandard = false
    }

    getDefaultLines() {
      return [
        { zone: 'head', text: '（晃了晃小龙角）嗷呜~ 摸摸龙角会带来好运气的哦！', mood: 'excited', fx: 'heart' },
        { zone: 'head', text: '（舒服地眯起眼睛）呼噜噜…主人的摸摸最舒服了，小小还要！', mood: 'happy' },
        { zone: 'head', text: '（抱住小脑袋）唔…头发乱蓬蓬的了，主人要负责帮小小梳好！', mood: 'pout' },
        { zone: 'body', text: '（慌忙护住尾巴）呀！别拽小小的龙尾巴，那里很敏感的啦！', mood: 'alert' },
        { zone: 'body', text: '（歪头眨巴眼睛）主人戳小小一下，小小也要戳主人一下，扯平啦！', mood: 'playful' },
        { zone: 'body', text: '（打了个小哈欠）唔…小小刚睡醒呢，主人有带亮闪闪的宝石来吗？', mood: 'sleepy' },
        { zone: 'body', text: '（抱着尾巴团成一团）哇啊！点得太急了，小小要被点晕倒啦！', mood: 'alert' },
        { zone: 'body', text: '（张牙舞爪）超凶的嗷呜！小小可是巨龙，再戳小小就喷小火苗了哦！', mood: 'grumpy' },
      ]
    }

    getThinkingLines() {
      return [
        '（晃了晃小龙角）嗷呜…小小的龙角好像在接收智慧信号呢！',
        '（抱住小脑袋）唔…小小的小脑瓜正在用力转动中！',
        '（掰着小手指）一加一等于几呢…等小小算清楚再告诉主人！',
        '（眨巴大眼睛）主人等一下，小小马上就想明白了！',
      ]
    }

    getReadingLines() {
      return [
        '（小爪子划着字）哇，好多密密麻麻的字，小小在认真看呢！',
        '（趴在资料上）小小正在帮主人寻宝查资料哦，呼呼~',
        '（摇晃小尾巴）小小已经看了一大半啦，马上看完！',
        '（认真指读）一个字也不漏掉，小小的眼睛超厉害的！',
      ]
    }
  }

  /**
   * 可可 / 元气女仆子类 (KekeTapProfile - 贴心干练忠诚女仆风格)
   */
  class KekeTapProfile extends WhaleStandardTapProfile {
    constructor() {
      super('keke', '可可')
      this.isReadonlyStandard = false
    }

    getDefaultLines() {
      return [
        { zone: 'head', text: '（提起女仆裙摆行礼）主人辛苦了，可可随时听候您的吩咐~', mood: 'happy', fx: 'heart' },
        { zone: 'head', text: '（脸颊微微泛红）工作时间被主人摸头…女仆守则里可没有写这一条呢。', mood: 'shy' },
        { zone: 'head', text: '（温柔微笑）只要能让主人感到放松，可可愿意一直陪在您身边。', mood: 'love', fx: 'heart' },
        { zone: 'body', text: '（整理围裙带子）主人，请不要在工作时间捉弄女仆哦。', mood: 'pout' },
        { zone: 'body', text: '（端出托盘）主人是不是口渴了？要为您泡一杯新鲜的大吉岭红茶吗？', mood: 'happy' },
        { zone: 'body', text: '（挺直腰杆）可可是一流的女仆，这点小触碰是动摇不了可可的！', mood: 'smug' },
        { zone: 'body', text: '（有些手忙脚乱）主、主人！红茶差点都要洒出来了啦！', mood: 'alert' },
        { zone: 'body', text: '（无奈地叹了口气）真是拿主人没办法…再闹的话，今天晚餐就要取消甜点了哦！', mood: 'grumpy' },
      ]
    }

    getThinkingLines() {
      return [
        '（扶正女仆发带）主人请放心，女仆可可正在为您周全规划！',
        '（托着托盘思索）如何以最完美的方式完成任务呢…可可正在思考！',
        '（歪头想了想）嗯…按照管家手册，这里需要精细处理呢。',
        '（眼神坚定）主人稍候，可可马上得出最佳方案！',
      ]
    }

    getReadingLines() {
      return [
        '（认真翻阅笔记）可可正在核查主人的备忘与文档！',
        '（推了推平光镜）资料已送达，身为女仆必须严谨查对！',
        '（一页页比对）正在为主人检索关键信息，请稍候片刻。',
        '（双手捧着资料）主人吩咐的文件，可可正在全力审阅中！',
      ]
    }
  }

  /**
   * 通用自定义角色子类 (CustomCharacterTapProfile - 导入角色通用继承)
   */
  class CustomCharacterTapProfile extends WhaleStandardTapProfile {
    constructor(charId, charName) {
      super(charId, charName)
      this.isReadonlyStandard = false
    }

    getDefaultLines() {
      return [
        { zone: 'head', text: `（轻轻歪头）主人，今天有什么任务交给${this.charName}吗？`, mood: 'happy' },
        { zone: 'head', text: '（舒服地眯起眼睛）主人的手好温柔呀，很喜欢这种感觉~', mood: 'shy', fx: 'heart' },
        { zone: 'head', text: '嘿嘿，被主人摸头感觉充满了力量呢！', mood: 'excited' },
        { zone: 'body', text: '（轻轻躲闪）别戳啦，有点痒痒的呢~', mood: 'playful' },
        { zone: 'body', text: '在的在的！一直都在主人身边陪着您呢。', mood: 'happy' },
        { zone: 'body', text: '（捂住胸口）呀，突然点人家，吓了一跳呢！', mood: 'alert' },
        { zone: 'body', text: '（转了个圈）点得这么快，主人今天心情看起来很不错嘛？', mood: 'playful' },
        { zone: 'body', text: '（鼓起腮帮子）再一直戳的话，人家也是会小小地抗议一下的哦！', mood: 'pout' },
      ]
    }

    getThinkingLines() {
      return [
        `（托腮思考）${this.charName}正在认真思考中，马上就好~`,
        `（灵光一闪）让${this.charName}理清思路，很快为您解答！`,
        `（认真思索）正在组织语言和逻辑，请稍候片刻哦。`,
      ]
    }

    getReadingLines() {
      return [
        `（专注查阅）${this.charName}正在仔细阅读参考资料！`,
        `（翻阅文档）正在为您核对相关文档与信息。`,
        `（目不转睛）资料很多，${this.charName}正在全神贯注研读中。`,
      ]
    }
  }

  /**
   * 工厂单例注册表 (TapProfileRegistry)
   */
  class TapProfileRegistry {
    static _instances = new Map()

    static get(charId = activeCharacterId) {
      if (!this._instances.has(charId)) {
        let inst
        switch (charId) {
          case 'whale':
            inst = new WhaleStandardTapProfile()
            break
          case 'tutu':
            inst = new TutuTapProfile()
            break
          case 'yuyu':
            inst = new YuyuTapProfile()
            break
          case 'xiaoxiao':
            inst = new XiaoxiaoTapProfile()
            break
          case 'keke':
            inst = new KekeTapProfile()
            break
          default:
            const charName = (CHARACTERS[charId] && CHARACTERS[charId].name) || charId
            inst = new CustomCharacterTapProfile(charId, charName)
            break
        }
        this._instances.set(charId, inst)
      }
      return this._instances.get(charId)
    }
  }

  function poke(clientX, clientY) {
    if (ui.root.classList.contains('dshp-hidden') || switchingCharId) return
    const profile = TapProfileRegistry.get(activeCharacterId)
    profile.handlePoke(clientX, clientY, agent.status)
  }

  // ——————————————————————————————————————————————————————————————
  // 八点五、菜单项「点了会怎样」
  // ——————————————————————————————————————————————————————————————

  /** 表情参数名 → 菜单里那个中文按钮名（同一个表情可能对应好几个情绪）。 */
  function faceLabel(expr) {
    if (!expr) return '平常脸'
    for (const [key, e] of Object.entries(MOOD_FACE)) {
      if (e === expr && FACE_ACT[key]) return expr
    }
    return expr
  }

  /** 菜单顶上的「现在是什么状态」——免得主人不知道当前挂着什么。 */
  function menuStatusLine() {
    const parts = []
    parts.push(rig.user.face ? `${rig.user.face}（手动）` : faceLabel(rig.face))
    const userProps = Array.from(rig.userProps)
      .map((e) => Object.values(ALL_TOGGLES).find((d) => d.expr === e))
      .filter(Boolean)
      .map((d) => d.label)
    const baseProps = rig.base.props
      .map((e) => Object.values(ALL_TOGGLES).find((d) => d.expr === e))
      .filter(Boolean)
      .map((d) => d.label)
    if (userProps.length) parts.push('自己戴的：' + userProps.join('、'))
    if (baseProps.length) parts.push('常态：' + baseProps.join(' + '))
    if (device.out) parts.push('手机已掏出')
    const st = agent.status === 'idle' ? '待机' : '干活中'
    return `${st} · 现在：` + parts.join(' · ')
  }

  /**
   * 演一个菜单项。
   *
   * 主人抱怨「点了没用、就卡在那」——所以菜单里每一项都不是「只是亮起来」，
   * 而是**一句话 + 一个表情 +（最多）一个小道具**，而且：
   *   · act() 先把上一次整个收掉 → 永远只有一件在演，不叠
   *   · 给一个到点就过期的 TTL → 不会卡住
   *   · 台词只在真的说了话的时候才占用气泡，不会连点刷屏
   */
  function playItem(kind, key) {
    const table = kind === 'face' ? FACE_ACT : kind === 'decor' ? PROP_ACT : SCENE_ACT
    const info = (table && table[key]) || {}
    const lines = info.lines || (SAY[key] ? SAY[key] : null)
    const line = lines && lines.length ? pickFresh(lines, kind + '-' + key) : undefined
    const mood = info.mood || (kind === 'face' ? key : 'happy')
    // 菜单表情是临时的：3.6 秒（主人说的「三四秒、反正会被覆盖掉」）
    const ms = info.ms || (kind === 'face' ? 3600 : 3200)
    if (info.lean) {
      // 低头看本子（眼镜类的「仔细看看」）。空闲兜底会把它复位，不会留后遗症。
      gaze.biasTarget = -0.3
      setTimeout(() => {
        if (!rig.override) gaze.biasTarget = 0
      }, ms + 400)
    }
    // 装饰/场景的开关本身由 setProp 负责（那一层是「一直存在」），
    // 这里只负责「她说点什么 + 换个配得上的表情」。
    return act({ mood, line, props: IDLE_PROPS, heart: !!info.heart, ms })
  }

  /**
   * 演一个一次性动作（猫爪、比耶、心跳、蛋包饭…）。
   *
   * 关键区别：**动作只走 override 层**（act 的 TTL 到期就没了），
   * 绝不写进 rig.userProps，所以不会像装饰品/场景那样一直挂着。
   * 「蛋包饭挤完酱就消失」就是靠这个——表达式蛋包饭 + 挤番茄酱动作，
   * 到点一起收走。
   */
  function playAction(key) {
    const a = ACTIONS[key]
    if (!a) return 0
    // 前置模式（照原作者的设计：自拍类得先掏出手机）
    if (a.requires) {
      const need = ALL_TOGGLES[a.requires]
      if (need && need.device) takeDeviceOut()
      else setProp(a.requires, true)
    }
    const expr = a.expr && EXPR[a.expr] ? a.expr : null
    const motion = a.motion && manifest && manifest.motions && manifest.motions[a.motion] ? a.motion : undefined
    // mood === null 的动作（自带表情变化的动画）**不压自己的脸**：
    // 压上去就是「冲突/覆盖」，会把她动画里的表情盖掉。
    const noFace = a.mood === null
    return act({
      mood: noFace ? 'neutral' : a.mood || 'happy',
      face: noFace && !expr ? null : undefined,
      props: expr ? IDLE_PROPS.concat([expr]) : IDLE_PROPS,
      line: pickFresh(a.lines, 'action-' + key),
      heart: !!a.heart,
      motion,
      ms: a.ms || 3000,
    })
  }

  // ——————————————————————————————————————————————————————————————
  // 八点七、HUD：余额 / 本轮消耗 / 峰谷计价
  // ——————————————————————————————————————————————————————————————
  //
  // 主人要的东西（原话）：右键不再是设置，而是一个醒目的框，里面要有
  //   · 剩余钱数
  //   · 每轮结束弹出「本轮消耗」
  //   · 现在是峰还是谷（**峰=红，谷=绿**）
  //   · 距离切换还有多久
  // 而且「不能跟对话冲突、优先级最高、盖在上面」。
  //
  // 数据来源不自己造：DSH 里装的 dsh-whale-widget 已经在做余额与记账，
  // 它把结果开成了同源接口，我们直接读（口径天然一致，不会两边算出不同数字）：
  //   GET /dsh-whale/balance.json     → {ok,totalBalance,currency,isPeak,peakNextChangeAt,todayUsage,...}
  //   GET /dsh-whale/last-turn.json   → {ok,seq,turn,amount,tokens,ts}
  // 没装那个插件时优雅降级：能显示的照常显示，显示不了的写「—」并说明原因。

  // 数据源优先级：
  //   1) 我们宿主自己的 /dsh-pet/hud —— 自带余额 + 峰谷 + 计价，不依赖任何别的插件
  //   2) dsh-whale-widget 的 /dsh-whale/* —— 装了它就用它的账本（口径统一，数字更好对账）
  const HUD_SELF = '/dsh-pet/hud'
  const HUD_SRC = {
    balance: '/dsh-whale/balance.json',
    lastTurn: '/dsh-whale/last-turn.json',
  }
  const hud = {
    open: false,
    data: null, // balance.json 的内容
    turn: null, // last-turn.json 的内容
    seq: 0, // 用 seq 判断「是不是新的一轮」
    err: '',
    tick: null, // 倒计时定时器
    hideAt: 0, // 自动弹出后多久自己收（鼠标悬停时暂停）
    hideTimer: null,
  }

  const money = (v, cur) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
    const sym = (cur || 'CNY') === 'CNY' ? '¥' : (cur || '') + ' '
    return sym + Number(v).toFixed(2)
  }

  /** 距切换还有多久：写成人能读的「3 小时 12 分」。 */
  function humanLeft(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '即将切换'
    const h = Math.floor(sec / 3600)
    const m = Math.round((sec % 3600) / 60)
    if (h <= 0) return m + ' 分钟'
    return h + ' 小时 ' + (m < 10 ? '0' + m : m) + ' 分'
  }

  function hudRender() {
    if (!ui || !ui.hud) return
    const h = ui.hud
    const d = hud.data || {}
    const peak = d.isPeak === true
    h.badge.textContent = d.isPeak === undefined || d.isPeak === null ? '—' : peak ? '峰' : '谷'
    h.badge.className = 'dshp-hud-tag ' + (peak ? 'dshp-peak' : 'dshp-valley')
    if (d.ok === false && d.code === 'NO_KEY') {
      h.money.textContent = '未配置'
      h.foot.textContent = '没读到 DEEPSEEK_API_KEY，所以看不到余额。\n在 DSH 里配好 key 就能显示。'
    } else if (d.ok === false) {
      h.money.textContent = '—'
    } else if (!hud.data) {
      h.money.textContent = '—'
    } else {
      h.money.textContent = money(d.totalBalance, d.currency)
      h.currency.textContent = d.currency || 'CNY'
    }
    h.today.textContent = d.todayUsage === undefined || d.todayUsage === null ? '—' : money(d.todayUsage, d.todayUsageCurrency || d.currency)

    // 本轮消耗：金额 + tokens
    const t = hud.turn || {}
    if (t.amount === undefined || t.amount === null) {
      h.turn.textContent = '—'
    } else {
      h.turn.textContent = money(t.amount, d.currency) + (t.tokens ? ' · ' + Number(t.tokens).toLocaleString() + ' tokens' : '')
    }

    // 倒计时：宿主给的切换时刻是权威（含周末/法定节假日规则）
    if (d.peakNextChangeAt) {
      const left = d.peakNextChangeAt - Math.floor(Date.now() / 1000)
      hud.left = left
      h.countdown.textContent = humanLeft(left)
    } else {
      h.countdown.textContent = '—'
    }

    const src = []
    if (!hud.source) src.push('数据：读不到余额接口')
    else if (hud.source === 'self') src.push('数据：桌宠自带记账' + (d.version ? ' v' + d.version : ''))
    else src.push('数据：dsh-whale-widget' + (d.version ? ' v' + d.version : ''))
    if (hud.err) src.push(hud.err)
    if (t.ts) src.push('本轮：' + new Date(t.ts).toLocaleTimeString('zh-CN', { hour12: false }))
    src.push(hud.fetchedAt ? '更新于 ' + new Date(hud.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '')
    h.foot.textContent = src.filter(Boolean).join('\n')
  }

  let hudLastForce = 0
  const grabJson = (url) =>
    fetch(url, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

  async function hudFetch(force) {
    // 节流：force 刷新 60 秒最多一次（右键连点不该反复打 DeepSeek 的余额接口）
    if (force && Date.now() - hudLastForce < 60000) force = false
    if (force) hudLastForce = Date.now()

    // 先问自己宿主：一条就够（余额 + 峰谷 + 本轮 + 今日）
    const self = await grabJson(HUD_SELF + (force ? '?refresh=1' : ''))
    if (self && self.ok) {
      hud.source = 'self'
      hud.err = ''
      hud.data = {
        ok: true,
        version: self.version,
        isPeak: self.isPeak,
        peakNextChangeAt: self.peakNextChangeAt,
        totalBalance: self.balance && self.balance.ok ? self.balance.totalBalance : undefined,
        currency: (self.balance && self.balance.currency) || 'CNY',
        todayUsage: self.today ? self.today.amount : undefined,
        todayUsageCurrency: (self.balance && self.balance.currency) || 'CNY',
      }
      if (self.balance && self.balance.ok === false) {
        hud.data.code = self.balance.code
        hud.data.errText = self.balance.error
      } else if (self.balance && self.balance.stale) {
        hud.err = '余额这次没刷新成功，显示的是上一次的数字'
      }
      if (self.turn) {
        hud.turn = { ok: true, seq: self.turn.seq, turn: self.turn.turn, amount: self.turn.amount, tokens: self.turn.tokens, ts: self.turn.ts }
        hud.seq = self.turn.seq || 0
      }
      hud.fetchedAt = Date.now()
      hudRender()
      return { self }
    }

    // 退回 dsh-whale-widget（装了就有，口径与挂件一致）
    const [bal, lt] = await Promise.all([grabJson(HUD_SRC.balance), grabJson(HUD_SRC.lastTurn)])
    hud.err = ''
    if (bal && bal.ok === true) {
      hud.source = 'widget'
      hud.data = bal
    } else if (bal && bal.ok === false) {
      hud.source = 'widget'
      hud.data = bal
    } else {
      hud.source = null
      hud.data = null
      hud.err = '余额读不到：宿主接口和 dsh-whale-widget 都没响应'
    }
    if (lt && lt.ok) {
      hud.turn = lt
      hud.seq = lt.seq || 0
    }
    hud.fetchedAt = Date.now()
    hudRender()
    return { bal, lt }
  }

  function hudTick() {
    if (!hud.open) return
    if (hud.left !== undefined && hud.data && hud.data.peakNextChangeAt) {
      hud.left = hud.data.peakNextChangeAt - Math.floor(Date.now() / 1000)
      ui.hud.countdown.textContent = humanLeft(hud.left)
      // 跨过切换点就重新拉一次（峰谷真的变了）
      if (hud.left <= 0 && !hud.reloading) {
        hud.reloading = true
        setTimeout(() => {
          hud.reloading = false
          hudFetch(true)
        }, 1500)
      }
    }
    // 自动弹出后到点自己收（鼠标在上面就不收，主人在看）
    if (hud.hideAt && Date.now() > hud.hideAt && !hud.hover) closeHud()
  }

  function openHud(opts) {
    opts = opts || {}
    if (!ui || !ui.hud) return
    closePanels() // 别和菜单/输入框叠在一起
    hud.open = true
    ui.hud.el.classList.add('dshp-on')
    if (opts.flash) {
      ui.hud.el.classList.remove('dshp-flash')
      void ui.hud.el.offsetWidth // 强制重排，让动画能重放
      ui.hud.el.classList.add('dshp-flash')
    }
    clampPanels()
    hudFetch(opts.refresh === true)
    if (!hud.tick) hud.tick = setInterval(hudTick, 1000)
    if (opts.autoHideMs) {
      hud.hideAt = Date.now() + opts.autoHideMs
    } else {
      hud.hideAt = 0
    }
  }

  function closeHud() {
    if (!ui || !ui.hud) return
    hud.open = false
    hud.hideAt = 0
    ui.hud.el.classList.remove('dshp-on', 'dshp-flash')
    if (hud.tick) {
      clearInterval(hud.tick)
      hud.tick = null
    }
  }

  /**
   * 一轮结束时弹出来（主人要的「本轮消耗都会在这弹出来」）。
   * 等 1.2 秒再弹：宿主的记账是收到事件后才落账的，太早拉会拿到上一轮的数。
   */
  function hudPopTurnEnd() {
    const before = hud.seq
    setTimeout(async () => {
      if (hud.open) {
        await hudFetch(false)
        return
      }
      // 主人要求：取消「每轮结束自动弹余额」——只在右键时才弹。
      // 这里仍然把账拉回来（右键打开时数字是新的），但**不自动开面板**。
      await hudFetch(false)
      // seq 没变说明账还没落，再补一次
      if (hud.seq === before) setTimeout(() => hudFetch(false), 1800)
    }, 1200)
  }

  // ——————————————————————————————————————————————————————————————
  // 九、输入框 / 菜单
  // ——————————————————————————————————————————————————————————————

  /**
   * 隐藏 / 恢复。
   *
   * 之前「隐藏之后再也找不回来」是因为小把手的显示条件写成了
   * `.dshp-root.dshp-hidden .dshp-tab`——把手挂在 body 上，不在 root 里，
   * 后代选择器永远匹配不到。现在改成 body 级类，并且收进这一个函数，
   * 保证「隐藏态」和「把手可见」永远同步。
   */
  /**
   * 桌面壳（macOS 原生 App）的桥。
   * 壳子启动时会在页面里设 window.__DSHPET_SHELL__ = true，并挂一个 dshpetshell 消息通道。
   * 有它的时候：① 收起/展开走消息，立刻响应，不用等轮询；
   *             ② 设置页多出「收起成悬浮小球」和「彻底关闭桌宠应用」。
   */
  const shell = {
    on: !!(
      window.__DSHPET_SHELL__ &&
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.dshpetshell
    ),
    post(msg) {
      try {
        window.webkit.messageHandlers.dshpetshell.postMessage(msg)
      } catch (e) {}
    },
  }

  function setHidden(hidden) {
    ui.root.classList.toggle('dshp-hidden', !!hidden)
    document.body.classList.toggle('dshp-pet-hidden', !!hidden)
    if (hidden) ui.bubble.hide()
    saveLayout({ hidden: !!hidden })
    if (shell.on) shell.post(hidden ? 'hidden' : 'shown')
  }

  /**
   * 一键重置所有状态：回到「平常脸 + 正常坐姿 + 手里本子和笔」。
   * 主人要的是「不管我刚才把哪个特效点出来了、或者它自己卡在什么状态，
   * 点一下就全回正常」。
   *
   * 主人报过的 bug：「工作模式下点了蛋包饭/手机就一直卡着，连一键重置都救不回来。」
   * 查出来的真凶有两个：
   *   1. 重置只清了三层状态，**没停干活轮播**（work.active 还是 true）——
   *      于是 9~14 秒后 workTick 又把底层状态推回「看资料 + 星星眼」，
   *      看起来就是「表情怎么都回不去」；
   * 现在补上了：重置 = 连干活轮播、小设备、所有道具层一起归零。
   */
  function resetEverything() {
    endWork() // 停干活轮播（否则几秒后底层状态又被推回工作脸）
    rig.userProps.clear()
    rig.user = { face: null, until: 0 }
    rig.override = null
    rig.burst = null
    rig.weight.clear()
    // 兜底：所有道具一层不留（万一以后有人加了新的道具层，这里也不会漏）
    for (const key of Object.keys(ALL_TOGGLES)) {
      const expr = propExpr(key)
      if (expr) rig.userProps.delete(expr)
    }
    rig.props = new Set()
    device.out = false
    agent.toolProp = null
    agent.hasStream = false
    agent.sleeping = false
    gaze.biasTarget = 0
    gaze.biasY = 0
    gaze.detachUntil = 0
    gaze.stepRate = 0
    gaze.driftX = 0
    gaze.driftY = 0
    gaze.tx = 0
    gaze.ty = 0
    rig.talking = false
    setBase('neutral', IDLE_PROPS)
    stopMotion() // 回到模型默认姿势 = 正常坐姿
    if (activeCharacterId === 'tutu' && coreModel) {
      try {
        coreModel.setParameterValueById('Param122', 0.0)
        coreModel.setParameterValueById('Param123', 1.0)
      } catch (e) {}
    }
    if (activeCharacterId !== 'whale') {
      resumeCharacterIdleMotion()
    }
    closePanels()
    ui.bubble.hide()
    setHidden(false)
    const keep = { height: readLayout().height || CFG.height }
    saveLayout({ props: [], fit: 'full', x: null, y: null, hidden: false, ...keep })
    for (const k of ['left', 'top', 'right', 'bottom']) ui.root.style[k] = ''
    fitModel()
    applyPosition(readLayout())
    return true
  }

  /** 给面板右上角加一个「×」——主人说之前不好关。 */
  function addCloseButton(panel, onClose) {
    const b = $('button', 'dshp-close', '×')
    b.title = '关闭'
    b.setAttribute('aria-label', '关闭')
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      // 以前不管哪个面板都去 closePanels()，于是「钱包」的 × 点了没反应
      // （钱包不是 closePanels 管的），主人报的「关闭键是坏的」就是这个。
      if (typeof onClose === 'function') onClose()
      else closePanels()
    })
    panel.appendChild(b)
  }

  function closePanels() {
    ui.composer.el.classList.remove('dshp-on')
    ui.menu.el.classList.remove('dshp-on')
    ui.root.classList.remove('dshp-open')
  }

  function bindComposer(u) {
    const { ta, send, cancel } = u.composer
    const stop = (e) => e.stopPropagation()
    for (const ev of ['keydown', 'keyup', 'keypress']) ta.addEventListener(ev, stop)
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        doSend()
      }
    })
    send.addEventListener('click', doSend)
    cancel.addEventListener('click', async () => {
      try {
        const j = await apiFetch(BASE + '/cancel', {
          method: 'POST',
          body: '{}',
        })
        u.bubble.show(j.ok ? '打断啦' : '打断失败：' + (j.error || '未知'), { name: activeCharInfo().name, ttl: 2000 })
      } catch (err) {
        u.bubble.show('打断失败：' + err.message, { name: activeCharInfo().name, ttl: 2600 })
      }
    })

    async function doSend() {
      const text = ta.value.trim()
      if (!text) {
        ta.focus()
        return
      }
      send.disabled = true
      try {
        const j = await apiFetch(BASE + '/say', {
          method: 'POST',
          body: JSON.stringify({ text }),
        })
        if (!j.ok) throw new Error(j.error || '发送失败')
        ta.value = ''
        closePanels()
        act({ mood: 'listening', props: IDLE_PROPS, line: text, ms: 2600 })
      } catch (err) {
        u.bubble.show('发不出去：' + err.message, { name: activeCharInfo().name, sticky: true })
      } finally {
        send.disabled = false
      }
    }
  }

  function openMenu(which) {
    closeHud() // 菜单和 HUD 不同时占屏幕
    ui.root.classList.add('dshp-open')
    // 立刻夹一次（getBoundingClientRect 会强制重排，拿到的是最终横向位置），
    // 再在下一帧补一次——只等 rAF 的话，测试/快照可能量到还没夹的面板
    clampPanels()
    // 面板是以模型为中心左右展开的，蹲在角落时右半边会跑到屏幕外——
    // 等布局落定后夹回视口内（关闭按钮和滑块必须点得到）
    requestAnimationFrame(() => clampPanels())
    // 气泡和面板都挂在桌宠上方，同时出现会互相挡住——开面板就把气泡收起来
    ui.bubble.hide()
    if (which === 'talk') {
      ui.menu.el.classList.remove('dshp-on')
      ui.composer.el.classList.add('dshp-on')
      setTimeout(() => ui.composer.ta.focus(), 60)
    } else {
      ui.composer.el.classList.remove('dshp-on')
      renderPane(ui.menu.focused || 'face')
      ui.menu.el.classList.add('dshp-on')
    }
    // 面板真正显示之后再夹一次（上面那次夹在 class 加之前，量不到它）
    clampPanels()
  }

  function updateMenuTabLabels() {
    if (!ui || !ui.menu || !ui.menu.tabs) return
    for (const b of ui.menu.tabs.children) {
      if (b.dataset.tab === 'face') {
        b.textContent = activeCharacterId === 'whale' ? '表情' : '表情映射'
      }
    }
  }

  function bindMenu(u) {
    const TABS = [
      ['character', '角色'],
      ['voice', '声音'],
      ['perception', '感知'],
      ['click', '点击'],
      ['face', '表情'],
      ['decor', '装饰'],
      ['scene', '场景'],
      ['action', '动作'],
      ['setting', '设置'],
      ['wallet', '钱包'],
    ]
    u.menu.focused = 'character'
    for (const [id, label] of TABS) {
      const b = $('button', 'dshp-tab-btn', label)
      b.dataset.tab = id
      if (id === u.menu.focused) b.classList.add('dshp-active')
      b.addEventListener('click', () => {
        u.menu.focused = id
        for (const el of u.menu.tabs.children) el.classList.toggle('dshp-active', el.dataset.tab === id)
        renderPane(id)
      })
      u.menu.tabs.appendChild(b)
    }
    updateMenuTabLabels()
    // 主人要求：说话按钮点一次开、再点一次关（以前再点只会重新打开，像关不掉）
    u.dock.children[0].addEventListener('click', () => {
      if (u.composer.el.classList.contains('dshp-on')) closePanels()
      else openMenu('talk')
    })
    u.dock.children[1].addEventListener('click', () => {
      if (u.menu.el.classList.contains('dshp-on')) closePanels()
      else openMenu('menu')
    })
    u.dock.children[2].addEventListener('click', () => {
      closePanels()
      setHidden(true)
    })
    // 第 4 个：打开 DeepSeek Harness。桌面壳里交给原生用默认浏览器打开，
    // 浏览器版直接新开一个标签页。
    u.dock.children[3].addEventListener('click', () => {
      if (shell.on) shell.post('open-dsh')
      else window.open(BASE.replace(/\/dsh-pet$/, '') + '/', '_blank')
    })
  }

  function renderPane(id) {
    const panes = ui.menu.panes
    panes.textContent = ''
    // 顶上永远有一行「她现在是什么状态」，免得一堆按钮里看不出哪个是开着的
    panes.appendChild($('div', 'dshp-hint dshp-now', menuStatusLine()))

    if (id === 'character') {
      const charBox = $('div', 'dshp-col')
      charBox.style.display = 'flex'
      charBox.style.flexDirection = 'column'
      charBox.style.gap = '10px'

      const title = $('div', 'dshp-hint', '当前伴侣：' + activeCharInfo().name + '（' + activeCharInfo().title + '）')
      title.style.fontWeight = 'bold'
      title.style.color = '#7c5cff'
      charBox.appendChild(title)

      const grid = $('div', 'dshp-grid')
      grid.style.display = 'grid'
      grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(130px, 1fr))'
      grid.style.gap = '8px'

      const builtins = ['whale', 'tutu', 'yuyu', 'xiaoxiao', 'keke']
      for (const [key, char] of Object.entries(CHARACTERS)) {
        const itemWrap = $('div')
        itemWrap.style.display = 'flex'
        itemWrap.style.alignItems = 'center'
        itemWrap.style.gap = '4px'
        itemWrap.style.width = '100%'

        const b = $('button', 'dshp-chip', char.name + ' · ' + (char.title || '伴侣'))
        b.style.flex = '1 1 0%'
        b.style.minWidth = '0'
        b.style.padding = '8px 6px'
        b.style.fontSize = '12px'
        b.style.textAlign = 'center'
        b.style.overflow = 'hidden'
        b.style.textOverflow = 'ellipsis'
        b.style.whiteSpace = 'nowrap'

        if (activeCharacterId === key) {
          b.classList.add('dshp-on')
          b.style.background = '#7c5cff'
          b.style.color = '#fff'
          b.style.fontWeight = 'bold'
        }
        b.addEventListener('click', async () => {
          await switchCharacter(key)
          renderPane('character')
        })
        itemWrap.appendChild(b)

        // 自定义导入角色支持删除
        if (!builtins.includes(key)) {
          const delBtn = $('button', 'dshp-btn', '🗑️')
          delBtn.style.padding = '6px 7px'
          delBtn.style.fontSize = '11px'
          delBtn.style.flexShrink = '0'
          delBtn.style.border = '1px solid rgba(255, 77, 79, 0.4)'
          delBtn.style.borderRadius = '6px'
          delBtn.style.background = 'rgba(255, 77, 79, 0.1)'
          delBtn.style.color = '#ff4d4f'
          delBtn.style.cursor = 'pointer'
          delBtn.title = `彻底删除伴侣「${char.name}」`
          delBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation()
            if (!confirm(`确定要彻底删除伴侣「${char.name}」吗？\n（将从伴侣库及磁盘中安全移除）`)) return
            delBtn.disabled = true
            delBtn.textContent = '⏳'
            try {
              const res = await apiFetch(BASE + '/delete-character', {
                method: 'POST',
                body: JSON.stringify({ characterId: key }),
              })
              if (!res.ok) {
                alert('删除失败: ' + (res.error || '未知错误'))
                delBtn.disabled = false
                delBtn.textContent = '🗑️'
                return
              }
              delete CHARACTERS[key]
              if (activeCharacterId === key) {
                await switchCharacter('tutu')
              }
              renderPane('character')
              ui.bubble.show(`伴侣「${char.name}」已安全删除~`, { duration: 3000 })
            } catch (err) {
              alert('删除异常: ' + ((err && err.message) || err))
              delBtn.disabled = false
              delBtn.textContent = '🗑️'
            }
          })
          itemWrap.appendChild(delBtn)
        }

        grid.appendChild(itemWrap)
      }
      charBox.appendChild(grid)

      if (activeCharacterId !== 'whale') {
        const mapShortcut = $('button', 'dshp-btn', `⚙ 配置 ${activeCharInfo().name} 的表情与动作映射`)
        mapShortcut.style.fontSize = '12px'
        mapShortcut.style.padding = '6px 12px'
        mapShortcut.style.marginTop = '4px'
        mapShortcut.style.alignSelf = 'flex-start'
        mapShortcut.addEventListener('click', () => {
          ui.menu.focused = 'face'
          for (const el of ui.menu.tabs.children) el.classList.toggle('dshp-active', el.dataset.tab === 'face')
          renderPane('face')
        })
        charBox.appendChild(mapShortcut)
      }

      // 导入新角色卡片
      const importCard = $('div', 'dshp-panel-card')
      importCard.style.marginTop = '12px'
      importCard.style.padding = '10px 12px'
      importCard.style.background = 'rgba(124, 92, 255, 0.08)'
      importCard.style.borderRadius = '10px'
      importCard.style.border = '1px dashed rgba(124, 92, 255, 0.4)'

      const cardHead = $('div', null, '➕ 导入新 Live2D 角色')
      cardHead.style.fontWeight = 'bold'
      cardHead.style.marginBottom = '6px'
      cardHead.style.fontSize = '13px'

      const pathInput = document.createElement('input')
      pathInput.type = 'text'
      pathInput.placeholder = '请输入模型文件夹路径 (含 .model3.json)'
      pathInput.style.width = '100%'
      pathInput.style.padding = '6px 8px'
      pathInput.style.marginBottom = '6px'
      pathInput.style.borderRadius = '6px'
      pathInput.style.border = '1px solid rgba(0,0,0,0.15)'
      pathInput.style.boxSizing = 'border-box'
      pathInput.style.fontSize = '12px'

      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.placeholder = '角色昵称 (如: 我的新伴侣)'
      nameInput.style.width = '100%'
      nameInput.style.padding = '6px 8px'
      nameInput.style.marginBottom = '8px'
      nameInput.style.borderRadius = '6px'
      nameInput.style.border = '1px solid rgba(0,0,0,0.15)'
      nameInput.style.boxSizing = 'border-box'
      nameInput.style.fontSize = '12px'

      const importBtn = $('button', 'dshp-btn dshp-primary', '一键导入并切换')
      importBtn.style.width = '100%'
      importBtn.style.padding = '7px'
      importBtn.style.background = '#7c5cff'
      importBtn.style.color = '#fff'
      importBtn.style.fontWeight = 'bold'
      importBtn.style.borderRadius = '6px'
      importBtn.style.cursor = 'pointer'

      const tipText = $('div', 'dshp-hint', '支持任意标准 Cubism 3/4 模型文件夹，导入后会自动加入角色库并即时挂载。')
      tipText.style.marginTop = '6px'
      tipText.style.fontSize = '11px'

      importBtn.addEventListener('click', async () => {
        const p = pathInput.value.trim()
        const n = nameInput.value.trim()
        if (!p) {
          alert('请先输入模型文件夹的绝对路径！')
          return
        }
        importBtn.textContent = '正在扫描并导入模型...'
        importBtn.disabled = true
        try {
          const data = await apiFetch(BASE + '/import-character', {
            method: 'POST',
            body: JSON.stringify({ sourcePath: p, name: n }),
          })
          if (!data.ok) {
            alert('导入失败: ' + (data.error || '未知错误'))
            importBtn.textContent = '一键导入并切换'
            importBtn.disabled = false
            return
          }
          const c = data.character
          CHARACTERS[c.id] = {
            id: c.id,
            name: c.name,
            title: (c.persona && c.persona.title) || c.title || c.name,
            modelUrl: BASE + '/characters/' + c.id + '/model/' + encodeURIComponent(c.modelFile),
            scale: c.scale || 0.25,
            defaultParams: c.defaultParams || {},
            expressions: c.expressions || {},
            motions: c.motions || {},
            categories: c.categories || {},
          }
          await switchCharacter(c.id)
          renderPane('character')
        } catch (err) {
          alert('导入异常: ' + ((err && err.message) || err))
          importBtn.textContent = '一键导入并切换'
          importBtn.disabled = false
        }
      })

      importCard.append(cardHead, pathInput, nameInput, importBtn, tipText)
      charBox.appendChild(importCard)
      panes.appendChild(charBox)
      return
    }


    if (id === 'voice') {
      const box = $('div', 'dshp-col')
      box.style.display = 'flex'
      box.style.flexDirection = 'column'
      box.style.gap = '10px'

      const statusTitle = $('div', 'dshp-hint', '当前伴侣：' + activeCharInfo().name + ' · ' + activeCharInfo().title)
      statusTitle.style.fontWeight = 'bold'
      statusTitle.style.color = '#7c5cff'

      // 1. 基础音效与口型开关
      const basicRow = $('div', 'dshp-row')
      basicRow.style.display = 'flex'
      basicRow.style.gap = '6px'

      const soundBtn = $('button', 'dshp-btn' + (CFG.sound ? ' dshp-primary' : ''), CFG.sound ? '🔊 伴侣语音：开启' : '🔈 伴侣语音：关闭')
      soundBtn.style.flex = '1'
      soundBtn.style.padding = '6px 10px'
      soundBtn.style.fontWeight = 'bold'

      const syncSoundBtnUI = (isOn) => {
        soundBtn.textContent = isOn ? '🔊 伴侣语音：开启' : '🔈 伴侣语音：关闭'
        soundBtn.classList.toggle('dshp-primary', !!isOn)
      }

      // 打开面板时主动探测后端 TTS 服务真实运行状态并同步按钮
      fetch(BASE + '/tts/status', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((st) => {
          if (st && typeof st.running === 'boolean') {
            if (CFG.sound && !st.running) {
              // 若配置为开启但服务未运行，自动拉起一次
              fetch(BASE + '/tts/start', { method: 'POST', credentials: 'include' }).catch(() => {})
            }
          }
        })
        .catch(() => {})

      soundBtn.addEventListener('click', async () => {
        if (soundBtn.disabled) return
        const targetOn = !CFG.sound
        soundBtn.disabled = true
        soundBtn.textContent = targetOn ? '⏳ 正在启动语音服务...' : '⏳ 正在关闭语音服务...'
        try {
          if (targetOn) {
            let started = false
            try {
              const r = await fetch(BASE + '/tts/start', { method: 'POST', credentials: 'include' })
              const d = r.ok ? await r.json().catch(() => ({})) : {}
              started = !!(d && d.running)
            } catch (e) {}
            if (!started) {
              try {
                const ping = await fetch('http://127.0.0.1:9880/ping')
                started = ping.ok
              } catch (e) {}
            }
            CFG.sound = true
            persistCfg()
            syncSoundBtnUI(true)
            ui.bubble.show(
              started ? '伴侣语音服务已启动，我会为你朗读互动哦~' : '伴侣语音已开启（后台服务正在唤醒中）~',
              { sticky: false, duration: 2500 },
            )
          } else {
            CFG.sound = false
            persistCfg()
            if (activeTtsAudio) {
              try {
                activeTtsAudio.pause()
                activeTtsAudio = null
              } catch (e) {}
              isSpeakingAudio = false
              rig.talking = false
            }
            try {
              await fetch(BASE + '/tts/stop', { method: 'POST', credentials: 'include' })
            } catch (e) {
              try {
                await fetch('http://127.0.0.1:9880/shutdown', { method: 'POST' })
              } catch (err) {}
            }
            syncSoundBtnUI(false)
            ui.bubble.show('伴侣语音已关闭，TTS 后端服务已停止。', { sticky: false, duration: 2500 })
          }
        } finally {
          soundBtn.disabled = false
        }
      })

      const mouthBtn = $('button', 'dshp-btn' + (CFG.talkMouth ? ' dshp-primary' : ''), CFG.talkMouth ? '👄 口型同步：开启' : '👄 口型同步：关闭')
      mouthBtn.style.flex = '1'
      mouthBtn.style.padding = '6px 10px'
      mouthBtn.addEventListener('click', () => {
        CFG.talkMouth = !CFG.talkMouth
        persistCfg()
        mouthBtn.textContent = CFG.talkMouth ? '👄 口型同步：开启' : '👄 口型同步：关闭'
        mouthBtn.classList.toggle('dshp-primary', CFG.talkMouth)
      })
      basicRow.append(soundBtn, mouthBtn)

      // 音量滑块
      const volLabel = $('label', 'dshp-label')
      volLabel.append($('span', null, '语音音量'))
      const volRange = document.createElement('input')
      volRange.type = 'range'
      volRange.min = '0'; volRange.max = '1'; volRange.step = '0.05'
      volRange.value = String(CFG.ttsVolume ?? 1.0)
      const volVal = $('span', null, Math.round(Number(volRange.value) * 100) + '%')
      volVal.style.minWidth = '36px'
      volVal.style.textAlign = 'right'
      volRange.addEventListener('input', () => {
        const val = Number(volRange.value)
        setAudioVolume(val)
        persistCfg()
        volVal.textContent = Math.round(val * 100) + '%'
      })
      volLabel.append(volRange, volVal)

      // 2. 🎵 示例音色库卡片（本地音色池）
      const SAMPLE_VOICE_CONFIGS = {
        '元气甜美_晓伊.wav': {
          voice_name: 'zh-CN-XiaoyiNeural',
          prompt: '元气甜美活泼少女，语调轻快',
          rate: '+5%',
          pitch: '+2Hz',
        },
        '冷艳御姐_晓妮.wav': {
          voice_name: 'zh-CN-XiaoniNeural',
          prompt: '冷艳成熟御姐，语调平静优雅带气场',
          rate: '-5%',
          pitch: '-2Hz',
        },
        '温柔治愈_晓晓.wav': {
          voice_name: 'zh-CN-XiaoxiaoNeural',
          prompt: '温柔治愈系大姐姐，语气柔和轻缓',
          rate: '-2%',
          pitch: '+0Hz',
        },
        '傲娇萌妹_晓伊.wav': {
          voice_name: 'zh-CN-XiaoyiNeural',
          prompt: '傲娇萌妹，有点小任性又很在乎主人',
          rate: '+8%',
          pitch: '+3Hz',
        },
        '沉稳知性_云健.wav': {
          voice_name: 'zh-CN-YunjianNeural',
          prompt: '沉稳知性青年，咬字清晰干练',
          rate: '+0%',
          pitch: '-2Hz',
        },
        '软萌台湾腔_晓臻.wav': {
          voice_name: 'zh-TW-HsiaoChenNeural',
          prompt: '软萌可爱的台湾腔调，亲切甜美',
          rate: '+2%',
          pitch: '+1Hz',
        },
        'tianmei_shaonv.wav': {
          voice_name: 'zh-CN-XiaoyiNeural',
          prompt: '甜美活泼少女，元气满满',
          rate: '+0%',
          pitch: '+0Hz',
        },
      }

      const poolCard = $('div', 'dshp-panel-card')
      poolCard.style.padding = '10px 12px'
      poolCard.style.background = 'rgba(255, 255, 255, 0.04)'
      poolCard.style.borderRadius = '10px'
      poolCard.style.border = '1px solid rgba(255, 255, 255, 0.12)'
      poolCard.style.display = 'flex'
      poolCard.style.flexDirection = 'column'
      poolCard.style.gap = '8px'

      const poolHeader = $('div', 'dshp-row')
      poolHeader.style.display = 'flex'
      poolHeader.style.justifyContent = 'space-between'
      poolHeader.style.alignItems = 'center'

      const poolTitle = $('div', null, '🎵 示例音色库（本地音色池）')
      poolTitle.style.fontWeight = 'bold'
      poolTitle.style.fontSize = '12px'
      poolTitle.style.color = '#72f1b8'

      const poolHeaderBtns = $('div')
      poolHeaderBtns.style.display = 'flex'
      poolHeaderBtns.style.gap = '4px'

      const restoreDefaultsBtn = $('button', 'dshp-btn', '⚡ 恢复官方全套')
      restoreDefaultsBtn.style.padding = '2px 6px'
      restoreDefaultsBtn.style.fontSize = '10px'
      restoreDefaultsBtn.title = '补齐或恢复官方 7 款标准示例音色'
      restoreDefaultsBtn.addEventListener('click', async () => {
        restoreDefaultsBtn.disabled = true
        restoreDefaultsBtn.textContent = '恢复中...'
        try {
          let ok = false
          try {
            const r1 = await apiFetch(BASE + '/init-default-samples', { method: 'POST' })
            if (r1 && r1.ok) ok = true
          } catch (e1) {}
          if (!ok) {
            try {
              const r2 = await fetch('http://127.0.0.1:9880/init-default-samples', { method: 'POST', mode: 'cors' })
              if (r2.ok) ok = true
            } catch (e2) {}
          }
          if (!ok) {
            try {
              const r3 = await fetch('http://127.0.0.1:9880/init-default-samples', { method: 'GET', mode: 'cors' })
              if (r3.ok) ok = true
            } catch (e3) {}
          }
          if (ok) {
            ui.bubble.show('官方全套示例音色已恢复！', { duration: 2500 })
            await loadVoicePool()
          } else {
            throw new Error('TTS 9880 服务或主服务未响应')
          }
        } catch (e) {
          alert('恢复失败: ' + e.message)
        } finally {
          restoreDefaultsBtn.disabled = false
          restoreDefaultsBtn.textContent = '⚡ 恢复官方全套'
        }
      })

      const refreshPoolBtn = $('button', 'dshp-btn', '🔄 刷新')
      refreshPoolBtn.style.padding = '2px 6px'
      refreshPoolBtn.style.fontSize = '10px'
      poolHeaderBtns.append(restoreDefaultsBtn, refreshPoolBtn)
      poolHeader.append(poolTitle, poolHeaderBtns)

      // 当前生效的角色音色状态指示条
      const activeVoiceStatus = $('div', 'dshp-hint')
      activeVoiceStatus.style.fontSize = '11px'
      activeVoiceStatus.style.padding = '4px 8px'
      activeVoiceStatus.style.background = 'rgba(114, 241, 184, 0.08)'
      activeVoiceStatus.style.borderRadius = '5px'
      activeVoiceStatus.style.border = '1px solid rgba(114, 241, 184, 0.2)'
      activeVoiceStatus.style.color = '#a3f7d2'
      function updateActiveVoiceBadge() {
        const cv = (activeCharInfo() && activeCharInfo().voice) || {}
        const refName = cv.referenceAudio ? cv.referenceAudio.split('/').pop() : ''
        const vDisplay = refName || cv.prompt || cv.voice_name || '默认晓晓'
        activeVoiceStatus.innerHTML = `当前伴侣发声音色：<b style="color:#fff;">${activeCharInfo().name}</b> · <span style="color:#72f1b8;">${vDisplay}</span> (${cv.rate || '+0%'}, ${cv.pitch || '+0Hz'})`
      }
      updateActiveVoiceBadge()

      // 快捷示例音键（移动到示例音色库中，点击直接发声试听并带动口型）
      const quickSampleHeader = $('div', 'dshp-hint', '🔊 点击示例音键直接试听：')
      quickSampleHeader.style.fontSize = '10.5px'
      quickSampleHeader.style.color = '#72f1b8'
      quickSampleHeader.style.marginTop = '2px'

      const quickSampleRow = $('div')
      quickSampleRow.style.display = 'flex'
      quickSampleRow.style.flexWrap = 'wrap'
      quickSampleRow.style.gap = '4px'

      const QUICK_SAMPLES = [
        ['✨ 元气甜美', '元气甜美_晓伊.wav'],
        ['✨ 冷艳御姐', '冷艳御姐_晓妮.wav'],
        ['✨ 温柔治愈', '温柔治愈_晓晓.wav'],
        ['✨ 傲娇萌妹', '傲娇萌妹_晓伊.wav'],
        ['✨ 沉稳知性', '沉稳知性_云健.wav'],
        ['✨ 软萌台湾腔', '软萌台湾腔_晓臻.wav'],
      ]
      for (const [tag, file] of QUICK_SAMPLES) {
        const chip = $('button', 'dshp-chip', tag)
        chip.style.fontSize = '10.5px'
        chip.style.padding = '3px 7px'
        chip.style.background = 'rgba(114, 241, 184, 0.12)'
        chip.style.border = '1px solid rgba(114, 241, 184, 0.3)'
        chip.style.color = '#a3f7d2'
        chip.title = `点击试听「${tag}」示例音频并驱动口型`
        chip.addEventListener('click', async () => {
          if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch (e) {} }
          if (audioCtx && audioCtx.state === 'suspended') { await audioCtx.resume().catch(() => {}) }
          ui.bubble.show(`正在试听「${tag}」示例声音... 可在下方列表直接点击「🌟 设为角色音」应用`, { duration: 3500 })
          await playAudioWithLipSync(file, { force: true })
        })
        quickSampleRow.appendChild(chip)
      }

      const poolList = $('div')
      poolList.style.display = 'flex'
      poolList.style.flexDirection = 'column'
      poolList.style.gap = '8px'
      poolList.style.maxHeight = '280px'
      poolList.style.overflowY = 'auto'
      poolList.style.paddingRight = '2px'

      const refAudioInput = document.createElement('input')
      refAudioInput.type = 'text'
      refAudioInput.placeholder = '参考音频相对路径 (如 voice_engine/voices_pool/...)'
      refAudioInput.value = (activeCharInfo().voice && activeCharInfo().voice.referenceAudio) || ''
      refAudioInput.style.width = '100%'
      refAudioInput.style.boxSizing = 'border-box'
      refAudioInput.style.fontSize = '11px'
      refAudioInput.style.padding = '4px 6px'
      refAudioInput.style.borderRadius = '4px'
      refAudioInput.style.background = '#1b1b1b'
      refAudioInput.style.color = '#ccc'
      refAudioInput.style.border = '1px solid #333'

      async function loadVoicePool() {
        poolList.innerHTML = '<div style="font-size:11px;color:#888;text-align:center;padding:12px;">正在加载示例音色池...</div>'
        try {
          let data = null
          try {
            data = await apiFetch(BASE + '/voices')
          } catch (e) {
            console.warn('[桌宠语音] 主应用获取音色列表异常，尝试直连 9880 端口:', e)
          }
          if (!data || !Array.isArray(data.localPool) || data.localPool.length === 0) {
            try {
              const pResp = await fetch('http://127.0.0.1:9880/voices_list')
              if (pResp.ok) {
                data = await pResp.json()
              }
            } catch (e2) {}
          }

          poolList.innerHTML = ''
          updateActiveVoiceBadge()
          const list = (data && data.localPool) || []
          if (list.length === 0) {
            const emptyEl = $('div')
            emptyEl.style.fontSize = '11px'
            emptyEl.style.color = '#888'
            emptyEl.style.textAlign = 'center'
            emptyEl.style.padding = '12px 4px'
            emptyEl.style.lineHeight = '1.6'
            emptyEl.innerHTML = '音色池暂无示例音频<br><span style="color:#666;font-size:10px;">可点击上方「⚡ 恢复官方全套」或在下方生成后点击「📥 保存为示例音」~</span>'
            poolList.appendChild(emptyEl)
            return
          }
          // 唯一确定当前伴侣生效的示例音频（杜绝多个同基座音色同时显示“当前生效”）
          const curVoice = (activeCharInfo() && activeCharInfo().voice) || {}
          const explicitRefFile = curVoice.referenceAudio ? curVoice.referenceAudio.replace(/\\/g, '/').split('/').pop() : ''
          let activeSampleFile = ''
          if (explicitRefFile && list.some(x => x.file === explicitRefFile)) {
            activeSampleFile = explicitRefFile
          } else {
            const byPrompt = list.find(x => SAMPLE_VOICE_CONFIGS[x.file] && curVoice.prompt && SAMPLE_VOICE_CONFIGS[x.file].prompt === curVoice.prompt)
            if (byPrompt) {
              activeSampleFile = byPrompt.file
            } else {
              // 优先选带中文名且匹配 voice_name 的首个官方示例
              const byVoiceCn = list.find(x => /[\u4e00-\u9fa5]/.test(x.file) && SAMPLE_VOICE_CONFIGS[x.file] && SAMPLE_VOICE_CONFIGS[x.file].voice_name === curVoice.voice_name)
              const byVoiceAny = list.find(x => SAMPLE_VOICE_CONFIGS[x.file] && SAMPLE_VOICE_CONFIGS[x.file].voice_name === curVoice.voice_name)
              if (byVoiceCn) activeSampleFile = byVoiceCn.file
              else if (byVoiceAny) activeSampleFile = byVoiceAny.file
            }
          }

          for (const item of list) {
            const card = $('div')
            card.style.display = 'flex'
            card.style.flexDirection = 'column'
            card.style.gap = '6px'
            card.style.padding = '8px 10px'
            card.style.background = 'rgba(0, 0, 0, 0.28)'
            card.style.borderRadius = '8px'
            card.style.border = '1px solid rgba(255, 255, 255, 0.08)'
            card.style.boxSizing = 'border-box'
            card.style.width = '100%'

            // 检查当前伴侣是否正在使用该示例音（严格唯一匹配）
            const isUsing = (item.file === activeSampleFile)

            // 第一行：🎵 音色名称 + 生效标识 + 大小标签
            const headerRow = $('div')
            headerRow.style.display = 'flex'
            headerRow.style.alignItems = 'center'
            headerRow.style.justifyContent = 'space-between'
            headerRow.style.gap = '8px'
            headerRow.style.width = '100%'

            const titleWrap = $('div')
            titleWrap.style.display = 'flex'
            titleWrap.style.alignItems = 'center'
            titleWrap.style.gap = '5px'
            titleWrap.style.overflow = 'hidden'
            titleWrap.style.flex = '1'

            const titleEl = $('span', null, '🎵 ' + (item.name || item.file))
            titleEl.style.fontSize = '12px'
            titleEl.style.fontWeight = 'bold'
            titleEl.style.color = '#fff'
            titleEl.style.whiteSpace = 'nowrap'
            titleEl.style.overflow = 'hidden'
            titleEl.style.textOverflow = 'ellipsis'
            titleEl.title = item.file
            titleWrap.appendChild(titleEl)

            const badgeWrap = $('div')
            badgeWrap.style.display = 'flex'
            badgeWrap.style.alignItems = 'center'
            badgeWrap.style.gap = '6px'
            badgeWrap.style.flexShrink = '0'

            if (isUsing) {
              const activeBadge = $('span', null, '✅ 当前生效')
              activeBadge.style.fontSize = '10px'
              activeBadge.style.padding = '1px 6px'
              activeBadge.style.borderRadius = '4px'
              activeBadge.style.background = 'rgba(82, 196, 26, 0.2)'
              activeBadge.style.color = '#73d13d'
              activeBadge.style.border = '1px solid rgba(82, 196, 26, 0.4)'
              badgeWrap.appendChild(activeBadge)
            }

            const sizeText = item.size ? (item.size > 1024 * 1024 ? (item.size / 1024 / 1024).toFixed(1) + 'MB' : Math.round(item.size / 1024) + 'KB') : ''
            if (sizeText) {
              const sizeBadge = $('span', null, sizeText)
              sizeBadge.style.fontSize = '10px'
              sizeBadge.style.color = '#888'
              badgeWrap.appendChild(sizeBadge)
            }

            headerRow.append(titleWrap, badgeWrap)

            // 第二行：操作按钮组（平铺且自适应宽度的试听、设为角色音、设为参考、删除）
            const btnGroup = $('div')
            btnGroup.style.display = 'flex'
            btnGroup.style.alignItems = 'center'
            btnGroup.style.gap = '5px'
            btnGroup.style.width = '100%'

            // [▶ 试听] 按钮：播放当前示例音频，口型同步，绝不重新生成
            const playBtn = $('button', 'dshp-btn dshp-primary', '▶ 试听')
            playBtn.style.flex = '1'
            playBtn.style.padding = '4px 6px'
            playBtn.style.fontSize = '10.5px'
            playBtn.style.textAlign = 'center'
            playBtn.style.whiteSpace = 'nowrap'
            playBtn.title = '试听此示例音色并驱动桌宠口型'
            playBtn.addEventListener('click', async () => {
              if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch (e) {} }
              if (audioCtx && audioCtx.state === 'suspended') { await audioCtx.resume().catch(() => {}) }
              ui.bubble.show(`正在试听示例音色「${item.name || item.file}」...`, { duration: 3000 })
              await playAudioWithLipSync(item.file || item.path, { force: true })
            })

            // [🌟 设为角色音] 按钮：直接将此示例音频设为当前伴侣默认声音
            const setCharVoiceBtn = $('button', 'dshp-btn' + (isUsing ? ' dshp-primary' : ''), isUsing ? '🌟 重新应用' : '🌟 设为角色音')
            setCharVoiceBtn.style.flex = '1.3'
            setCharVoiceBtn.style.padding = '4px 6px'
            setCharVoiceBtn.style.fontSize = '10.5px'
            setCharVoiceBtn.style.textAlign = 'center'
            setCharVoiceBtn.style.whiteSpace = 'nowrap'
            setCharVoiceBtn.title = `将此示例音设置为「${activeCharInfo().name}」的角色声音`
            setCharVoiceBtn.addEventListener('click', async () => {
              if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch (e) {} }
              if (audioCtx && audioCtx.state === 'suspended') { await audioCtx.resume().catch(() => {}) }
              setCharVoiceBtn.textContent = '保存中...'
              setCharVoiceBtn.disabled = true
              try {
                const conf = SAMPLE_VOICE_CONFIGS[item.file] || {}
                const vName = conf.voice_name || curVoice.voice_name || 'zh-CN-XiaoxiaoNeural'
                const vPrompt = conf.prompt || item.name || ''
                const vRate = conf.rate || '+0%'
                const vPitch = conf.pitch || '+0Hz'
                const refP = 'voice_engine/voices_pool/' + item.file

                await apiFetch(BASE + '/save-voice-config', {
                  method: 'POST',
                  body: JSON.stringify({
                    characterId: activeCharacterId,
                    voice: vName,
                    prompt: vPrompt,
                    rate: vRate,
                    pitch: vPitch,
                    referenceAudio: refP,
                    referenceText: item.name,
                  }),
                })

                if (activeCharInfo()) {
                  activeCharInfo().voice = Object.assign(activeCharInfo().voice || {}, {
                    voice_name: vName,
                    prompt: vPrompt,
                    rate: vRate,
                    pitch: vPitch,
                    referenceAudio: refP,
                    referenceText: item.name,
                  })
                }

                if (typeof promptInput !== 'undefined' && promptInput) promptInput.value = vPrompt
                if (typeof refAudioInput !== 'undefined' && refAudioInput) refAudioInput.value = refP

                ui.bubble.show(`已成功将「${item.name || item.file}」设为「${activeCharInfo().name}」的角色声音！`, { duration: 3500 })
                await playAudioWithLipSync(item.file || item.path, { force: true })
                loadVoicePool()
              } catch (e) {
                alert('设置角色音失败: ' + (e.message || e))
              } finally {
                setCharVoiceBtn.disabled = false
              }
            })

            // [📌 设为参考] 按钮：填入下方本地模型克隆参考路径
            const pickBtn = $('button', 'dshp-btn', '📌 设为参考')
            pickBtn.style.flex = '1'
            pickBtn.style.padding = '4px 6px'
            pickBtn.style.fontSize = '10.5px'
            pickBtn.style.textAlign = 'center'
            pickBtn.style.whiteSpace = 'nowrap'
            pickBtn.title = '填入本地克隆参考音频输入框'
            pickBtn.addEventListener('click', () => {
              if (typeof refAudioInput !== 'undefined' && refAudioInput) {
                refAudioInput.value = 'voice_engine/voices_pool/' + item.file
              }
              ui.bubble.show(`已将「${item.file}」设为克隆参考音频`, { duration: 2500 })
            })

            // [🗑️ 删除] 按钮
            const delBtn = $('button', 'dshp-btn', '🗑️ 删除')
            delBtn.style.flexShrink = '0'
            delBtn.style.padding = '4px 6px'
            delBtn.style.fontSize = '10.5px'
            delBtn.style.color = '#ff6b6b'
            delBtn.style.border = '1px solid rgba(255, 107, 107, 0.25)'
            delBtn.style.background = 'rgba(255, 107, 107, 0.08)'
            delBtn.style.textAlign = 'center'
            delBtn.style.whiteSpace = 'nowrap'
            delBtn.title = '从本地音色池删除此音频'
            delBtn.addEventListener('click', async () => {
              if (!confirm(`确认要删除示例音色「${item.name || item.file}」吗？`)) return
              try {
                let ok = false
                let errMsg = ''
                try {
                  const res = await apiFetch(BASE + '/delete-pool-voice', {
                    method: 'POST',
                    body: JSON.stringify({ file: item.file }),
                  })
                  if (res && res.ok) ok = true
                } catch (e1) {
                  errMsg = e1.message
                }
                if (!ok) {
                  try {
                    const r = await fetch('http://127.0.0.1:9880/delete-pool-voice', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ file: item.file }),
                    })
                    const d = await r.json()
                    if (d && d.ok) ok = true
                  } catch (e2) {}
                }

                if (ok) {
                  ui.bubble.show(`已删除示例音色「${item.name || item.file}」`, { duration: 2500 })
                  loadVoicePool()
                } else {
                  alert('删除失败: ' + (errMsg || '未知错误'))
                }
              } catch (e) {
                alert('删除异常: ' + e.message)
              }
            })

            btnGroup.append(playBtn, setCharVoiceBtn, pickBtn, delBtn)
            card.append(headerRow, btnGroup)
            poolList.appendChild(card)
          }
        } catch (e) {
          poolList.innerHTML = `<div style="font-size:11px;color:#ff8888;text-align:center;padding:10px;">读取音色池异常: ${e.message}</div>`
        }
      }

      refreshPoolBtn.addEventListener('click', () => loadVoicePool())
      poolCard.append(poolHeader, activeVoiceStatus, quickSampleHeader, quickSampleRow, poolList)

      // 3. ✨ 提示词声音生成器卡片
      const genCard = $('div', 'dshp-panel-card')
      genCard.style.padding = '10px 12px'
      genCard.style.background = 'rgba(124, 92, 255, 0.08)'
      genCard.style.borderRadius = '10px'
      genCard.style.border = '1px solid rgba(124, 92, 255, 0.3)'
      genCard.style.display = 'flex'
      genCard.style.flexDirection = 'column'
      genCard.style.gap = '8px'

      const genTitle = $('div', null, '✨ 提示词声音生成器（自然语言捏音）')
      genTitle.style.fontWeight = 'bold'
      genTitle.style.color = '#9a82ff'
      genTitle.style.fontSize = '12.5px'

      const promptInput = document.createElement('textarea')
      promptInput.rows = 2
      promptInput.placeholder = '输入声音风格提示词，例如：元气甜美少女、略带傲娇、冷艳成熟御姐、温柔治愈知心姐姐、幽默风趣...'
      promptInput.value = (activeCharInfo().voice && activeCharInfo().voice.prompt) || ''
      promptInput.style.width = '100%'
      promptInput.style.boxSizing = 'border-box'
      promptInput.style.fontSize = '11px'
      promptInput.style.padding = '6px 8px'
      promptInput.style.borderRadius = '6px'
      promptInput.style.background = 'rgba(0, 0, 0, 0.25)'
      promptInput.style.color = '#eee'
      promptInput.style.border = '1px solid rgba(124, 92, 255, 0.3)'
      promptInput.style.resize = 'vertical'

      // 提示词风格灵感预设（纯文本填充，避免与上方试听按钮混淆）
      const tplHint = $('div', 'dshp-hint', '💡 提示词风格灵感 (点击填充提示词):')
      tplHint.style.fontSize = '10.5px'

      const presetRow = $('div')
      presetRow.style.display = 'flex'
      presetRow.style.flexWrap = 'wrap'
      presetRow.style.gap = '4px'

      const PRESETS = [
        ['元气甜美', '元气甜美活泼少女，语调轻快'],
        ['冷艳御姐', '冷艳成熟御姐，语调平静优雅带气场'],
        ['温柔治愈', '温柔治愈系大姐姐，语气柔和轻缓'],
        ['傲娇萌妹', '傲娇萌妹，有点小任性又很在乎主人'],
        ['沉稳知性', '沉稳知性女青年，咬字清晰干练'],
        ['软萌台湾腔', '软萌可爱的台湾腔调，亲切甜美'],
      ]
      for (const [tag, text] of PRESETS) {
        const chip = $('button', 'dshp-chip', tag)
        chip.style.fontSize = '10px'
        chip.style.padding = '2px 6px'
        chip.title = '填充提示词: ' + text
        chip.addEventListener('click', () => {
          promptInput.value = text
        })
        presetRow.appendChild(chip)
      }

      // 声学微调：语速与音调
      const acousticRow = $('div')
      acousticRow.style.display = 'grid'
      acousticRow.style.gridTemplateColumns = '1fr 1fr'
      acousticRow.style.gap = '8px'

      const rateLabel = $('label', 'dshp-label')
      rateLabel.style.fontSize = '11px'
      rateLabel.append($('span', null, '语速微调'))
      const rateRange = document.createElement('input')
      rateRange.type = 'range'; rateRange.min = '-50'; rateRange.max = '50'; rateRange.step = '5'; rateRange.value = '0'
      const rateOut = $('span', null, '0%')
      rateRange.addEventListener('input', () => { rateOut.textContent = (Number(rateRange.value) >= 0 ? '+' : '') + rateRange.value + '%' })
      rateLabel.append(rateRange, rateOut)

      const pitchLabel = $('label', 'dshp-label')
      pitchLabel.style.fontSize = '11px'
      pitchLabel.append($('span', null, '音调微调'))
      const pitchRange = document.createElement('input')
      pitchRange.type = 'range'; pitchRange.min = '-20'; pitchRange.max = '20'; pitchRange.step = '2'; pitchRange.value = '0'
      const pitchOut = $('span', null, '0Hz')
      pitchRange.addEventListener('input', () => { pitchOut.textContent = (Number(pitchRange.value) >= 0 ? '+' : '') + pitchRange.value + 'Hz' })
      pitchLabel.append(pitchRange, pitchOut)

      acousticRow.append(rateLabel, pitchLabel)

      // 测试文案输入框
      const testInput = document.createElement('input')
      testInput.type = 'text'
      testInput.value = '主人好呀，听听看这是我新生成的声音，你喜欢吗？'
      testInput.placeholder = '输入发声试听文案'
      testInput.style.width = '100%'
      testInput.style.boxSizing = 'border-box'
      testInput.style.fontSize = '11px'
      testInput.style.padding = '4px 8px'
      testInput.style.borderRadius = '5px'
      testInput.style.background = 'rgba(0,0,0,0.2)'
      testInput.style.color = '#ddd'
      testInput.style.border = '1px solid #444'

      // 生成操作按钮
      const genBtnRow = $('div', 'dshp-row')
      genBtnRow.style.display = 'flex'
      genBtnRow.style.flexWrap = 'wrap'
      genBtnRow.style.gap = '6px'

      let lastGeneratedVoice = null
      let lastGeneratedAudioUrl = null

      const genPlayBtn = $('button', 'dshp-btn dshp-primary', '▶ 生成并试听声音')
      genPlayBtn.style.flex = '1'
      genPlayBtn.style.padding = '6px 8px'
      genPlayBtn.style.fontWeight = 'bold'
      genPlayBtn.addEventListener('click', async () => {
        const p = promptInput.value.trim()
        if (!p) {
          ui.bubble.show('请先填写声音提示词或点击预设标签！', { duration: 2000 })
          return
        }
        genPlayBtn.textContent = '正在生成...'
        genPlayBtn.disabled = true
        try {
          const resData = await apiFetch(BASE + '/generate-voice', {
            method: 'POST',
            body: JSON.stringify({
              characterId: activeCharacterId,
              prompt: p,
              text: testInput.value.trim(),
              rate: Number(rateRange.value),
              pitch: Number(pitchRange.value),
            }),
          })
          if (resData && resData.ok && resData.audioUrl) {
            lastGeneratedVoice = resData.voice
            lastGeneratedAudioUrl = resData.audioUrl
            if (activeCharInfo()) {
              activeCharInfo().voice = Object.assign(activeCharInfo().voice || {}, {
                voice_name: resData.voice,
                rate: resData.rate || '+0%',
                pitch: resData.pitch || '+0Hz',
                prompt: p,
              })
            }
            ui.bubble.show(`声音生成成功！匹配音色：${resData.voice} (${resData.rate || '+0%'}, ${resData.pitch || '+0Hz'})`, { duration: 3500 })
            await playAudioWithLipSync(resData.audioUrl, { force: true })
          } else {
            alert('生成失败: ' + ((resData && resData.error) || '未知错误'))
          }
        } catch (err) {
          alert('生成异常: ' + ((err && err.message) || err))
        } finally {
          genPlayBtn.textContent = '▶ 生成并试听声音'
          genPlayBtn.disabled = false
        }
      })

      const saveVoiceBtn = $('button', 'dshp-btn', '💾 设为当前伴侣声音')
      saveVoiceBtn.style.padding = '6px 8px'
      saveVoiceBtn.style.fontSize = '11px'
      saveVoiceBtn.addEventListener('click', async () => {
        saveVoiceBtn.textContent = '保存中...'
        saveVoiceBtn.disabled = true
        try {
          const rateVal = (Number(rateRange.value) >= 0 ? '+' : '') + rateRange.value + '%'
          const pitchVal = (Number(pitchRange.value) >= 0 ? '+' : '') + pitchRange.value + 'Hz'
          const voiceToSave = lastGeneratedVoice || (activeCharInfo().voice && (activeCharInfo().voice.voice_name || activeCharInfo().voice.voice)) || 'zh-CN-XiaoxiaoNeural'
          await apiFetch(BASE + '/save-voice-config', {
            method: 'POST',
            body: JSON.stringify({
              characterId: activeCharacterId,
              prompt: promptInput.value.trim(),
              rate: rateVal,
              pitch: pitchVal,
              voice: voiceToSave,
            }),
          })
          if (activeCharInfo()) {
            activeCharInfo().voice = Object.assign(activeCharInfo().voice || {}, {
              voice_name: voiceToSave,
              prompt: promptInput.value.trim(),
              rate: rateVal,
              pitch: pitchVal,
            })
          }
          ui.bubble.show(`已将新音色设为「${activeCharInfo().name}」默认声音！`, { duration: 3000 })
        } catch (e) {
          alert('保存失败: ' + ((e && e.message) || e))
        } finally {
          saveVoiceBtn.textContent = '💾 设为当前伴侣声音'
          saveVoiceBtn.disabled = false
        }
      })

      genBtnRow.append(genPlayBtn, saveVoiceBtn)

      // 保存至示例音色库独立分区（避免弹窗失效，提供即时状态反馈与自动合成兜底）
      const savePoolSection = $('div')
      savePoolSection.style.display = 'flex'
      savePoolSection.style.flexDirection = 'column'
      savePoolSection.style.gap = '4px'
      savePoolSection.style.padding = '8px'
      savePoolSection.style.background = 'rgba(0, 0, 0, 0.18)'
      savePoolSection.style.borderRadius = '6px'
      savePoolSection.style.border = '1px dashed rgba(124, 92, 255, 0.3)'
      savePoolSection.style.marginTop = '4px'

      const savePoolTitle = $('div', 'dshp-hint', '📥 将新声音保存至示例音色库：')
      savePoolTitle.style.fontSize = '10.5px'
      savePoolTitle.style.color = '#9a82ff'

      const savePoolRow = $('div', 'dshp-row')
      savePoolRow.style.display = 'flex'
      savePoolRow.style.gap = '6px'
      savePoolRow.style.alignItems = 'center'

      const savePoolNameInput = document.createElement('input')
      savePoolNameInput.type = 'text'
      savePoolNameInput.placeholder = '输入保存名称 (留空自动生成，如: 甜美小调)'
      savePoolNameInput.style.flex = '1'
      savePoolNameInput.style.fontSize = '11px'
      savePoolNameInput.style.padding = '4px 6px'
      savePoolNameInput.style.borderRadius = '4px'
      savePoolNameInput.style.background = 'rgba(0,0,0,0.3)'
      savePoolNameInput.style.color = '#eee'
      savePoolNameInput.style.border = '1px solid rgba(124, 92, 255, 0.4)'

      const saveToPoolBtn = $('button', 'dshp-btn dshp-primary', '📥 保存为示例音')
      saveToPoolBtn.style.padding = '5px 10px'
      saveToPoolBtn.style.fontSize = '11px'
      saveToPoolBtn.style.fontWeight = 'bold'
      saveToPoolBtn.style.flexShrink = '0'

      const saveFeedback = $('div')
      saveFeedback.style.fontSize = '10.5px'
      saveFeedback.style.minHeight = '14px'

      saveToPoolBtn.addEventListener('click', async () => {
        const userSpecifiedName = savePoolNameInput.value.trim()
        const defaultName = `${activeCharInfo().name}_${(lastGeneratedVoice || '自定义').replace(/^zh-CN-/, '')}_${Date.now().toString(36)}`
        const finalName = userSpecifiedName || defaultName

        saveToPoolBtn.textContent = '⏳ 保存中...'
        saveToPoolBtn.disabled = true
        saveFeedback.style.color = '#9a82ff'
        saveFeedback.textContent = '正在处理保存...'

        try {
          // 若当前尚未生成过声音，则先即时生成，再自动入池
          if (!lastGeneratedAudioUrl) {
            saveFeedback.textContent = '正在即时合成当前声音并入池...'
            const p = promptInput.value.trim() || '元气甜美少女'
            const genRes = await apiFetch(BASE + '/generate-voice', {
              method: 'POST',
              body: JSON.stringify({
                characterId: activeCharacterId,
                prompt: p,
                text: testInput.value.trim() || '主人好，听听看这是我新生成的专属声音！',
                rate: Number(rateRange.value),
                pitch: Number(pitchRange.value),
              }),
            })
            if (genRes && genRes.ok && genRes.audioUrl) {
              lastGeneratedVoice = genRes.voice
              lastGeneratedAudioUrl = genRes.audioUrl
            } else {
              throw new Error((genRes && genRes.error) || '声音合成失败')
            }
          }

          // 取出当前音频二进制并转为 Base64（双保机制：既传 Base64，又传参数，且支持多路由自动重试）
          let audioBase64 = null
          if (lastGeneratedAudioUrl) {
            try {
              const fetchHeaders = {}
              if (DESK_TOKEN) fetchHeaders['x-dsh-pet-desk'] = DESK_TOKEN
              const aRes = await fetch(lastGeneratedAudioUrl, { headers: fetchHeaders, credentials: 'include' })
              if (aRes.ok) {
                const aBuf = await aRes.arrayBuffer()
                const u8 = new Uint8Array(aBuf)
                let bStr = ''
                for (let i = 0; i < u8.length; i += 8192) {
                  bStr += String.fromCharCode.apply(null, u8.subarray(i, i + 8192))
                }
                audioBase64 = btoa(bStr)
              }
            } catch (e) {
              console.warn('[桌宠语音] 提取当前音频 Base64 失败，走后端缓存兜底:', e)
            }
          }

          // 多路由阶梯式保存策略：先走标准 POST，若遇 405/网络错误，依次自动尝试 GET 与 9880 备用端口
          let res = null
          let saveErr = null

          // 1. 尝试 POST /dsh-pet/save-to-pool
          try {
            res = await apiFetch(BASE + '/save-to-pool', {
              method: 'POST',
              body: JSON.stringify({
                name: finalName,
                characterId: activeCharacterId,
                audioBase64: audioBase64,
              }),
            })
          } catch (e1) {
            saveErr = e1
          }

          // 2. 尝试 GET /dsh-pet/save-to-pool?name=...
          if (!res || !res.ok) {
            try {
              res = await apiFetch(BASE + '/save-to-pool?name=' + encodeURIComponent(finalName) + '&characterId=' + encodeURIComponent(activeCharacterId), {
                method: 'GET',
              })
              saveErr = null
            } catch (e2) {
              saveErr = e2
            }
          }

          // 3. 尝试 9880 独立直连端口 http://127.0.0.1:9880/save_to_pool
          if (!res || !res.ok) {
            try {
              const pResp = await fetch('http://127.0.0.1:9880/save_to_pool', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: finalName,
                  characterId: activeCharacterId,
                  audioBase64: audioBase64,
                }),
              })
              if (pResp.ok) {
                res = await pResp.json()
                saveErr = null
              }
            } catch (e3) {}
          }

          if (res && res.ok) {
            saveFeedback.style.color = '#52c41a'
            saveFeedback.textContent = `✅ 已成功存入示例音色库：「${res.file}」`
            savePoolNameInput.value = ''
            ui.bubble.show(`已成功存入本地音色池：${res.file}！`, { duration: 3500 })
            loadVoicePool()
            setTimeout(() => { saveFeedback.textContent = '' }, 4000)
          } else {
            throw new Error((res && res.error) || (saveErr && saveErr.message) || '保存失败')
          }
        } catch (err) {
          saveFeedback.style.color = '#ff4d4f'
          saveFeedback.textContent = `❌ 保存失败: ${err.message}`
        } finally {
          saveToPoolBtn.textContent = '📥 保存为示例音'
          saveToPoolBtn.disabled = false
        }
      })

      savePoolRow.append(savePoolNameInput, saveToPoolBtn)
      savePoolSection.append(savePoolTitle, savePoolRow, saveFeedback)

      genCard.append(genTitle, promptInput, tplHint, presetRow, acousticRow, testInput, genBtnRow, savePoolSection)

      // 4. 📁 本地 TTS 导入与配置卡片
      const localCard = $('div', 'dshp-panel-card')
      localCard.style.padding = '10px 12px'
      localCard.style.background = 'rgba(255, 255, 255, 0.03)'
      localCard.style.borderRadius = '10px'
      localCard.style.border = '1px solid rgba(255, 255, 255, 0.12)'
      localCard.style.display = 'flex'
      localCard.style.flexDirection = 'column'
      localCard.style.gap = '8px'

      const localTitle = $('div', null, '📁 本地 TTS 导入与模型配置')
      localTitle.style.fontWeight = 'bold'
      localTitle.style.fontSize = '12px'

      const engineRow = $('div', 'dshp-row')
      engineRow.style.display = 'flex'
      engineRow.style.alignItems = 'center'
      engineRow.style.gap = '6px'

      const engineLabel = $('span', 'dshp-hint', 'TTS引擎:')
      engineLabel.style.width = '60px'

      const engineSel = document.createElement('select')
      engineSel.style.flex = '1'
      engineSel.style.fontSize = '11px'
      engineSel.style.padding = '3px 4px'
      engineSel.style.borderRadius = '4px'
      engineSel.style.background = '#222'
      engineSel.style.color = '#eee'
      engineSel.style.border = '1px solid #444'

      const ENGINES = [
        ['edge-tts', 'Edge TTS (9880 极速推荐)'],
        ['gpt-sovits', 'GPT-SoVITS (本地模型克隆)'],
        ['cosyvoice', 'CosyVoice (本地声线复刻)'],
        ['fishspeech', 'FishSpeech / 外部自定义引擎'],
      ]
      for (const [eId, eName] of ENGINES) {
        const opt = document.createElement('option')
        opt.value = eId
        opt.textContent = eName
        engineSel.appendChild(opt)
      }
      engineRow.append(engineLabel, engineSel)

      const refTextHint = $('div', 'dshp-hint', '💡 可在上方的「🎵 示例音色库」直接点击「📌 设为参考」填入参考路径。')
      refTextHint.style.fontSize = '10.5px'
      refTextHint.style.color = '#888'

      const refTextInput = document.createElement('input')
      refTextInput.type = 'text'
      refTextInput.placeholder = '参考文本 (对应音频台词或情绪标注)'
      refTextInput.value = (activeCharInfo().voice && activeCharInfo().voice.referenceText) || ''
      refTextInput.style.width = '100%'
      refTextInput.style.boxSizing = 'border-box'
      refTextInput.style.fontSize = '11px'
      refTextInput.style.padding = '4px 6px'
      refTextInput.style.borderRadius = '4px'
      refTextInput.style.background = '#1b1b1b'
      refTextInput.style.color = '#ccc'
      refTextInput.style.border = '1px solid #333'

      const saveLocalBtn = $('button', 'dshp-btn', '💾 保存本地 TTS 模型配置')
      saveLocalBtn.style.padding = '6px'
      saveLocalBtn.style.fontSize = '11.5px'
      saveLocalBtn.addEventListener('click', async () => {
        saveLocalBtn.textContent = '保存中...'
        saveLocalBtn.disabled = true
        try {
          await apiFetch(BASE + '/save-voice-config', {
            method: 'POST',
            body: JSON.stringify({
              characterId: activeCharacterId,
              engine: engineSel.value,
              referenceAudio: refAudioInput.value.trim(),
              referenceText: refTextInput.value.trim(),
            }),
          })
          ui.bubble.show(`「${activeCharInfo().name}」本地 TTS 配置已保存！`, { duration: 3000 })
        } catch (e) {
          alert('保存失败: ' + ((e && e.message) || e))
        } finally {
          saveLocalBtn.textContent = '💾 保存本地 TTS 模型配置'
          saveLocalBtn.disabled = false
        }
      })

      localCard.append(localTitle, engineRow, refTextHint, refAudioInput, refTextInput, saveLocalBtn)

      box.append(statusTitle, basicRow, volLabel, poolCard, genCard, localCard)
      panes.appendChild(box)
      loadVoicePool()
      return
    }

    if (id === 'perception') {
      const pBox = $('div', 'dshp-col')
      pBox.style.display = 'flex'
      pBox.style.flexDirection = 'column'
      pBox.style.gap = '12px'

      const statusTitle = $('div', 'dshp-hint', '🧩 场景感知与角色状态调控')
      statusTitle.style.fontWeight = 'bold'
      statusTitle.style.color = '#7c5cff'
      statusTitle.style.fontSize = '13px'
      pBox.appendChild(statusTitle)

      // 1. 伴侣声带模式 (Mouth Mode) - 遵照指示不展示严禁隐式降级铁律文字声明
      const mouthCard = $('div', 'dshp-card')
      mouthCard.style.padding = '10px'
      mouthCard.style.borderRadius = '8px'
      mouthCard.style.background = 'rgba(0,0,0,0.14)'
      mouthCard.style.border = '1px solid var(--dshp-line)'

      const mouthTitle = $('div', null, '👄 伴侣声带表达模式')
      mouthTitle.style.fontSize = '12px'
      mouthTitle.style.fontWeight = 'bold'
      mouthTitle.style.marginBottom = '6px'

      const mouthSel = document.createElement('select')
      mouthSel.style.width = '100%'
      mouthSel.style.padding = '6px 8px'
      mouthSel.style.borderRadius = '6px'
      mouthSel.style.border = '1px solid var(--dshp-line)'
      mouthSel.style.background = 'rgba(0,0,0,0.2)'
      mouthSel.style.color = 'inherit'
      mouthSel.style.fontSize = '12px'

      const optRephrase = document.createElement('option')
      optRephrase.value = 'rephrase'
      optRephrase.textContent = '🧠 AI 人设转述器（5大角色专属灵魂人设 + Live2D 动作联动）'
      const optTemplate = document.createElement('option')
      optTemplate.value = 'template'
      optTemplate.textContent = '📋 传统规则摘要（固定模板短语）'
      const optOff = document.createElement('option')
      optOff.value = 'off'
      optOff.textContent = '🔇 关闭口播（仅保留气泡文字）'

      mouthSel.append(optRephrase, optTemplate, optOff)
      mouthSel.value = CFG.voiceMode || 'rephrase'
      mouthSel.addEventListener('change', () => {
        CFG.voiceMode = mouthSel.value
        persistCfg()
      })
      mouthCard.append(mouthTitle, mouthSel)
      pBox.appendChild(mouthCard)

      // 2. 游戏伴聊感知 (Game Perception) - 只要游戏进程运行即生效，无需全屏
      const gameCard = $('div', 'dshp-card')
      gameCard.style.padding = '10px'
      gameCard.style.borderRadius = '8px'
      gameCard.style.background = 'rgba(0,0,0,0.14)'
      gameCard.style.border = '1px solid var(--dshp-line)'

      const gameTitle = $('div', null, '🎮 游戏进程伴聊感知')
      gameTitle.style.fontSize = '12px'
      gameTitle.style.fontWeight = 'bold'
      gameTitle.style.marginBottom = '4px'

      const gameStatusRow = $('div')
      gameStatusRow.style.fontSize = '11px'
      gameStatusRow.style.color = '#888'
      gameStatusRow.style.marginBottom = '6px'
      gameStatusRow.textContent = '正在检测本地游戏进程...'

      const gameLabel = $('label')
      gameLabel.style.display = 'flex'
      gameLabel.style.alignItems = 'center'
      gameLabel.style.gap = '6px'
      gameLabel.style.fontSize = '12px'
      gameLabel.style.cursor = 'pointer'

      const gameChk = document.createElement('input')
      gameChk.type = 'checkbox'
      gameChk.checked = CFG.perceptionGame === true
      gameChk.addEventListener('change', () => {
        CFG.perceptionGame = gameChk.checked
        persistCfg()
        perceptionFetch('/perception/game-event', {
          method: 'POST',
          body: JSON.stringify({ inGame: CFG.perceptionGame, gameName: 'manual_toggle' })
        }).catch(() => {})
      })
      const gameSpan = $('span', null, '游戏开启时保持伴聊互动（关闭则游戏期间彻底静默）')
      gameLabel.append(gameChk, gameSpan)

      // 自定义游戏进程添加与删除列表
      const customGameSection = $('div')
      customGameSection.style.marginTop = '8px'
      customGameSection.style.paddingTop = '8px'
      customGameSection.style.borderTop = '1px dashed rgba(255,255,255,0.08)'

      const customGameTitle = $('div', null, '📋 自定义监听游戏列表：')
      customGameTitle.style.fontSize = '11px'
      customGameTitle.style.color = '#bbb'
      customGameTitle.style.marginBottom = '6px'

      const customGameChips = $('div')
      customGameChips.style.display = 'flex'
      customGameChips.style.flexWrap = 'wrap'
      customGameChips.style.gap = '6px'
      customGameChips.style.marginBottom = '8px'

      function renderCustomGameChips() {
        customGameChips.innerHTML = ''
        const list = Array.isArray(CFG.customGames) ? CFG.customGames : []
        if (list.length === 0) {
          const empty = $('span', null, '暂未添加自定义游戏（默认内置支持主流 Steam / 原神 / CS2 等）')
          empty.style.fontSize = '10.5px'
          empty.style.color = '#666'
          customGameChips.appendChild(empty)
          return
        }
        list.forEach((g, idx) => {
          const chip = $('div', 'dshp-chip')
          chip.style.display = 'inline-flex'
          chip.style.alignItems = 'center'
          chip.style.gap = '4px'
          chip.style.fontSize = '11px'
          chip.style.padding = '2px 8px'
          chip.style.background = 'rgba(124, 92, 255, 0.15)'
          chip.style.border = '1px solid rgba(124, 92, 255, 0.3)'

          const nameSpan = $('span', null, `🎮 ${g.name} (${g.exe})`)
          const delBtn = $('span', null, '✕')
          delBtn.style.cursor = 'pointer'
          delBtn.style.marginLeft = '4px'
          delBtn.style.color = '#ff6b6b'
          delBtn.style.fontWeight = 'bold'
          delBtn.title = '删除此自定义游戏'
          delBtn.addEventListener('click', (ev) => {
            ev.stopPropagation()
            CFG.customGames.splice(idx, 1)
            persistCfg()
            perceptionFetch('/perception/game-list', {
              method: 'POST',
              body: JSON.stringify({ customGames: CFG.customGames })
            }).catch(() => {})
            renderCustomGameChips()
          })

          chip.append(nameSpan, delBtn)
          customGameChips.appendChild(chip)
        })
      }
      renderCustomGameChips()

      const addRow = $('div')
      addRow.style.display = 'flex'
      addRow.style.gap = '6px'
      addRow.style.alignItems = 'center'

      const exeInp = document.createElement('input')
      exeInp.type = 'text'
      exeInp.placeholder = '进程名 (如 hades2.exe)'
      exeInp.style.flex = '1'
      exeInp.style.fontSize = '11px'
      exeInp.style.padding = '4px 6px'
      exeInp.style.borderRadius = '4px'
      exeInp.style.border = '1px solid var(--dshp-line)'
      exeInp.style.background = 'rgba(0,0,0,0.2)'
      exeInp.style.color = '#fff'

      const nameInp = document.createElement('input')
      nameInp.type = 'text'
      nameInp.placeholder = '显示名 (如 哈迪斯2)'
      nameInp.style.flex = '1'
      nameInp.style.fontSize = '11px'
      nameInp.style.padding = '4px 6px'
      nameInp.style.borderRadius = '4px'
      nameInp.style.border = '1px solid var(--dshp-line)'
      nameInp.style.background = 'rgba(0,0,0,0.2)'
      nameInp.style.color = '#fff'

      const addBtn = $('button', 'dshp-btn dshp-primary', '➕ 添加游戏')
      addBtn.style.fontSize = '11px'
      addBtn.style.padding = '4px 10px'
      addBtn.addEventListener('click', () => {
        const exeVal = exeInp.value.trim().toLowerCase()
        const nameVal = nameInp.value.trim() || exeVal
        if (!exeVal) {
          alert('请输入游戏进程文件名，例如 hades2.exe')
          return
        }
        if (!CFG.customGames) CFG.customGames = []
        if (CFG.customGames.some(item => item.exe === exeVal)) {
          alert('该游戏进程已在列表中')
          return
        }
        CFG.customGames.push({ exe: exeVal, name: nameVal })
        persistCfg()
        exeInp.value = ''
        nameInp.value = ''
        perceptionFetch('/perception/game-list', {
          method: 'POST',
          body: JSON.stringify({ customGames: CFG.customGames })
        }).catch(() => {})
        renderCustomGameChips()
      })

      addRow.append(exeInp, nameInp, addBtn)
      customGameSection.append(customGameTitle, customGameChips, addRow)

      const gameHint = $('div', 'dshp-hint', '💡 已内置原神、星铁、绝区零、黑神话、CS2、瓦罗兰特、LOL等主流游戏。只要进程打开即可触发，不限全屏。')
      gameHint.style.fontSize = '10.5px'
      gameHint.style.marginTop = '6px'
      gameHint.style.opacity = '0.75'

      gameCard.append(gameTitle, gameStatusRow, gameLabel, customGameSection, gameHint)
      pBox.appendChild(gameCard)

      // 3. 网页场景关怀 (Web Perception & Single Inquiry Protocol)
      const webCard = $('div', 'dshp-card')
      webCard.style.padding = '10px'
      webCard.style.borderRadius = '8px'
      webCard.style.background = 'rgba(0,0,0,0.14)'
      webCard.style.border = '1px solid var(--dshp-line)'

      const webTitle = $('div', null, '🌐 网页场景关怀（出行/租房/购物单次问候）')
      webTitle.style.fontSize = '12px'
      webTitle.style.fontWeight = 'bold'
      webTitle.style.marginBottom = '6px'

      const webLabel = $('label')
      webLabel.style.display = 'flex'
      webLabel.style.alignItems = 'center'
      webLabel.style.gap = '6px'
      webLabel.style.fontSize = '12px'
      webLabel.style.cursor = 'pointer'

      const webChk = document.createElement('input')
      webChk.type = 'checkbox'
      webChk.checked = CFG.perceptionWeb !== false
      webChk.addEventListener('change', () => {
        CFG.perceptionWeb = webChk.checked
        persistCfg()
      })
      const webSpan = $('span', null, '启用网页场景智能关怀 (识别到机票出行、租房、购物车时主动轻声问候)')
      webLabel.append(webChk, webSpan)

      const webBtnRow = $('div')
      webBtnRow.style.display = 'flex'
      webBtnRow.style.gap = '8px'
      webBtnRow.style.marginTop = '8px'

      const testTravelBtn = $('button', 'dshp-chip', '⚡ 模拟测试出行问候')
      testTravelBtn.style.fontSize = '11px'
      testTravelBtn.style.padding = '4px 10px'
      testTravelBtn.addEventListener('click', async () => {
        try {
          testTravelBtn.disabled = true
          testTravelBtn.textContent = '触发中...'
          const res = await perceptionFetch('/perception/test-inquiry', {
            method: 'POST',
            body: JSON.stringify({ category: 'travel' })
          })
          const qText = (res && res.result && res.result.questionText) || '主人是在看去哪里的行程机票呀？'
          if (ui.bubble) ui.bubble.show(qText, { name: activeCharInfo().name, duration: 6000 })
          try {
            if (CFG.sound !== false && typeof speakCharacterText === 'function') {
              await speakCharacterText(qText, activeCharacterId)
            }
          } catch (ve) {
            console.warn('[感知问候] 伴侣语音播报异常:', ve)
          }
        } catch (e) {
          alert('测试触发异常: ' + e.message)
        } finally {
          testTravelBtn.disabled = false
          testTravelBtn.textContent = '⚡ 模拟测试出行问候'
        }
      })

      const testRentalBtn = $('button', 'dshp-chip', '⚡ 模拟测试租房问候')
      testRentalBtn.style.fontSize = '11px'
      testRentalBtn.style.padding = '4px 10px'
      testRentalBtn.addEventListener('click', async () => {
        try {
          testRentalBtn.disabled = true
          testRentalBtn.textContent = '触发中...'
          const res = await perceptionFetch('/perception/test-inquiry', {
            method: 'POST',
            body: JSON.stringify({ category: 'rental' })
          })
          const qText = (res && res.result && res.result.questionText) || '主人是在看新房源或者租房信息吗？'
          if (ui.bubble) ui.bubble.show(qText, { name: activeCharInfo().name, duration: 6000 })
          try {
            if (CFG.sound !== false && typeof speakCharacterText === 'function') {
              await speakCharacterText(qText, activeCharacterId)
            }
          } catch (ve) {
            console.warn('[感知问候] 伴侣语音播报异常:', ve)
          }
        } catch (e) {
          alert('测试触发异常: ' + e.message)
        } finally {
          testRentalBtn.disabled = false
          testRentalBtn.textContent = '⚡ 模拟测试租房问候'
        }
      })

      webBtnRow.append(testTravelBtn, testRentalBtn)
      const webHint = $('div', 'dshp-hint', '🔒 遵循单次关怀铁律：仅问询一句，若 20 秒无视则自动彻底静默，绝不重复打扰。支持 Edge/Chrome 扩展安装联动。')
      webHint.style.fontSize = '10.5px'
      webHint.style.marginTop = '4px'
      webHint.style.opacity = '0.75'

      webCard.append(webTitle, webLabel, webBtnRow, webHint)
      pBox.appendChild(webCard)

      // 4. 前台视觉感官神经 (Screen Vision Sensor) - 桌面灵视觉采集与交互机制
      const visionCard = $('div', 'dshp-card')
      visionCard.style.padding = '10px'
      visionCard.style.borderRadius = '8px'
      visionCard.style.background = 'rgba(0,0,0,0.14)'
      visionCard.style.border = '1px solid var(--dshp-line)'

      const visionTitle = $('div', null, '👁️ 屏幕视觉交互感官 (基于桌面灵采集机制)')
      visionTitle.style.fontSize = '12px'
      visionTitle.style.fontWeight = 'bold'
      visionTitle.style.marginBottom = '6px'

      const visionToggleRow = $('div')
      visionToggleRow.style.display = 'flex'
      visionToggleRow.style.alignItems = 'center'
      visionToggleRow.style.justifyContent = 'space-between'
      visionToggleRow.style.marginBottom = '8px'

      const visionLabel = $('label')
      visionLabel.style.display = 'flex'
      visionLabel.style.alignItems = 'center'
      visionLabel.style.gap = '6px'
      visionLabel.style.fontSize = '12px'
      visionLabel.style.cursor = 'pointer'

      const visionChk = document.createElement('input')
      visionChk.type = 'checkbox'
      visionChk.checked = CFG.screenVisionEnabled !== false
      visionChk.addEventListener('change', () => {
        CFG.screenVisionEnabled = visionChk.checked
        persistCfg()
        perceptionFetch('/perception/vision-config', {
          method: 'POST',
          body: JSON.stringify({ enabled: CFG.screenVisionEnabled, mode: CFG.screenVisionMode || 'companion' })
        }).catch(() => {})
      })
      const visionSpan = $('span', null, '开启前台屏幕视觉智能交互')
      visionLabel.append(visionChk, visionSpan)

      const visionModeSel = document.createElement('select')
      visionModeSel.style.fontSize = '11px'
      visionModeSel.style.padding = '3px 6px'
      visionModeSel.style.borderRadius = '4px'
      visionModeSel.style.border = '1px solid var(--dshp-line)'
      visionModeSel.style.background = 'rgba(0,0,0,0.2)'
      visionModeSel.style.color = '#fff'

      const optVComp = document.createElement('option')
      optVComp.value = 'companion'
      optVComp.textContent = '伴聊温情模式 (平稳切换时轻声关怀)'
      const optVQuiet = document.createElement('option')
      optVQuiet.value = 'quiet'
      optVQuiet.textContent = '极简静默模式 (仅监测不打扰)'
      visionModeSel.append(optVComp, optVQuiet)
      visionModeSel.value = CFG.screenVisionMode || 'companion'
      visionModeSel.addEventListener('change', () => {
        CFG.screenVisionMode = visionModeSel.value
        persistCfg()
        perceptionFetch('/perception/vision-config', {
          method: 'POST',
          body: JSON.stringify({ enabled: CFG.screenVisionEnabled, mode: CFG.screenVisionMode })
        }).catch(() => {})
      })

      visionToggleRow.append(visionLabel, visionModeSel)

      const visionStatus = $('div')
      visionStatus.style.fontSize = '11px'
      visionStatus.style.color = '#888'
      visionStatus.style.marginBottom = '6px'
      visionStatus.textContent = '视觉引擎状态探测中...'

      const visionBtnRow = $('div')
      visionBtnRow.style.display = 'flex'
      visionBtnRow.style.alignItems = 'center'
      visionBtnRow.style.gap = '8px'
      visionBtnRow.style.marginTop = '6px'

      const captureBtn = $('button', 'dshp-chip', '📸 立即截取前台活动窗口测试')
      captureBtn.style.fontSize = '11px'
      captureBtn.style.padding = '5px 12px'

      const previewContainer = $('div')
      previewContainer.style.marginTop = '8px'
      previewContainer.style.display = 'none'

      captureBtn.addEventListener('click', async () => {
        try {
          captureBtn.disabled = true
          captureBtn.textContent = '正在捕获前台窗口...'
          const res = await perceptionFetch('/perception/capture', { method: 'POST', body: '{}' })
          if (res && res.ok && res.shot && res.shot.base64) {
            previewContainer.innerHTML = ''
            previewContainer.style.display = 'flex'
            previewContainer.style.flexDirection = 'column'
            previewContainer.style.gap = '4px'

            const info = $('div', null, `捕获成功 (${res.shot.source === 'appshot' ? 'dsh-plugin-appshot' : '原生 Win32 GDI'} · ${res.shot.width || 0}×${res.shot.height || 0})`)
            info.style.fontSize = '11px'
            info.style.color = '#10b981'

            const img = document.createElement('img')
            img.src = `data:${res.shot.mime || 'image/jpeg'};base64,` + res.shot.base64
            img.style.maxWidth = '100%'
            img.style.maxHeight = '140px'
            img.style.objectFit = 'contain'
            img.style.borderRadius = '6px'
            img.style.border = '1px solid var(--dshp-line)'

            const askDshBtn = $('button', 'dshp-chip', '💬 发送给 DSH 讨论当前画面')
            askDshBtn.style.fontSize = '11px'
            askDshBtn.style.padding = '4px 8px'
            askDshBtn.addEventListener('click', async () => {
              askDshBtn.disabled = true
              askDshBtn.textContent = '⏳ 正在处理...'
              try {
                const text = '请帮我看一下当前前台窗口的内容，并给出你的分析或建议。'
                const resSay = await apiFetch(BASE + '/say', {
                  method: 'POST',
                  body: JSON.stringify({
                    text,
                    image: res.shot.base64,
                    imageMime: res.shot.mime || 'image/jpeg',
                  }),
                })
                if (!resSay || !resSay.ok) throw new Error((resSay && resSay.error) || '发送失败')
                closePanels()
                ui.bubble.show('我看到了哦，让我想一想~', { name: activeCharInfo().name, ttl: 4000 })
                act({ mood: 'listening', props: IDLE_PROPS, line: '我看到了哦，让我想一想~', ms: 3000 })
              } catch (err) {
                if (ui && ui.composer && ui.composer.ta) {
                  ui.composer.ta.value = '请帮我看一下当前前台窗口的内容，并给出你的分析或建议。'
                  openMenu('talk')
                }
                ui.bubble.show('我看到啦，先记在底下的对话框里咯~', { name: activeCharInfo().name, ttl: 3000 })
              } finally {
                askDshBtn.disabled = false
                askDshBtn.textContent = '💬 发送给 DSH 讨论当前画面'
              }
            })

            previewContainer.append(info, img, askDshBtn)
          } else {
            alert('截取完成，但未返回可预览图像数据')
          }
        } catch (e) {
          alert('截取前台活动窗口失败: ' + e.message)
        } finally {
          captureBtn.disabled = false
          captureBtn.textContent = '📸 立即截取前台活动窗口测试'
        }
      })

      visionBtnRow.appendChild(captureBtn)
      const visionHint = $('div', 'dshp-hint', '💡 伴侣只作为眼睛，绝不自建冗余本地视觉模型。内置 32×18 RGB 差分防抖、动态流抑制与 WinSta0\\Default 原生极速采集。')
      visionHint.style.fontSize = '10.5px'
      visionHint.style.marginTop = '4px'
      visionHint.style.opacity = '0.75'

      visionCard.append(visionTitle, visionToggleRow, visionStatus, visionBtnRow, previewContainer, visionHint)
      pBox.appendChild(visionCard)

      // 异步拉取后端状态
      perceptionFetch('/perception/status')
        .then((res) => {
          if (res && res.ok) {
            const p = res.perception || {}
            const s = res.screenSensor || {}
            if (p.inGame) {
              gameStatusRow.textContent = `🟢 正在运行游戏：${p.currentGame || '已识别游戏'}`
              gameStatusRow.style.color = '#10b981'
            } else {
              gameStatusRow.textContent = '⚪ 未检测到运行中的游戏进程'
            }

            const sensorModeStr = s.mode === 'appshot_integrated' ? '🔗 联动 dsh-plugin-appshot' : '🟢 原生 Win32 GDI 捕获 (开箱即用 · 防黑屏)'
            visionStatus.textContent = `${sensorModeStr} · 视觉神经: ${s.enabled ? '活跃' : '休眠'} · 动态流抑制: ${s.isDynamicStream ? '开启' : '休眠'}`
            visionStatus.style.color = '#10b981'
          }
        })
        .catch(() => {})

      panes.appendChild(pBox)
      return
    }

    if (id === 'click') {
      const clickBox = $('div', 'dshp-col')
      clickBox.style.display = 'flex'
      clickBox.style.flexDirection = 'column'
      clickBox.style.gap = '8px'

      const profile = TapProfileRegistry.get(activeCharacterId)
      const isWhale = (activeCharacterId === 'whale')

      // 1. 顶部状态与点击伴随语音开关
      const topRow = $('div')
      topRow.style.display = 'flex'
      topRow.style.justifyContent = 'space-between'
      topRow.style.alignItems = 'center'
      topRow.style.background = 'rgba(255, 255, 255, 0.04)'
      topRow.style.padding = '8px 10px'
      topRow.style.borderRadius = '8px'
      topRow.style.border = '1px solid rgba(255, 255, 255, 0.08)'

      const roleBadge = $('div')
      roleBadge.style.fontSize = '12px'
      roleBadge.style.fontWeight = 'bold'
      roleBadge.style.color = '#fff'
      roleBadge.innerHTML = `当前伴侣：<span style="color:var(--dshp-accent);">${activeCharInfo().name}</span> ${isWhale ? '<span style="font-size:10px;padding:1px 5px;background:rgba(255,193,7,0.15);color:#ffc107;border-radius:4px;border:1px solid rgba(255,193,7,0.3);margin-left:4px;">🔒 鲸鱼娘 (标准基准对象)</span>' : ''}`

      const voiceToggleBtn = $('button', 'dshp-btn' + (CFG.tapVoice !== false ? ' dshp-primary' : ''))
      voiceToggleBtn.style.padding = '3px 8px'
      voiceToggleBtn.style.fontSize = '11px'
      voiceToggleBtn.textContent = CFG.tapVoice !== false ? '🔊 点击伴随语音: 开' : '🔇 点击伴随语音: 关'
      voiceToggleBtn.title = '开启后，点击桌宠或点击演练时自动使用当前角色专属声线朗读台词（自动剥离标志语）'
      voiceToggleBtn.addEventListener('click', () => {
        CFG.tapVoice = !(CFG.tapVoice !== false)
        persistCfg()
        voiceToggleBtn.textContent = CFG.tapVoice ? '🔊 点击伴随语音: 开' : '🔇 点击伴随语音: 关'
        voiceToggleBtn.className = 'dshp-btn' + (CFG.tapVoice ? ' dshp-primary' : '')
        ui.bubble.show(CFG.tapVoice ? '已开启点击角色伴随语音！' : '已关闭点击语音，仅气泡展示', { duration: 2500 })
      })
      topRow.append(roleBadge, voiceToggleBtn)

      // 2. 标志语机制重要说明条 (用户明确要求)
      const tipBar = $('div')
      tipBar.style.fontSize = '11px'
      tipBar.style.padding = '6px 10px'
      tipBar.style.borderRadius = '6px'
      tipBar.style.background = 'rgba(114, 241, 184, 0.08)'
      tipBar.style.border = '1px solid rgba(114, 241, 184, 0.25)'
      tipBar.style.color = '#a3f7d2'
      tipBar.style.lineHeight = '1.5'
      tipBar.innerHTML = '💡 <b>动作标志语机制说明</b>：文本中 <code>（）</code> 内为<b>动作标志语</b>（如 <i>（脸红）</i>、<i>（晃龙角）</i>、<i>（轻摇金铃）</i>）。气泡中会完整呈现并联动动作表情，而<b>语音朗读时会自动省略括号中的动作标志语</b>，只口播纯人声台词！'

      // 2.5 状态交互演练卡片（思考中 / 看资料）
      const statusAuditionBar = $('div')
      statusAuditionBar.style.display = 'flex'
      statusAuditionBar.style.alignItems = 'center'
      statusAuditionBar.style.gap = '8px'
      statusAuditionBar.style.padding = '8px 10px'
      statusAuditionBar.style.background = 'rgba(255, 255, 255, 0.04)'
      statusAuditionBar.style.borderRadius = '8px'
      statusAuditionBar.style.border = '1px solid rgba(255, 255, 255, 0.08)'

      const statusTitle = $('span')
      statusTitle.style.fontSize = '11.5px'
      statusTitle.style.fontWeight = 'bold'
      statusTitle.style.color = '#72f1b8'
      statusTitle.style.whiteSpace = 'nowrap'
      statusTitle.textContent = '💡 状态交互演练：'

      const thinkAuditionBtn = $('button', 'dshp-btn', '💭 演练「思考中」')
      thinkAuditionBtn.style.flex = '1'
      thinkAuditionBtn.style.padding = '5px 8px'
      thinkAuditionBtn.style.fontSize = '11px'
      thinkAuditionBtn.title = '演练伴侣在思考中的专属互动台词与语音（气泡带标志语，语音自动省略标志语）'
      thinkAuditionBtn.addEventListener('click', () => {
        profile.triggerThinkingLine()
      })

      const readAuditionBtn = $('button', 'dshp-btn', '📖 演练「看资料」')
      readAuditionBtn.style.flex = '1'
      readAuditionBtn.style.padding = '5px 8px'
      readAuditionBtn.style.fontSize = '11px'
      readAuditionBtn.title = '演练伴侣在查阅资料时的专属互动台词与语音（气泡带标志语，语音自动省略标志语）'
      readAuditionBtn.addEventListener('click', () => {
        profile.triggerReadingLine()
      })

      statusAuditionBar.append(statusTitle, thinkAuditionBtn, readAuditionBtn)

      // 3. 手动输入自定义台词卡片
      const inputCard = $('div', 'dshp-panel-card')
      inputCard.style.padding = '8px 10px'
      inputCard.style.background = 'rgba(255, 255, 255, 0.04)'
      inputCard.style.borderRadius = '8px'
      inputCard.style.border = '1px solid rgba(255, 255, 255, 0.08)'
      inputCard.style.display = 'flex'
      inputCard.style.flexDirection = 'column'
      inputCard.style.gap = '6px'

      const inputTitle = $('div', null, '✏️ 手动输入点击台词（支持括号动作标志语）：')
      inputTitle.style.fontSize = '11.5px'
      inputTitle.style.fontWeight = 'bold'
      inputTitle.style.color = '#eee'

      const textInput = document.createElement('textarea')
      textInput.rows = 2
      textInput.style.width = '100%'
      textInput.style.boxSizing = 'border-box'
      textInput.style.fontSize = '11px'
      textInput.style.padding = '5px 8px'
      textInput.style.borderRadius = '4px'
      textInput.style.background = '#1b1b1b'
      textInput.style.color = '#fff'
      textInput.style.border = '1px solid #333'
      textInput.style.resize = 'none'
      textInput.placeholder = '例如：（害羞低头）主人，今天有什么任务交给人家吗？'

      // 实时双轨预览条
      const previewBox = $('div')
      previewBox.style.fontSize = '10.5px'
      previewBox.style.padding = '5px 8px'
      previewBox.style.background = 'rgba(0, 0, 0, 0.25)'
      previewBox.style.borderRadius = '4px'
      previewBox.style.border = '1px dashed rgba(255, 255, 255, 0.15)'
      previewBox.style.color = '#ccc'
      previewBox.style.lineHeight = '1.45'

      function updatePreview() {
        const val = textInput.value.trim()
        if (!val) {
          previewBox.innerHTML = '<span style="color:#666;">💬 实时双轨预览：输入内容后，此处将直观分离气泡文本与朗读人声文本...</span>'
          return
        }
        const p = ActionCueParser.parse(val)
        previewBox.innerHTML = `💬 <b>气泡将显示</b>：<span style="color:#72f1b8;">${p.bubbleText}</span><br>🔊 <b>语音将朗读</b>：<span style="color:#7b9bff;">${p.speechText || '<i style="color:#888;">(纯动作描写，语音自动静默)</i>'}</span>`
      }
      updatePreview()
      textInput.addEventListener('input', updatePreview)

      // 归属部位与情绪联动选择
      const optRow = $('div')
      optRow.style.display = 'flex'
      optRow.style.alignItems = 'center'
      optRow.style.gap = '6px'
      optRow.style.fontSize = '11px'
      optRow.style.color = '#aaa'

      const zoneSelect = document.createElement('select')
      zoneSelect.style.fontSize = '11px'
      zoneSelect.style.padding = '2px 4px'
      zoneSelect.style.background = '#222'
      zoneSelect.style.color = '#fff'
      zoneSelect.style.borderRadius = '4px'
      zoneSelect.style.border = '1px solid #444'
      zoneSelect.innerHTML = '<option value="head">摸头 (Head)</option><option value="body">戳身子 (Body)</option>'

      const moodSelect = document.createElement('select')
      moodSelect.style.fontSize = '11px'
      moodSelect.style.padding = '2px 4px'
      moodSelect.style.background = '#222'
      moodSelect.style.color = '#fff'
      moodSelect.style.borderRadius = '4px'
      moodSelect.style.border = '1px solid #444'
      moodSelect.innerHTML = '<option value="">自动由标志语推断</option><option value="happy">开心 (happy)</option><option value="shy">害羞 (shy)</option><option value="love">心动 (love)</option><option value="smug">傲娇 (smug)</option><option value="pout">噘嘴 (pout)</option><option value="grumpy">生气 (grumpy)</option><option value="playful">闪躲 (playful)</option><option value="alert">警觉 (alert)</option><option value="confused">困惑 (confused)</option>'

      optRow.append($('span', null, '触发部位:'), zoneSelect, $('span', null, '表情联动:'), moodSelect)

      const actBtnRow = $('div')
      actBtnRow.style.display = 'flex'
      actBtnRow.style.gap = '6px'
      actBtnRow.style.marginTop = '2px'

      const testBtn = $('button', 'dshp-btn', '▶ 试听演练')
      testBtn.style.flex = '1'
      testBtn.style.padding = '4px'
      testBtn.style.fontSize = '11px'
      testBtn.title = '让桌宠立即演练此台词（气泡显示含标志语，语音自动省略标志语）'
      testBtn.addEventListener('click', () => {
        const val = textInput.value.trim() || (isWhale ? '（脸红）不要突然摸头啦……再摸一下也不是不行。' : '（轻轻歪头）主人，有什么吩咐交给人家吗？')
        profile.triggerLine({
          text: val,
          mood: moodSelect.value || null,
          zone: zoneSelect.value,
        })
      })

      const addBtn = $('button', 'dshp-btn dshp-primary', '➕ 添加到当前伴侣词库')
      addBtn.style.flex = '1.3'
      addBtn.style.padding = '4px'
      addBtn.style.fontSize = '11px'
      addBtn.addEventListener('click', () => {
        const val = textInput.value.trim()
        if (!val) {
          alert('请先输入台词内容哦~')
          return
        }
        if (isWhale) {
          if (!confirm('鲸鱼娘为系统标准基准对象，原版词库受保护。是否确认将其作为扩展台词追加？')) return
        }
        profile.addCustomLine(zoneSelect.value, val, moodSelect.value || null)
        ui.bubble.show(`已成功为「${activeCharInfo().name}」添加点击台词！`, { duration: 2500 })
        textInput.value = ''
        updatePreview()
        renderPane('click')
      })

      actBtnRow.append(testBtn, addBtn)
      inputCard.append(inputTitle, textInput, previewBox, optRow, actBtnRow)

      // 4. 台词列表卡片
      const listCard = $('div')
      listCard.style.display = 'flex'
      listCard.style.flexDirection = 'column'
      listCard.style.gap = '6px'

      const listHeader = $('div')
      listHeader.style.display = 'flex'
      listHeader.style.justifyContent = 'space-between'
      listHeader.style.alignItems = 'center'

      const listTitle = $('div', null, `📖 「${activeCharInfo().name}」点击台词库（共 ${profile.getAllLines().length} 句）：`)
      listTitle.style.fontSize = '11.5px'
      listTitle.style.fontWeight = 'bold'
      listTitle.style.color = '#72f1b8'
      listHeader.appendChild(listTitle)

      const linesScroll = $('div')
      linesScroll.style.display = 'flex'
      linesScroll.style.flexDirection = 'column'
      linesScroll.style.gap = '6px'
      linesScroll.style.maxHeight = '230px'
      linesScroll.style.overflowY = 'auto'

      const allItems = profile.getAllLines()
      for (const item of allItems) {
        const lineCard = $('div')
        lineCard.style.display = 'flex'
        lineCard.style.flexDirection = 'column'
        lineCard.style.gap = '4px'
        lineCard.style.padding = '6px 8px'
        lineCard.style.background = 'rgba(0, 0, 0, 0.28)'
        lineCard.style.borderRadius = '6px'
        lineCard.style.border = '1px solid rgba(255, 255, 255, 0.06)'

        const parsed = ActionCueParser.parse(item.text)

        // 第一行：部位标签 + 文本 + 操作按钮
        const r1 = $('div')
        r1.style.display = 'flex'
        r1.style.alignItems = 'center'
        r1.style.justifyContent = 'space-between'
        r1.style.gap = '6px'

        const leftGroup = $('div')
        leftGroup.style.display = 'flex'
        leftGroup.style.alignItems = 'center'
        leftGroup.style.gap = '5px'
        leftGroup.style.overflow = 'hidden'
        leftGroup.style.flex = '1'

        const zoneBadge = $('span', null, item.zone === 'head' ? '摸头' : '戳身')
        zoneBadge.style.fontSize = '9.5px'
        zoneBadge.style.padding = '1px 4px'
        zoneBadge.style.borderRadius = '3px'
        zoneBadge.style.background = item.zone === 'head' ? 'rgba(124, 92, 255, 0.2)' : 'rgba(114, 241, 184, 0.2)'
        zoneBadge.style.color = item.zone === 'head' ? '#a58aff' : '#72f1b8'
        zoneBadge.style.border = item.zone === 'head' ? '1px solid rgba(124, 92, 255, 0.4)' : '1px solid rgba(114, 241, 184, 0.4)'
        zoneBadge.style.flexShrink = '0'

        const textEl = $('span', null, item.text)
        textEl.style.fontSize = '11px'
        textEl.style.color = '#eee'
        textEl.style.whiteSpace = 'nowrap'
        textEl.style.overflow = 'hidden'
        textEl.style.textOverflow = 'ellipsis'
        textEl.title = item.text

        leftGroup.append(zoneBadge, textEl)

        const btnGroup = $('div')
        btnGroup.style.display = 'flex'
        btnGroup.style.alignItems = 'center'
        btnGroup.style.gap = '4px'
        btnGroup.style.flexShrink = '0'

        const triggerBtn = $('button', 'dshp-btn dshp-primary', '👆 演练')
        triggerBtn.style.padding = '2px 6px'
        triggerBtn.style.fontSize = '10px'
        triggerBtn.title = '在桌宠身上演练此动作与语音'
        triggerBtn.addEventListener('click', () => {
          profile.triggerLine(item)
        })
        btnGroup.appendChild(triggerBtn)

        if (item.custom) {
          const delBtn = $('button', 'dshp-btn', '🗑️')
          delBtn.style.padding = '2px 5px'
          delBtn.style.fontSize = '10px'
          delBtn.style.color = '#ff6b6b'
          delBtn.title = '删除此条自定义台词'
          delBtn.addEventListener('click', () => {
            if (!confirm(`确认删除此台词「${item.text}」吗？`)) return
            profile.deleteCustomLine(item.id)
            renderPane('click')
          })
          btnGroup.appendChild(delBtn)
        }

        r1.append(leftGroup, btnGroup)

        // 第二行：语音口播内容指示
        const r2 = $('div')
        r2.style.fontSize = '10px'
        r2.style.color = '#888'
        r2.style.overflow = 'hidden'
        r2.style.textOverflow = 'ellipsis'
        r2.style.whiteSpace = 'nowrap'
        r2.innerHTML = `🔊 语音口播：<span style="color:#aaa;">${parsed.speechText ? '“' + parsed.speechText + '”' : '（纯动作描写，语音静默）'}</span>`

        lineCard.append(r1, r2)
        linesScroll.appendChild(lineCard)
      }

      listCard.append(listHeader, linesScroll)
      clickBox.append(topRow, tipBar, statusAuditionBar, inputCard, listCard)
      panes.appendChild(clickBox)
      return
    }

    if (id === 'wallet') {
      const box = $('div', 'dshp-col')
      box.style.display = 'flex'
      box.style.flexDirection = 'column'
      box.style.gap = '10px'
      box.style.padding = '4px 2px'

      // 实时获取最新数据并渲染
      hudFetch(false).then(() => {
        if (ui.menu.focused === 'wallet') refreshWalletContent()
      })

      const walletCard = $('div')
      walletCard.style.background = 'linear-gradient(135deg, rgba(124, 92, 255, 0.12), rgba(0, 180, 216, 0.08))'
      walletCard.style.border = '1px solid rgba(124, 92, 255, 0.3)'
      walletCard.style.borderRadius = '10px'
      walletCard.style.padding = '12px'
      walletCard.style.display = 'flex'
      walletCard.style.flexDirection = 'column'
      walletCard.style.gap = '8px'

      function refreshWalletContent() {
        walletCard.textContent = ''
        const d = hud.data || {}
        const peak = d.isPeak === true
        const t = hud.turn || {}

        // 顶栏：峰谷标签与倒计时
        const topRow = $('div')
        topRow.style.display = 'flex'
        topRow.style.justifyContent = 'space-between'
        topRow.style.alignItems = 'center'

        const badge = $('span', 'dshp-hud-tag ' + (peak ? 'dshp-peak' : 'dshp-valley'))
        badge.textContent = d.isPeak === undefined || d.isPeak === null ? '—' : peak ? '⚡ 高峰期（标准资费）' : '🌙 低谷期（半价特惠）'
        badge.style.fontWeight = 'bold'
        badge.style.fontSize = '12px'

        const cd = $('span', 'dshp-hint', d.peakNextChangeAt ? `倒计时：${humanLeft(d.peakNextChangeAt - Math.floor(Date.now() / 1000))}` : '')
        cd.style.fontSize = '11px'
        topRow.append(badge, cd)

        // 中间：总余额展示
        const balRow = $('div')
        balRow.style.display = 'flex'
        balRow.style.flexDirection = 'column'
        balRow.style.gap = '2px'
        balRow.style.margin = '4px 0'

        const balLabel = $('div', 'dshp-hint', 'DeepSeek 钱包总余额')
        balLabel.style.fontSize = '11px'
        const balValue = $('div', null, d.ok === false && d.code === 'NO_KEY' ? '未配置 API KEY' : (d.totalBalance != null ? money(d.totalBalance, d.currency) : '¥ —'))
        balValue.style.fontSize = '22px'
        balValue.style.fontWeight = 'bold'
        balValue.style.color = '#7c5cff'
        balRow.append(balLabel, balValue)

        // 统计卡片网格：今日消耗与本轮消耗
        const statsGrid = $('div')
        statsGrid.style.display = 'grid'
        statsGrid.style.gridTemplateColumns = '1fr 1fr'
        statsGrid.style.gap = '8px'

        const todayBox = $('div')
        todayBox.style.background = 'rgba(0, 0, 0, 0.2)'
        todayBox.style.padding = '6px 8px'
        todayBox.style.borderRadius = '6px'
        const todayTitle = $('div', 'dshp-hint', '今日消耗')
        todayTitle.style.fontSize = '10.5px'
        const todayVal = $('div', null, d.todayUsage != null ? money(d.todayUsage, d.todayUsageCurrency || d.currency) : '—')
        todayVal.style.fontWeight = 'bold'
        todayVal.style.fontSize = '13px'
        todayBox.append(todayTitle, todayVal)

        const turnBox = $('div')
        turnBox.style.background = 'rgba(0, 0, 0, 0.2)'
        turnBox.style.padding = '6px 8px'
        turnBox.style.borderRadius = '6px'
        const turnTitle = $('div', 'dshp-hint', '本轮消耗')
        turnTitle.style.fontSize = '10.5px'
        const turnVal = $('div', null, t.tokens ? `${Number(t.tokens).toLocaleString()} tk` : (t.amount != null ? money(t.amount, d.currency) : '—'))
        turnVal.style.fontWeight = 'bold'
        turnVal.style.fontSize = '13px'
        turnBox.append(turnTitle, turnVal)

        statsGrid.append(todayBox, turnBox)

        // 操作按钮行：刷新与桌面HUD切换
        const btnRow = $('div', 'dshp-row')
        btnRow.style.display = 'flex'
        btnRow.style.gap = '6px'
        btnRow.style.marginTop = '6px'

        const refreshBtn = $('button', 'dshp-btn dshp-primary', '🔄 立即刷新')
        refreshBtn.style.flex = '1'
        refreshBtn.style.fontSize = '11.5px'
        refreshBtn.style.padding = '5px 8px'
        refreshBtn.addEventListener('click', async () => {
          refreshBtn.textContent = '刷新中...'
          refreshBtn.disabled = true
          await hudFetch(true)
          refreshWalletContent()
        })

        const hudToggleBtn = $('button', 'dshp-btn', hud.open ? '📌 关闭桌面浮标' : '📌 开启桌面浮标')
        hudToggleBtn.style.flex = '1'
        hudToggleBtn.style.fontSize = '11.5px'
        hudToggleBtn.style.padding = '5px 8px'
        hudToggleBtn.addEventListener('click', () => {
          if (hud.open) closeHud()
          else openHud({ flash: true })
          hudToggleBtn.textContent = hud.open ? '📌 关闭桌面浮标' : '📌 开启桌面浮标'
        })

        btnRow.append(refreshBtn, hudToggleBtn)

        const footNote = $('div', 'dshp-hint', (hud.source ? `数据来源：${hud.source === 'self' ? '桌宠直连' : 'DSH 服务'}` : '数据来源：接口') + (hud.fetchedAt ? ` · ${new Date(hud.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''))
        footNote.style.fontSize = '10px'
        footNote.style.color = '#888'

        walletCard.append(topRow, balRow, statsGrid, btnRow, footNote)
      }

      refreshWalletContent()
      box.appendChild(walletCard)
      panes.appendChild(box)
      return
    }

    if (id === 'face') {
      if (activeCharacterId === 'whale') {
        const grid = $('div', 'dshp-grid')
        const byExpr = new Map()
        const BANNED_MOODS = new Set(['dizzy'])
        for (const key of Object.keys(MOOD_FACE)) {
          if (key === 'neutral') continue
          const expr = MOOD_FACE[key]
          if (!expr || BANNED_MOODS.has(key)) continue
          if (!EXPR[expr] || expr === '呆呆眼' || expr === '晕晕') continue
          if (!byExpr.has(expr)) byExpr.set(expr, [])
          byExpr.get(expr).push(key)
        }
        const neutral = $('button', 'dshp-chip', '平常')
        if (!rig.override && !rig.user.face) neutral.classList.add('dshp-on')
        neutral.title = '立刻回到平常脸（她自己的表情也交还给她）'
        neutral.addEventListener('click', () => {
          clearUserFace()
          clearReaction()
          act({ mood: 'neutral', props: IDLE_PROPS, ms: 800 })
          renderPane('face')
        })
        grid.appendChild(neutral)
        for (const [expr, keys] of byExpr) {
          const rep = keys.find((k) => FACE_ACT[k]) || keys[0]
          const lines = (FACE_ACT[rep] && FACE_ACT[rep].lines) || []
          const b = $('button', 'dshp-chip', expr)
          if (rig.override && rig.override.face === expr) b.classList.add('dshp-on')
          b.title = keys.join(' / ') + (lines.length ? `\n她会说：${lines[0]}` : '')
          b.addEventListener('click', () => {
            clearUserFace()
            playItem('face', rep)
            renderPane('face')
          })
          grid.appendChild(b)
        }
        panes.append(
          grid,
          $('div', 'dshp-hint', '点一下 = 换脸 + 说一句配好的话，三四秒后自己让位（平常状态永远是平常脸）。\n💡 提示：当前伴侣为「鲸鱼娘」（系统基准黄金模型，内置表情与道具固定）。如需自定义配置其他模型的表情动作映射，请在「角色」菜单切换为兔兔、玉玉或新导入的角色。'),
        )
        return
      }

      // --- 非鲸鱼娘模型：表情与动作映射面板 (参考桌面灵 GUI 结构) ---
      let currentMappingSubView = 'mapping'
      async function renderMappingPane() {
        const char = activeCharInfo()
        const box = $('div', 'dshp-col')
        box.style.display = 'flex'
        box.style.flexDirection = 'column'
        box.style.gap = '10px'

        if (!currentCharacterAssets || currentCharacterAssets.characterId !== activeCharacterId || (!currentCharacterAssets.expressions.length && !currentCharacterAssets.motions.length)) {
          const loadingHint = $('div', 'dshp-hint', '正在识别并载入模型表情与动作资产，请稍候...')
          box.appendChild(loadingHint)
          panes.appendChild(box)
          await loadCharacterAssets(activeCharacterId)
          if (ui.menu.focused !== 'face') return
          box.textContent = ''
        }

        // 顶部角色提示与状态条
        const topRow = $('div', 'dshp-row')
        topRow.style.display = 'flex'
        topRow.style.justifyContent = 'space-between'
        topRow.style.alignItems = 'center'

        const title = $('div', 'dshp-hint', `当前伴侣：${char.name}（${char.title}）`)
        title.style.fontWeight = 'bold'
        title.style.color = '#7c5cff'
        title.style.fontSize = '13px'

        const modeToggle = $('div', 'dshp-row')
        modeToggle.style.gap = '6px'
        const btnTabMapping = $('button', 'dshp-btn dshp-primary', '⚙ 表情动作映射')
        const btnTabPlay = $('button', 'dshp-btn', '🎭 实时表情点播')
        btnTabMapping.style.fontSize = '11px'
        btnTabPlay.style.fontSize = '11px'
        btnTabMapping.style.padding = '4px 8px'
        btnTabPlay.style.padding = '4px 8px'

        modeToggle.append(btnTabMapping, btnTabPlay)
        topRow.append(title, modeToggle)
        box.appendChild(topRow)

        const contentArea = $('div')
        box.appendChild(contentArea)
        if (!panes.contains(box)) panes.appendChild(box)

        let currentSubView = currentMappingSubView || 'mapping'

        function showSubView(v) {
          currentSubView = v
          currentMappingSubView = v
          contentArea.textContent = ''
          if (v === 'mapping') {
            btnTabMapping.classList.add('dshp-primary')
            btnTabPlay.classList.remove('dshp-primary')
            renderMappingView()
          } else {
            btnTabPlay.classList.add('dshp-primary')
            btnTabMapping.classList.remove('dshp-primary')
            renderPlayView()
          }
        }

        btnTabMapping.addEventListener('click', () => showSubView('mapping'))
        btnTabPlay.addEventListener('click', () => showSubView('play'))

        function renderMappingView() {
          const wrap = $('div')
          wrap.style.display = 'flex'
          wrap.style.flexDirection = 'column'
          wrap.style.gap = '10px'

          const bar = $('div', 'dshp-row')
          bar.style.display = 'flex'
          bar.style.gap = '8px'
          bar.style.alignItems = 'center'
          bar.style.flexWrap = 'wrap'

          const smartBtn = $('button', 'dshp-btn', '✨ 一键智能自动匹配')
          smartBtn.style.fontSize = '11.5px'
          smartBtn.style.padding = '5px 10px'

          const saveBtn = $('button', 'dshp-btn dshp-primary', '💾 保存映射配置')
          saveBtn.style.fontSize = '11.5px'
          saveBtn.style.padding = '5px 12px'
          saveBtn.style.background = '#7c5cff'
          saveBtn.style.color = '#fff'
          saveBtn.style.fontWeight = 'bold'

          const statusNote = $('div', 'dshp-hint', `已检测到 ${currentCharacterAssets.expressions.length} 个表情 · ${currentCharacterAssets.motions.length} 个动作`)
          statusNote.style.fontSize = '11px'
          statusNote.style.color = '#888'

          bar.append(smartBtn, saveBtn, statusNote)
          wrap.appendChild(bar)

          const expSelects = {}
          const motSelects = {}

          // 分组 1：基础情绪映射
          const secMood = $('div')
          secMood.style.border = '1px solid rgba(124, 92, 255, 0.25)'
          secMood.style.borderRadius = '8px'
          secMood.style.padding = '10px'
          secMood.style.background = 'rgba(255, 255, 255, 0.03)'

          const secMoodTitle = $('div', 'dshp-hint', '▼ 基础情绪映射（对接 AI 聊天与伴侣情感表达）')
          secMoodTitle.style.fontWeight = 'bold'
          secMoodTitle.style.marginBottom = '8px'
          secMoodTitle.style.color = '#9a82ff'
          secMood.appendChild(secMoodTitle)

          const moodGrid = $('div')
          moodGrid.style.display = 'grid'
          moodGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(230px, 1fr))'
          moodGrid.style.gap = '6px'
          moodGrid.style.width = '100%'
          moodGrid.style.boxSizing = 'border-box'

          for (const slot of STANDARD_EMOTION_SLOTS) {
            const row = $('div', 'dshp-map-row')
            row.style.display = 'flex'
            row.style.alignItems = 'center'
            row.style.gap = '6px'
            row.style.width = '100%'
            row.style.boxSizing = 'border-box'
            row.style.background = 'rgba(0, 0, 0, 0.15)'
            row.style.padding = '4px 6px'
            row.style.borderRadius = '6px'
            row.style.overflow = 'hidden'

            const label = $('span', null, `${slot.icon} ${slot.label}`)
            label.style.width = '84px'
            label.style.minWidth = '80px'
            label.style.maxWidth = '90px'
            label.style.fontSize = '11.5px'
            label.style.flexShrink = '0'
            label.style.overflow = 'hidden'
            label.style.textOverflow = 'ellipsis'
            label.style.whiteSpace = 'nowrap'
            label.title = `${slot.label}: ${slot.desc}`

            const sel = document.createElement('select')
            sel.style.flex = '1 1 0%'
            sel.style.minWidth = '0'
            sel.style.width = '0'
            sel.style.maxWidth = '100%'
            sel.style.overflow = 'hidden'
            sel.style.textOverflow = 'ellipsis'
            sel.style.whiteSpace = 'nowrap'
            sel.style.fontSize = '11px'
            sel.style.padding = '3px 4px'
            sel.style.borderRadius = '4px'
            sel.style.background = 'var(--dshp-bg, #222)'
            sel.style.color = 'var(--dshp-fg, #eee)'
            sel.style.border = '1px solid var(--dshp-line, #444)'

            const optNone = document.createElement('option')
            optNone.value = ''
            optNone.textContent = '(未映射 / 不启用)'
            sel.appendChild(optNone)

            const curVal = (char.expressions && char.expressions[slot.id]) || ''

            for (const e of currentCharacterAssets.expressions) {
              const opt = document.createElement('option')
              opt.value = e.file
              opt.textContent = `${e.name} (${e.file})`
              if (curVal === e.file || curVal === e.name) opt.selected = true
              sel.appendChild(opt)
            }

            expSelects[slot.id] = sel

            const btnTest = $('button', 'dshp-btn', '▶ 试看')
            btnTest.style.padding = '2px 8px'
            btnTest.style.fontSize = '11px'
            btnTest.style.flexShrink = '0'
            btnTest.style.whiteSpace = 'nowrap'
            btnTest.title = '在模型上实时试看这个表情（3.5秒）'
            btnTest.addEventListener('click', () => {
              const v = sel.value
              if (!v) {
                ui.bubble.show('请先选择表情文件！', { duration: 1500 })
                return
              }
              btnTest.textContent = '👀 播放中'
              btnTest.disabled = true
              previewExpression(v)
              setTimeout(() => {
                btnTest.textContent = '▶ 试看'
                btnTest.disabled = false
              }, 3500)
            })

            row.append(label, sel, btnTest)
            moodGrid.appendChild(row)
          }
          secMood.appendChild(moodGrid)
          wrap.appendChild(secMood)

          // 分组 2：交互与动作映射
          const secMot = $('div')
          secMot.style.border = '1px solid rgba(124, 92, 255, 0.25)'
          secMot.style.borderRadius = '8px'
          secMot.style.padding = '10px'
          secMot.style.background = 'rgba(255, 255, 255, 0.03)'

          const secMotTitle = $('div', 'dshp-hint', '▼ 交互与动作映射（待机循环与点击动作）')
          secMotTitle.style.fontWeight = 'bold'
          secMotTitle.style.marginBottom = '8px'
          secMotTitle.style.color = '#9a82ff'
          secMot.appendChild(secMotTitle)

          const motGrid = $('div')
          motGrid.style.display = 'grid'
          motGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(230px, 1fr))'
          motGrid.style.gap = '6px'
          motGrid.style.width = '100%'
          motGrid.style.boxSizing = 'border-box'

          for (const slot of STANDARD_ACTION_SLOTS) {
            const row = $('div', 'dshp-map-row')
            row.style.display = 'flex'
            row.style.alignItems = 'center'
            row.style.gap = '6px'
            row.style.width = '100%'
            row.style.boxSizing = 'border-box'
            row.style.background = 'rgba(0, 0, 0, 0.15)'
            row.style.padding = '4px 6px'
            row.style.borderRadius = '6px'
            row.style.overflow = 'hidden'

            const label = $('span', null, `${slot.icon} ${slot.label}`)
            label.style.width = '84px'
            label.style.minWidth = '80px'
            label.style.maxWidth = '90px'
            label.style.fontSize = '11.5px'
            label.style.flexShrink = '0'
            label.style.overflow = 'hidden'
            label.style.textOverflow = 'ellipsis'
            label.style.whiteSpace = 'nowrap'
            label.title = slot.desc

            const sel = document.createElement('select')
            sel.style.flex = '1 1 0%'
            sel.style.minWidth = '0'
            sel.style.width = '0'
            sel.style.maxWidth = '100%'
            sel.style.overflow = 'hidden'
            sel.style.textOverflow = 'ellipsis'
            sel.style.whiteSpace = 'nowrap'
            sel.style.fontSize = '11px'
            sel.style.padding = '3px 4px'
            sel.style.borderRadius = '4px'
            sel.style.background = 'var(--dshp-bg, #222)'
            sel.style.color = 'var(--dshp-fg, #eee)'
            sel.style.border = '1px solid var(--dshp-line, #444)'

            const optNone = document.createElement('option')
            optNone.value = ''
            optNone.textContent = '(未映射 / 不启用)'
            sel.appendChild(optNone)

            const curVal = (char.motions && char.motions[slot.id]) || ''

            for (const m of currentCharacterAssets.motions) {
              const opt = document.createElement('option')
              opt.value = m.file
              opt.textContent = `${m.name} (${m.file})`
              if (curVal === m.file || curVal === m.name) opt.selected = true
              sel.appendChild(opt)
            }

            motSelects[slot.id] = sel

            const btnPlay = $('button', 'dshp-btn', '▶ 播放')
            btnPlay.style.padding = '2px 8px'
            btnPlay.style.fontSize = '11px'
            btnPlay.style.flexShrink = '0'
            btnPlay.style.whiteSpace = 'nowrap'
            btnPlay.title = '在模型上播放该动作'
            btnPlay.addEventListener('click', () => {
              const v = sel.value
              if (!v) {
                ui.bubble.show('请先选择动作文件！', { duration: 1500 })
                return
              }
              btnPlay.textContent = '🎬 播放中'
              btnPlay.disabled = true
              previewMotion(v)
              setTimeout(() => {
                btnPlay.textContent = '▶ 播放'
                btnPlay.disabled = false
              }, 3000)
            })

            row.append(label, sel, btnPlay)
            motGrid.appendChild(row)
          }
          secMot.appendChild(motGrid)
          wrap.appendChild(secMot)

          // 一键智能匹配
          smartBtn.addEventListener('click', () => {
            let matchCount = 0
            for (const slot of STANDARD_EMOTION_SLOTS) {
              const sel = expSelects[slot.id]
              if (!sel) continue
              for (const e of currentCharacterAssets.expressions) {
                const lower = (e.name + ' ' + e.file).toLowerCase()
                if (slot.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
                  sel.value = e.file
                  matchCount++
                  break
                }
              }
            }
            for (const slot of STANDARD_ACTION_SLOTS) {
              const sel = motSelects[slot.id]
              if (!sel) continue
              for (const m of currentCharacterAssets.motions) {
                const lower = (m.name + ' ' + m.file).toLowerCase()
                if (slot.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
                  sel.value = m.file
                  matchCount++
                  break
                }
              }
            }
            ui.bubble.show(`智能匹配完成！已为您自动匹配 ${matchCount} 项，满意后请点击保存。`, { duration: 3500 })
          })

          // 保存配置
          saveBtn.addEventListener('click', async () => {
            saveBtn.textContent = '正在保存...'
            saveBtn.disabled = true
            const exps = {}
            const mots = {}
            for (const [sId, sel] of Object.entries(expSelects)) {
              if (sel.value) exps[sId] = sel.value
            }
            for (const [sId, sel] of Object.entries(motSelects)) {
              if (sel.value) mots[sId] = sel.value
            }
            // 优先写入 localStorage，确保即使离线或未重启也必定即时生效
            try {
              localStorage.setItem('dsh_pet_mapping_' + activeCharacterId, JSON.stringify({ expressions: exps, motions: mots }))
            } catch (e) {}

            char.expressions = exps
            char.motions = mots
            for (const [slot, expFile] of Object.entries(exps)) {
              if (expFile && EXPR[expFile]) MOOD_FACE[slot] = expFile
            }
            if (MOOD_FACE.happy) MOOD_FACE.joy = MOOD_FACE.happy
            if (MOOD_FACE.angry) MOOD_FACE.grumpy = MOOD_FACE.angry
            if (MOOD_FACE.shy) MOOD_FACE.blush = MOOD_FACE.shy

            try {
              const resData = await apiFetch(BASE + '/save-character-mapping', {
                method: 'POST',
                body: JSON.stringify({
                  characterId: activeCharacterId,
                  expressions: exps,
                  motions: mots,
                }),
              })
              ui.bubble.show(`${char.name} 的表情与动作映射配置已保存并即时生效！`, { duration: 3000 })
            } catch (err) {
              ui.bubble.show(`${char.name} 的映射已保存至本地，即刻生效！`, { duration: 3000 })
            } finally {
              saveBtn.textContent = '💾 保存映射配置'
              saveBtn.disabled = false
            }
          })

          contentArea.appendChild(wrap)
        }

        function renderPlayView() {
          const wrap = $('div')
          wrap.style.display = 'flex'
          wrap.style.flexDirection = 'column'
          wrap.style.gap = '10px'

          const grid = $('div', 'dshp-grid')
          grid.style.display = 'flex'
          grid.style.flexWrap = 'wrap'
          grid.style.gap = '6px'

          const neutralBtn = $('button', 'dshp-chip', '平常 (neutral)')
          if (!rig.override && !rig.user.face) neutralBtn.classList.add('dshp-on')
          neutralBtn.addEventListener('click', () => {
            clearUserFace()
            clearReaction()
            act({ mood: 'neutral', props: IDLE_PROPS, ms: 800 })
            renderPane('face')
          })
          grid.appendChild(neutralBtn)

          const exps = char.expressions || {}
          let hasAny = false

          for (const slot of STANDARD_EMOTION_SLOTS) {
            const expFile = exps[slot.id]
            if (!expFile || !EXPR[expFile]) continue
            hasAny = true
            const btn = $('button', 'dshp-chip', `${slot.icon} ${slot.label}`)
            if (rig.override && rig.override.face === expFile) btn.classList.add('dshp-on')
            btn.addEventListener('click', () => {
              clearUserFace()
              act({ mood: slot.id, face: expFile, ms: 3500 })
              renderPane('face')
            })
            grid.appendChild(btn)
          }

          if (!hasAny) {
            const tip = $('div', 'dshp-hint', '当前角色暂无已映射的表情，请在「⚙ 表情动作映射」子页中配置或点击一键智能匹配！')
            tip.style.padding = '10px'
            tip.style.color = '#ffaa44'
            wrap.appendChild(tip)
          }

          wrap.append(grid, $('div', 'dshp-hint', '点击表情按钮：角色立刻演绎该表情 3.5 秒并恢复平常状态。'))

          // 角色全部原生表情资产快速点播
          const unmappedExps = currentCharacterAssets.expressions.filter(
            (e) => !Object.values(exps).includes(e.file) && !Object.values(exps).includes(e.name)
          )
          if (unmappedExps.length > 0) {
            const extraHeader = $('div', 'dshp-hint', '▼ 角色原生表情资产（全部可用）')
            extraHeader.style.marginTop = '8px'
            extraHeader.style.fontWeight = 'bold'
            extraHeader.style.color = '#9a82ff'
            wrap.appendChild(extraHeader)

            const extraGrid = $('div', 'dshp-grid')
            extraGrid.style.display = 'flex'
            extraGrid.style.flexWrap = 'wrap'
            extraGrid.style.gap = '6px'

            for (const e of unmappedExps) {
              const b = $('button', 'dshp-chip', e.name)
              b.title = `原生文件: ${e.file}\n点击演绎表情（3.5秒）`
              if (rig.override && rig.override.face === e.file) b.classList.add('dshp-on')
              b.addEventListener('click', () => {
                clearUserFace()
                act({ mood: 'excited', face: e.file, ms: 3500 })
                renderPane('face')
              })
              extraGrid.appendChild(b)
            }
            wrap.appendChild(extraGrid)
          }

          contentArea.appendChild(wrap)
        }

        showSubView(currentSubView)
      }

      renderMappingPane()
      return
    }

    // --- 非鲸鱼娘角色的专属装扮与随身道具面板 (动态捕捉与分类扩展) ---
    function renderCustomCharacterPropsPane(cat) {
      const char = activeCharInfo()
      const classified = classifyCharacterAssets(currentCharacterAssets)
      const list = cat === 'decor' ? classified.decor : classified.scene

      const box = $('div', 'dshp-col')
      box.style.display = 'flex'
      box.style.flexDirection = 'column'
      box.style.gap = '8px'

      // 顶部条：标题 + 调整归类按钮
      const topBar = $('div', 'dshp-row')
      topBar.style.display = 'flex'
      topBar.style.justifyContent = 'space-between'
      topBar.style.alignItems = 'center'

      const topTitle = $('div', 'dshp-hint', `「${char.name}」专属${cat === 'decor' ? '装扮与服饰' : '随身道具与场景'}`)
      topTitle.style.fontWeight = 'bold'
      topTitle.style.color = '#7c5cff'

      const catMgrBtn = $('button', 'dshp-btn', '🏷️ 分类管理')
      catMgrBtn.style.fontSize = '10.5px'
      catMgrBtn.style.padding = '2px 6px'
      catMgrBtn.title = '为新导入或当前角色的资产自由调整归类（装饰/场景/动作/表情）'

      topBar.append(topTitle, catMgrBtn)
      box.appendChild(topBar)

      // 分类管理器折叠面板
      let mgrOpen = false
      const mgrPanel = $('div')
      mgrPanel.style.display = 'none'
      mgrPanel.style.padding = '8px'
      mgrPanel.style.borderRadius = '8px'
      mgrPanel.style.background = 'rgba(0, 0, 0, 0.3)'
      mgrPanel.style.border = '1px solid rgba(124, 92, 255, 0.25)'
      mgrPanel.style.flexDirection = 'column'
      mgrPanel.style.gap = '6px'

      catMgrBtn.addEventListener('click', () => {
        mgrOpen = !mgrOpen
        mgrPanel.style.display = mgrOpen ? 'flex' : 'none'
        catMgrBtn.textContent = mgrOpen ? '收起管理' : '🏷️ 分类管理'
      })

      const mgrTitle = $('div', 'dshp-hint', '💡 智能与可扩展资产归类：修改归类即时生效并保存到角色配置中')
      mgrTitle.style.fontSize = '11px'
      mgrPanel.appendChild(mgrTitle)

      const allItems = (currentCharacterAssets.expressions || []).concat(currentCharacterAssets.motions || [])
      const mgrGrid = $('div')
      mgrGrid.style.display = 'flex'
      mgrGrid.style.flexDirection = 'column'
      mgrGrid.style.gap = '4px'
      mgrGrid.style.maxHeight = '140px'
      mgrGrid.style.overflowY = 'auto'

      for (const item of allItems) {
        const row = $('div')
        row.style.display = 'flex'
        row.style.justifyContent = 'space-between'
        row.style.alignItems = 'center'
        row.style.padding = '2px 4px'
        row.style.background = 'rgba(255, 255, 255, 0.03)'
        row.style.borderRadius = '4px'

        const nameSpan = $('span', null, item.name + (item.file ? ` (${item.file})` : ''))
        nameSpan.style.fontSize = '11px'
        nameSpan.style.overflow = 'hidden'
        nameSpan.style.textOverflow = 'ellipsis'
        nameSpan.style.whiteSpace = 'nowrap'
        nameSpan.style.maxWidth = '150px'

        const cSel = document.createElement('select')
        cSel.style.fontSize = '10.5px'
        cSel.style.padding = '2px 4px'
        cSel.style.background = '#222'
        cSel.style.color = '#eee'
        cSel.style.borderRadius = '3px'
        cSel.style.border = '1px solid #444'

        const CATS = [
          ['decor', '🎀 装饰'],
          ['scene', '🍵 场景'],
          ['action', '⚡ 动作'],
          ['emotion', '😊 表情'],
        ]
        const curCat = item.category || (classified.decor.includes(item) ? 'decor' : classified.scene.includes(item) ? 'scene' : classified.action.includes(item) ? 'action' : 'emotion')
        for (const [cVal, cText] of CATS) {
          const opt = document.createElement('option')
          opt.value = cVal
          opt.textContent = cText
          if (curCat === cVal) opt.selected = true
          cSel.appendChild(opt)
        }

        cSel.addEventListener('change', async () => {
          item.category = cSel.value
          const newCats = { decor: [], scene: [], action: [], emotion: [] }
          for (const it of allItems) {
            const targetCat = it.category || 'emotion'
            if (newCats[targetCat]) newCats[targetCat].push(it.file)
          }
          try {
            await apiFetch(BASE + '/save-character-categories', {
              method: 'POST',
              body: JSON.stringify({ characterId: activeCharacterId, categories: newCats }),
            })
            currentCharacterAssets.categories = newCats
            ui.bubble.show(`「${item.name}」已调整为「${cSel.options[cSel.selectedIndex].text}」！`, { duration: 2000 })
            renderPane(cat)
          } catch (err) {}
        })

        row.append(nameSpan, cSel)
        mgrGrid.appendChild(row)
      }
      mgrPanel.appendChild(mgrGrid)
      box.appendChild(mgrPanel)

      // 资产按钮网格
      const grid = $('div', 'dshp-grid')
      grid.style.display = 'flex'
      grid.style.flexWrap = 'wrap'
      grid.style.gap = '6px'

      if (list.length === 0) {
        const emptyHint = $('div', 'dshp-hint', `当前伴侣「${char.name}」暂无识别为「${cat === 'decor' ? '装饰' : '场景'}」的资产。\n可点击上方「🏷️ 分类管理」将任意道具或模型参数分配至此菜单。`)
        emptyHint.style.padding = '8px 4px'
        emptyHint.style.color = '#ffaa44'
        grid.appendChild(emptyHint)
      } else {
        for (const item of list) {
          const on = rig.userProps.has(item.file) || rig.userProps.has(item.name)
          const b = $('button', 'dshp-chip', (cat === 'decor' ? '🎀 ' : '🍵 ') + item.name)
          if (on) b.classList.add('dshp-on')
          b.title = `参数/文件: ${item.file}\n点击开启/关闭（状态常驻保持）`
          b.addEventListener('click', () => {
            const nowOn = rig.userProps.has(item.file) || rig.userProps.has(item.name)
            if (nowOn) {
              rig.userProps.delete(item.file)
              rig.userProps.delete(item.name)
              if (activeCharacterId === 'tutu' && coreModel) {
                try {
                  coreModel.setParameterValueById('Param122', 0.0)
                  coreModel.setParameterValueById('Param123', 1.0)
                } catch (err) {}
              }
            } else {
              rig.userProps.add(item.file)
            }
            resolveRig()
            saveLayout({ props: Array.from(rig.userProps) })
            renderPane(cat)
          })
          grid.appendChild(b)
        }
      }

      const row = $('div', 'dshp-row')
      const clear = $('button', 'dshp-btn', '全部摘掉')
      clear.addEventListener('click', () => {
        clearProps()
        act({ mood: 'neutral', ms: 1200 })
        renderPane(cat)
      })
      row.appendChild(clear)

      box.append(
        grid,
        row,
        $('div', 'dshp-hint', cat === 'decor'
          ? `「${char.name}」专属装饰穿戴：点击穿戴/摘掉，状态会自动常驻保存。`
          : `「${char.name}」专属随身道具与场景摆设：点击拿取/收起，常驻生效。`)
      )
      panes.appendChild(box)
    }

    // --- 非鲸鱼娘角色的专属动作面板 ---
    function renderCustomCharacterActionsPane() {
      const char = activeCharInfo()
      const classified = classifyCharacterAssets(currentCharacterAssets)

      const box = $('div', 'dshp-col')
      box.style.display = 'flex'
      box.style.flexDirection = 'column'
      box.style.gap = '8px'

      const topBar = $('div', 'dshp-row')
      topBar.style.display = 'flex'
      topBar.style.justifyContent = 'space-between'
      topBar.style.alignItems = 'center'

      const topTitle = $('div', 'dshp-hint', `「${char.name}」专属动作与动画捕捉`)
      topTitle.style.fontWeight = 'bold'
      topTitle.style.color = '#7c5cff'

      topBar.appendChild(topTitle)
      box.appendChild(topBar)

      const grid = $('div', 'dshp-grid')
      grid.style.display = 'flex'
      grid.style.flexWrap = 'wrap'
      grid.style.gap = '6px'

      // 1. 动作动画 (.motion3.json)
      for (const m of (currentCharacterAssets.motions || [])) {
        const b = $('button', 'dshp-chip', '🎬 ' + m.name)
        b.title = `动作文件: ${m.file} (${m.duration ? m.duration + '秒' : '动画'})\n点击在伴侣模型上播放`
        b.addEventListener('click', () => {
          b.classList.add('dshp-on')
          previewMotion(m.file)
          setTimeout(() => {
            b.classList.remove('dshp-on')
            resumeCharacterIdleMotion()
          }, (m.duration ? m.duration * 1000 : 2500))
        })
        grid.appendChild(b)
      }

      // 2. 交互动作姿态 (action gestures)
      for (const e of classified.action) {
        if (e.file && e.file.endsWith('.motion3.json')) continue
        const b = $('button', 'dshp-chip', '⚡ ' + e.name)
        b.title = `姿态文件: ${e.file}\n点击演绎动作姿态（3.5秒）`
        b.addEventListener('click', () => {
          b.classList.add('dshp-on')
          previewExpression(e.file)
          setTimeout(() => {
            b.classList.remove('dshp-on')
            if (activeCharacterId === 'tutu' && coreModel) {
              try {
                coreModel.setParameterValueById('Param122', 0.0)
                coreModel.setParameterValueById('Param123', 1.0)
              } catch (err) {}
            }
            resumeCharacterIdleMotion()
          }, 3500)
        })
        grid.appendChild(b)
      }

      box.append(
        grid,
        $('div', 'dshp-hint', `「${char.name}」专属动作是一次性的：演绎完毕后自动优雅恢复平常待机状态。`)
      )
      panes.appendChild(box)
    }

    if (id === 'decor' || id === 'scene') {
      if (activeCharacterId === 'whale') {
        const src = id === 'decor' ? PROPS : SCENES
        const grid = $('div', 'dshp-grid')
        for (const [key, def] of Object.entries(src)) {
          if (!EXPR[def.expr]) continue
          const on = itemOn(key, def)
          const b = $('button', 'dshp-chip', def.label)
          if (on) b.classList.add('dshp-on')
          const lines = (SCENE_ACT[key] && SCENE_ACT[key].lines) || (PROP_ACT[key] && PROP_ACT[key].lines) || []
          const tip = on ? '再点一下收起来' : lines.length ? `点了她会说：${lines[0]}` : ''
          b.title = def.key ? `${tip}\n（原作者热键：${def.key}）` : tip
          b.addEventListener('click', () => {
            const nowOn = itemOn(key, def)
            setProp(key, !nowOn)
            if (!nowOn) playItem(id, key)
            renderPane(id)
          })
          grid.appendChild(b)
        }
        const row = $('div', 'dshp-row')
        const clear = $('button', 'dshp-btn', '全部摘掉')
        clear.addEventListener('click', () => {
          clearProps()
          act({ mood: 'neutral', props: IDLE_PROPS, line: pickFresh(SAY.tidy, 'tidy'), ms: 2000 })
          renderPane(id)
        })
        row.appendChild(clear)
        panes.append(
          grid,
          row,
          $(
            'div',
            'dshp-hint',
            id === 'decor'
              ? '装饰品戴上就一直留着，直到你再点一下摘掉（同类自动互斥：眼镜只戴一副、贴纸只贴一张）。'
              : '场景摆设也是「摆着不走」——桌布、鲸鱼、巴菲这些会一直留着，再点一下才收。',
          ),
        )
        return
      }

      // --- 非鲸鱼娘模型：动态捕捉自身装扮与随身道具资产 ---
      renderCustomCharacterPropsPane(id)
      return
    }

    if (id === 'action') {
      if (activeCharacterId === 'whale') {
        const grid = $('div', 'dshp-grid')
        for (const key of ACTION_KEYS) {
          const a = ACTIONS[key]
          if (a.expr && !EXPR[a.expr]) continue
          if (a.motion && !(manifest && manifest.motions && manifest.motions[a.motion])) continue
          const b = $('button', 'dshp-chip', a.label)
          b.title = `点了她会说：${a.lines[0]}` + (a.key ? `\n（原作者热键：${a.key}）` : '')
          b.addEventListener('click', () => {
            playAction(key)
            renderPane('action')
          })
          grid.appendChild(b)
        }
        panes.append(
          grid,
          $('div', 'dshp-hint', '动作是一次性的：演一遍就自己消失，不会一直挂着。\n（要一直留着的，去「装饰」和「场景」两页——蛋包饭也在这页，挤完酱就没了。）'),
        )
        return
      }

      // --- 非鲸鱼娘模型：动态捕捉自身动作与动画资产 ---
      renderCustomCharacterActionsPane()
      return
    }
    // setting
    const box = $('div')
    const label = $('label', 'dshp-label')
    label.append($('span', null, '大小'))
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '150'
    range.max = '720'
    range.value = String(clamp(Number(readLayout().height) || CFG.height, 150, 720))
    range.title = '也可以直接拖（点 − / + 更省事）'
    // 主人要求：大小主要用「加 / 减」点一下调，不要只能拖滑块
    const stepSize = (delta) => {
      const next = clamp(Number(range.value) + delta, 150, 720)
      range.value = String(next)
      sizeOut.textContent = next + 'px'
      fitModel(next)
      saveLayout({ height: next })
      clampPanels()
    }
    const mkStep = (txt, delta) => {
      const b = $('button', 'dshp-btn dshp-step', txt)
      b.title = (delta > 0 ? '放大' : '缩小') + '（每下 ' + Math.abs(delta) + 'px）'
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        stepSize(delta)
      })
      return b
    }
    const sizeOut = $('span', null, range.value + 'px')
    sizeOut.style.minWidth = '46px'
    sizeOut.style.fontVariantNumeric = 'tabular-nums'
    const stepRow = $('div', 'dshp-row')
    stepRow.append(mkStep('−', -20), sizeOut, mkStep('+', 20))
    // 拖的时候冻住 UI 缩放（见 sizingSize），松手再让面板跟上新尺寸——
    // 这样滑块轨道全程钉在原地，可以一路拖到底。
    const beginSize = () => {
      sizingSize = true
      ui.root.classList.add('dshp-sizing')
    }
    const endSize = () => {
      if (!sizingSize) return
      sizingSize = false
      ui.root.classList.remove('dshp-sizing')
      fitModel(Number(range.value))
      saveLayout({ height: Number(range.value) })
      clampPanels()
    }
    range.addEventListener('pointerdown', beginSize)
    range.addEventListener('pointerup', endSize)
    range.addEventListener('pointercancel', endSize)
    range.addEventListener('change', endSize)
    range.addEventListener('keydown', beginSize)
    range.addEventListener('keyup', endSize)
    range.addEventListener('input', () => {
      sizeOut.textContent = Number(range.value) + 'px'
      fitModel(Number(range.value))
      saveLayout({ height: Number(range.value) })
      if (!sizingSize) clampPanels()
    })
    label.appendChild(range)
    box.appendChild(label)
    box.appendChild(stepRow)

    // 视线灵敏度：实时生效，直接写进 CFG
    const g0 = gazeCfg()
    const mkGaze = (label, key, min, max, step, value, fmt) => {
      const l = $('label', 'dshp-label')
      l.append($('span', null, label))
      const r = document.createElement('input')
      r.type = 'range'
      r.min = String(min); r.max = String(max); r.step = String(step)
      r.value = String(value)
      const out = $('span', null, fmt(Number(r.value)))
      out.style.minWidth = '38px'
      out.style.textAlign = 'right'
      out.style.opacity = '.7'
      r.addEventListener('input', () => {
        CFG[key] = Number(r.value)
        persistCfg()
        out.textContent = fmt(Number(r.value))
      })
      l.append(r, out)
      return l
    }
    box.append(
      $('div', 'dshp-hint', '视线灵敏度'),
      mkGaze('跟随幅度', 'gazeGain', 0, 1, 0.02, g0.gain, (v) => v.toFixed(2)),
      mkGaze('跟随速度', 'gazeRate', 0.3, 4, 0.1, g0.rate, (v) => v.toFixed(1)),
      mkGaze('跟随范围', 'gazeRadius', 0, 2000, 50, g0.radius, (v) => (v <= 0 ? '整屏' : String(v))),
    )

    // 外观：跟随系统 / 浅色 / 深色 —— 手动档位覆盖系统设置，选择记在本地
    const themeRow = $('div', 'dshp-row')
    const themeBtns = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, label]) => {
      const btn = $('button', 'dshp-btn', label)
      btn.addEventListener('click', () => {
        for (const [val, b] of themeBtns) b.classList.toggle('dshp-primary', val === v)
        if (v === 'auto') {
          delete ui.root.dataset.dshpTheme
          saveLayout({ theme: null })
        } else {
          ui.root.dataset.dshpTheme = v
          saveLayout({ theme: v })
        }
        clampPanels()
      })
      return [v, btn]
    })
    const savedTheme = (() => {
      try {
        return readLayout().theme || 'auto'
      } catch (err) {
        return 'auto'
      }
    })()
    for (const [val, b] of themeBtns) b.classList.toggle('dshp-primary', val === savedTheme)
    themeRow.append(...themeBtns.map(([, b]) => b))

    const row1 = $('div', 'dshp-row')
    const eyeBtn = $('button', 'dshp-btn', CFG.lookAtCursor ? '视线跟随：开' : '视线跟随：关')
    eyeBtn.addEventListener('click', () => {
      CFG.lookAtCursor = !CFG.lookAtCursor
      persistCfg()
      eyeBtn.textContent = CFG.lookAtCursor ? '视线跟随：开' : '视线跟随：关'
    })
    const mouthBtn = $('button', 'dshp-btn', CFG.talkMouth ? '说话口型：开' : '说话口型：关')
    mouthBtn.addEventListener('click', () => {
      CFG.talkMouth = !CFG.talkMouth
      persistCfg()
      mouthBtn.textContent = CFG.talkMouth ? '说话口型：开' : '说话口型：关'
    })
    row1.append(eyeBtn, mouthBtn)

    const voiceQuickRow = $('div', 'dshp-row')
    voiceQuickRow.style.margin = '8px 0'
    const testVoiceQuickBtn = $('button', 'dshp-btn dshp-primary', '▶ 测试伴侣发声 (9880)')
    testVoiceQuickBtn.addEventListener('click', async () => {
      try {
        const data = await apiFetch(BASE + '/test-speech', {
          method: 'POST',
          body: JSON.stringify({ characterId: activeCharacterId }),
        })
        if (data.ok) {
          if (data.text) ui.bubble.show(data.text, { name: activeCharInfo().name, sticky: false, duration: 5000 })
          // 服务端 /test-speech 会广播 voice-speech 事件驱动播放，若未建立长连接则由此处兜底播放
          if ((!es || es.readyState !== EventSource.OPEN) && data.audioUrl) {
            await playAudioWithLipSync(data.audioUrl)
          }
        }
      } catch (e) {}
    })
    voiceQuickRow.appendChild(testVoiceQuickBtn)
    box.appendChild(voiceQuickRow)


    // 连接哪一个 DSH：自动 / 桌面版 / 网页版
    // （主人反馈：她有时连网页版、有时连桌面版，会「串对话」，所以要一个手动选择键并记住）
    const hostRow = $('div', 'dshp-row')
    const hostNow = (() => {
      try {
        const b = window.__DSH_PET_BOOT__ || {}
        const kind = b.desktop ? '桌面版' : b.port ? '网页版' : '未知'
        return kind + (b.port ? ' · ' + b.port : '')
      } catch (err) {
        return '未知'
      }
    })()
    const hostBtns = [['auto', '自动'], ['desktop', '桌面版'], ['web', '网页版']].map(([v, label]) => {
      const b = $('button', 'dshp-btn', label)
      b.addEventListener('click', () => {
        for (const [, x] of hostBtns) x.classList.remove('dshp-primary')
        b.classList.add('dshp-primary')
        try {
          if (shell.on) shell.post('host:' + v)
          ui.bubble.show('好，下次连' + (v === 'auto' ? '自动挑' : v === 'desktop' ? '桌面版' : '网页版'), {
            name: activeCharInfo().name,
            ttl: 2200,
          })
        } catch (err) {}
      })
      return [v, b]
    })
    // 🖥️ 独立桌面常驻按键（网页版后面位置）
    const detachBtn = $('button', 'dshp-btn', '🖥️ 脱离客户端 · 独立桌面常驻')

    function updateDetachBtnUI(running) {
      if (isStandalone) {
        detachBtn.textContent = '📥 收回至客户端渲染'
        detachBtn.classList.add('dshp-primary')
        detachBtn.title = '当前窗口正在桌面独立常驻运行（客户端最小化仍可互动），点击可收回至客户端'
        return
      }
      if (running) {
        detachBtn.textContent = '📥 收回至客户端渲染'
        detachBtn.classList.add('dshp-primary')
        detachBtn.title = '点击关闭桌面独立常驻窗口，恢复在客户端内渲染'
      } else {
        detachBtn.textContent = '🖥️ 脱离客户端 · 独立桌面常驻'
        detachBtn.classList.remove('dshp-primary')
        detachBtn.title = '脱离客户端，在桌面透明独立常驻渲染（即使客户端最小化依然保留在桌面）'
      }
    }

    window.__dshpUpdateDetachBtn = (running) => {
      updateDetachBtnUI(running)
    }

    detachBtn.addEventListener('click', async () => {
      if (isStandalone) {
        detachBtn.disabled = true
        detachBtn.textContent = '⏳ 正在收回...'
        await requestDesktopCloseGlobal()
        try { window.close() } catch (e) {}
        return
      }
      detachBtn.disabled = true
      try {
        if (isClientDetached) {
          detachBtn.textContent = '⏳ 正在收回...'
          const r = await requestDesktopCloseGlobal()
          if (r && r.ok) {
            setClientDetached(false)
            updateDetachBtnUI(false)
            ui.bubble.show('已收回至客户端内渲染啦～', { name: activeCharInfo().name, ttl: 2500 })
          } else {
            updateDetachBtnUI(true)
          }
        } else {
          detachBtn.textContent = '⏳ 正在脱离...'
          const r = await requestDesktopLaunchGlobal()
          if (r && r.ok) {
            closePanels()
            setClientDetached(true)
            updateDetachBtnUI(true)
          } else {
            updateDetachBtnUI(false)
            ui.bubble.show('启动独立桌面常驻失败：' + ((r && r.error) || '未知错误'), {
              name: activeCharInfo().name,
              ttl: 3000,
            })
          }
        }
      } catch (err) {
        updateDetachBtnUI(isClientDetached)
        ui.bubble.show('脱离请求失败：' + (err && err.message ? err.message : String(err)), {
          name: activeCharInfo().name,
          ttl: 3000,
        })
      } finally {
        detachBtn.disabled = false
      }
    })

    hostRow.append(...hostBtns.map(([, b]) => b), detachBtn)

    // 初始化按钮显示
    if (isStandalone) {
      updateDetachBtnUI(true)
    } else {
      updateDetachBtnUI(isClientDetached)
      requestDesktopStatusGlobal()
        .then((st) => {
          if (st && st.ok) {
            setClientDetached(!!st.running)
            updateDetachBtnUI(!!st.running)
          }
        })
        .catch(() => {})
    }
    const hostHint = $('div', 'dshp-hint', '当前：' + hostNow + (shell.on ? '' : '（网页版里改不了，去桌面客户端改）'))
    // 壳子加载后会调 DSHPet.setHostPref() 告诉我们它记着的是哪一档
    window.__dshpSetHostPref = (v) => {
      for (const [val, b] of hostBtns) b.classList.toggle('dshp-primary', val === v)
    }

    const row0 = $('div', 'dshp-row')
    const resetAll = $('button', 'dshp-btn dshp-primary', '一键重置所有状态')
    resetAll.addEventListener('click', () => {
      resetEverything()
      renderPane('setting')
      ui.bubble.show('回到平常状态啦', { name: activeCharInfo().name, ttl: 2200 })
    })
    row0.appendChild(resetAll)
    box.append(hostRow, hostHint, themeRow, row0)

    // 🐾 桌面自由漫步与一键召回
    const roamRow = $('div', 'dshp-row')
    const roamBtn = $('button', 'dshp-btn', CFG.roamEnabled !== false ? '🐾 桌面漫步：开' : '🐾 桌面漫步：关')
    roamBtn.title = '开启后桌宠将在空闲时在屏幕桌面间自由漫步'
    roamBtn.addEventListener('click', () => {
      CFG.roamEnabled = CFG.roamEnabled === false ? true : false
      persistCfg()
      if (desktopRoamEngine && typeof desktopRoamEngine.setRoaming === 'function') {
        desktopRoamEngine.setRoaming(CFG.roamEnabled)
      }
      roamBtn.textContent = CFG.roamEnabled ? '🐾 桌面漫步：开' : '🐾 桌面漫步：关'
      ui.bubble.show(CFG.roamEnabled ? '我可以自由溜达啦～' : '好，我乖乖待在原地～', { name: activeCharInfo().name, ttl: 2000 })
    })

    const recallBtn = $('button', 'dshp-btn', '📍 一键召回')
    recallBtn.title = '让桌宠立刻走回主人放置的锚点位置'
    recallBtn.addEventListener('click', () => {
      if (desktopRoamEngine && typeof desktopRoamEngine.returnToAnchor === 'function') {
        desktopRoamEngine.returnToAnchor()
        ui.bubble.show('我回来啦～', { name: activeCharInfo().name, ttl: 2000 })
      }
    })
    roamRow.append(roamBtn, recallBtn)
    box.append(roamRow)

    const row2 = $('div', 'dshp-row')
    const reset = $('button', 'dshp-btn', '回到角落')
    reset.addEventListener('click', () => {
      for (const k of ['left', 'top', 'right', 'bottom']) ui.root.style[k] = ''
      saveLayout({ x: null, y: null })
      applyPosition(readLayout())
    })
    const hide = $('button', 'dshp-btn', shell.on ? '隐藏桌宠（缩成贴边小球）' : '隐藏桌宠（右下角把手叫回来）')
    hide.addEventListener('click', () => {
      closePanels()
      setHidden(true)
    })
    row2.append(reset, hide)
    if (shell.on) {
      const row3 = $('div', 'dshp-row')
      const toBall = $('button', 'dshp-btn', '收起成悬浮小球')
      toBall.addEventListener('click', () => {
        closePanels()
        setHidden(true)
      })
      const quitApp = $('button', 'dshp-btn', '彻底关闭桌宠应用')
      quitApp.addEventListener('click', () => {
        ui.bubble.show('人家先退下了，想叫我就去「应用程序」里双击我～', { name: activeCharInfo().name, ttl: 2000 })
        setTimeout(() => shell.post('quit'), 220)
      })
      row3.append(toBall, quitApp)
      box.append(row3)
    }
    box.append(
      row1,
      row2,
      $(
        'div',
        'dshp-hint',
        '拖动可以换位置；右键或 ⋯ 叫出菜单；双击直接开输入框。\n表情平时由她自己挑——你在这里选只是 30 秒的临时心情，她遇到正事会自己换回来。',
      ),
    )
    panes.appendChild(box)
    // 换页后面板高度会变，可能顶到屏幕外面去（立刻夹一次 + 下一帧兜底）
    clampPanels()
    requestAnimationFrame(() => clampPanels())
  }

  // ——————————————————————————————————————————————————————————————
  // 十、agent 事件 → 表演
  // ——————————————————————————————————————————————————————————————

  const agent = {
    status: 'idle',
    turn: 0,
    step: 0,
    toolProp: null,
    lastActivity: Date.now(),
    sleeping: false,
    hasStream: false,
    lastText: '',
    tokens: 0,
  }

  function connectSSE() {
    let es = null
    let retry = 0
    const open = () => {
      es = new EventSource(BASE + '/events')
      es.onopen = () => {
        retry = 0
        log('事件流已连接')
      }
      es.onmessage = (ev) => {
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch (e) {
          return
        }
        try {
          handleEvent(msg)
        } catch (err) {
          console.warn('[鲸鱼娘] 事件处理出错', msg && msg.t, err)
        }
      }
      es.onerror = () => {
        try {
          es.close()
        } catch (e) {}
        retry++
        setTimeout(open, Math.min(10000, 800 * retry))
      }
    }
    open()
  }

  function setStatus(next) {
    if (agent.status === next) return
    agent.status = next
    agent.lastActivity = Date.now()
    agent.sleeping = false
  }

  function handleEvent(m) {
    if (m && m.sessionId) {
      currentSessionId = m.sessionId
    }
    switch (m.t) {
      case 'desktop_state':
        if (typeof m.running === 'boolean' && !isStandalone) {
          setClientDetached(m.running)
        }
        break

      case 'character-changed':
        if (m.characterId && m.characterId !== activeCharacterId && m.characterId !== switchingCharId && CHARACTERS[m.characterId]) {
          switchCharacter(m.characterId)
        }
        break

      case 'character-deleted':
        if (m.characterId) {
          delete CHARACTERS[m.characterId]
          if (activeCharacterId === m.characterId) {
            switchCharacter(m.fallbackCharacterId || 'tutu')
          }
          if (ui && ui.menu && ui.menu.focused === 'character') {
            renderPane('character')
          }
        }
        break

      case 'hello':
        agent.status = m.status || 'idle'
        break

      case 'user':
        setStatus('listening')
        rig.talking = false
        wakeUp()
        stopActing()
        setBase('listening', IDLE_PROPS)
        clearToolProp()
        ui.bubble.show(String(m.text || '').slice(0, 300), { name: '你', ttl: 3500 })
        break

      case 'turn-start':
        agent.turn = m.turn
        agent.hasStream = false
        agent.lastText = ''
        agent.tokens = 0
        setStatus('thinking')
        rig.talking = false
        startWork()
        stopActing()
        setBase('thinking', WORK_PROPS)
        const startProfile = TapProfileRegistry.get(activeCharacterId)
        const startLine = startProfile.pickThinkingLine()
        const parsedStart = ActionCueParser.parse(startLine)
        ui.bubble.show(parsedStart.bubbleText, { name: activeCharInfo().name, busy: true, sticky: true })
        ui.bubble.note('思考中')
        if (CFG.sound !== false && parsedStart.speechText && !isSpeakingAudio) {
          speakCharacterText(parsedStart.speechText, activeCharacterId)
        }
        break

      case 'step-start':
        agent.step = m.step
        setStatus('thinking')
        rig.talking = false
        const stepProfile = TapProfileRegistry.get(activeCharacterId)
        const stepThinkLine = stepProfile.pickThinkingLine()
        const parsedStep = ActionCueParser.parse(stepThinkLine)
        ui.bubble.show(parsedStep.bubbleText, { name: activeCharInfo().name, busy: true, sticky: true })
        ui.bubble.note('正在思考 · 第 ' + m.step + ' 步')
        if (CFG.sound !== false && parsedStep.speechText && !isSpeakingAudio) {
          speakCharacterText(parsedStep.speechText, activeCharacterId)
        }
        break

      case 'delta':
        if (m.kind === 'reasoning') return
        agent.lastActivity = Date.now()
        if (!agent.hasStream) {
          agent.hasStream = true
          setStatus('speaking')
          rig.talking = true
          setBase('happy', WORK_PROPS)
          ui.bubble.show('', { name: activeCharInfo().name, stream: true, sticky: true })
        }
        ui.bubble.show(m.text || '', { stream: true, sticky: true })
        break

      case 'voice-config-updated':
        if (m.characterId && m.voice && CHARACTERS[m.characterId]) {
          CHARACTERS[m.characterId].voice = Object.assign(CHARACTERS[m.characterId].voice || {}, m.voice)
        }
        break

      case 'tts-state':
        if (typeof m.enabled === 'boolean') {
          CFG.sound = m.enabled
          persistCfg()
        }
        break

      case 'voice-speech':
        if (CFG.sound !== false && (m.url || m.audioUrl)) {
          const audioUrl = m.audioUrl || m.url
          if (m.text) {
            ui.bubble.show(m.text, { name: activeCharInfo().name, sticky: false, duration: 4500 })
          }
          if (m.actionCue) {
            triggerActionByCue(m.actionCue)
          }
          playAudioWithLipSync(audioUrl)
        }
        break

      case 'perception-inquiry':
        if (m.text) {
          ui.bubble.show(m.text, { name: activeCharInfo().name, sticky: false, duration: 6500 })
        }
        break

      case 'voice-speech-stop':
        if (activeTtsAudio) {
          try {
            activeTtsAudio.pause()
            activeTtsAudio = null
          } catch (e) {}
          isSpeakingAudio = false
          rig.talking = false
        }
        break

      case 'assistant':
        agent.hasStream = false
        rig.talking = false
        if (m.interrupted) break
        if (m.text) {
          const cleanAssistantText = stripThinking(m.text)
          if (cleanAssistantText) {
            setStatus('speaking')
            agent.lastText = cleanAssistantText.slice(0, 4000)
            ui.bubble.show(agent.lastText, { name: activeCharInfo().name, sticky: true })
            if (agent.lastText && agent.lastText.length > 40) pushReport('任务简报', agent.lastText)
          } else {
            setStatus('idle')
            ui.bubble.hide()
          }
          // 伴侣口播语音统一由服务端智能摘要后广播 voice-speech 事件驱动播放，避免前端重复触发合成导致重音回声
        }
        if (m.usage) {
          const t = (m.usage.input || 0) + (m.usage.cache || 0) + (m.usage.output || 0)
          agent.tokens = (agent.tokens || 0) + t
          ui.bubble.note('本轮 ' + t.toLocaleString() + ' tokens')
        }
        break

      case 'tool-call': {
        setStatus('working')
        rig.talking = false
        const react = TOOL_REACT[m.name] || { mood: 'reading', prop: 'glassesRound' }
        stopActing() // 切模式前先把一次性表演收掉
        // 阅读类才低头看本子
        gaze.biasTarget = react.mood === 'reading' ? -0.32 : 0
        const isDevice = DEVICE_TOOLS.has(m.name)
        // 常态：本子 + 笔。查资料时**笔换成手机**（把手里的笔放下，掏出小设备），
        // 看完自动关掉、把笔换回来。用的都是模型自带素材，不自己编。
        const propKey = react.prop === 'auto' ? randomGlasses() : react.prop
        setBase(
          react.mood,
          isDevice ? ['menuBoard'] : WORK_PROPS.concat(propKey ? [propKey] : []),
        )
        if (isDevice) {
          if (!device.out) {
            device.out = true
            playMotion('openLid')
          }
        } else if (device.out) {
          putDeviceAway()
        }
        gazeDetach(1400)
        // 台词按工具轮换（同一个工具连着用也不会重复），第二行是**具体在干什么**，
        // 脚注标出工具名——这样 Agent 里在跑什么，桌宠这边能同步看出来。
        const pool = TOOL_LINE[m.name] || (react.lean ? SAY.reading : SAY.working)
        const line = pickFresh(pool, 'tool-' + m.name)
        const hint = toolHint(m.args)
        const parsedTool = ActionCueParser.parse(line)
        ui.bubble.show(parsedTool.bubbleText + (hint ? '\n' + hint : ''), {
          name: activeCharInfo().name,
          busy: true,
          sticky: true,
        })
        ui.bubble.note(m.label || m.name || (react.mood === 'reading' ? '看资料' : '工作中'))
        if (CFG.sound !== false && parsedTool.speechText && !isSpeakingAudio) {
          speakCharacterText(parsedTool.speechText, activeCharacterId)
        }
        break
      }

      case 'tool-result':
        clearToolProp()
        if (m.error) {
          // 出错才有「黑脸」——而且很快就结束，不会一直挂着
          // 出错只是黑一下脸，很短——主人说「大锤砸头」那个不要了
          // 工具报错只是「黑一下脸」，很短，而且不叠任何别的东西
          act({
            mood: 'gloomy',
            props: [],
            exclusive: true,
            line: '（脸黑了）这个工具报错了：' + (m.error.name || m.error.code || '未知'),
            ms: 1600,
          })
        } else {
          setStatus('thinking')
          stopActing()
          putDeviceAway()
          setBase('thinking', WORK_PROPS)
        }
        break

      case 'hud-turn': {
        // 宿主已经把这一轮的账算好了，直接弹（比再去拉一次接口更快也更准）
        if (m.turn) {
          hud.turn = Object.assign({ ok: true }, m.turn)
          hud.seq = m.turn.seq || hud.seq
          if (!hud.data) hudFetch(false)
          else hudRender()
          // 同上：不自动弹余额，改为在头顶挂一个「信封」（点开是大号工作简报）
          if (m.turn) {
            const amt = m.turn.amount != null ? '¥' + Number(m.turn.amount).toFixed(4) : ''
            const tk = m.turn.tokens ? ' · ' + m.turn.tokens + ' tokens' : ''
            pushReport('本轮完成', amt || tk ? '花费 ' + amt + tk : '这一轮跑完了')
          }
        }
        break
      }

      case 'turn-end': {
        const kind = (m.reason && m.reason.kind) || m.reason || 'completed'
        rig.talking = false
        agent.hasStream = false
        clearToolProp()
        setStatus('idle')
        endWork()
        // ★ 关键：一轮结束必须把**底层状态**也复位成「平常」。
        // 之前只做了 setStatus('idle')，底层还停在最后那个工具的脸
        // （比如「调皮」会闭一只眼），于是看起来就像「平常动作被挤眼睛占住了」。
        setBase('neutral', IDLE_PROPS)

        // 主人要的：每轮结束都把「本轮消耗」弹出来（独立面板，9 秒后自己收）。
        // 宿主通常已经推了 hud-turn（那条会立刻弹）；这里只是兜底，晚一点再拉一次余额。
        hudPopTurnEnd()

        const secs = m.ms ? (m.ms / 1000).toFixed(1) + 's' : ''
        const stat = []
        if (secs) stat.push(secs)
        if (m.tokens) stat.push(m.tokens.toLocaleString() + ' tokens')

        if (kind === 'completed') {
          // 庆祝：开心脸 + 伸个懒腰 + 一个装饰（猫耳/兔耳/花花随机一个）+ 一句台词。
          // 刻意只叠「一个动作 + 一个装饰」，而且几秒后自己连开关一起收掉。
          // 庆祝只做三件事：开心脸 + 一个装饰 + 一句台词，再加一个纯 CSS 的「蹦一下」。
          // 刻意**不播 aidale**：那个「伸展」动作内部驱动 15 个表情参数
          // （呆呆眼/哭/开心/晕晕/感叹号），一播就会同时点亮好几个表情，
          // 看起来就是「砸完头之后表情全乱了」。qBounce 不碰任何模型参数。
          qBounce(1.2)
          // 主人要求：刚输出的文字要**停留一下**，别被结算立刻顶掉。
          // 所以先只做表情+装饰的庆祝，文字留在气泡里；过两秒多再把结束台词接上。
          const keepText = ui.bubble.visible && !!agent.lastText
          act({
            mood: 'happy',
            props: [pickFresh(['stickerCat', 'stickerRabbit', 'flower', 'heartbeat'], 'celebrate')],
            line: keepText ? null : pickFresh(SAY.done, 'done') + (stat.length ? '\n' + stat.join(' · ') : ''),
            ms: 3000,
          })
          if (keepText) {
            if (stat.length) ui.bubble.note(stat.join(' · '))
            setTimeout(() => {
              if (agent.status !== 'idle') return
              ui.bubble.show(pickFresh(SAY.done, 'done'), { name: activeCharInfo().name, ttl: 4200 })
            }, 2800)
          }
        } else if (kind === 'aborted') {
          act({ mood: 'sad', line: pickFresh(['诶…人家还没做完呢', '被打断了…'], 'abort'), ms: 2800 })
        } else if (kind === 'error') {
          const em = (m.reason && m.reason.error && m.reason.error.message) || '出错了'
          act({
            mood: pick(['sweat', 'sad']),
            line: pickFresh(SAY.fail, 'fail') + '\n' + String(em).slice(0, 160),
            ms: 3200,
          })
        } else {
          act({ mood: 'pout', ms: 2600 })
        }
        break
      }

      case 'subagent':
        if (m.active && ui.bubble.visible) ui.bubble.note('分身也在干活…')
        break

      case 'approval':
        if (m.state === 'asked') {
          act({ mood: 'confused', line: '需要你点一下确认', props: WORK_PROPS, ms: 8000 })
        } else {
          act({ mood: 'happy', ms: 2600 })
        }
        break

      case 'control':
        handleControl(m)
        break
    }
  }


  /** 干活时顺手戴的道具，一轮结束就摘掉；用户自己戴的不动。 */
  /**
   * 上一版「手动戴/摘工具道具」的遗留。现在道具由 base/override/user 三层解析，
   * 一次性道具随 override 一起过期，不存在「忘了摘」的情况；保留成空操作只是
   * 为了少改调用点。
   */
  function clearToolProp() {}

  /** 外部（用户菜单，或 agent 自己调 /dsh-pet/control）驱动的表演。 */
  function handleControl(m) {
    if (m.clearProps) clearProps()
    if (m.props && typeof m.props === 'object') {
      for (const [k, v] of Object.entries(m.props)) setProp(k, !!v)
    }
    if (m.expression !== undefined) {
      rig.face = m.expression === null || !EXPR[m.expression] ? null : m.expression
      mood = 'custom'
      rig.dirty = true
    }
    if (m.mood != null || m.expression) {
      act({ mood: m.mood, face: m.expression, ms: m.bubbleMs || 5000 })
    }
    if (m.motion) playMotion(m.motion)
    const text = m.say || m.bubble
    if (text) ui.bubble.show(String(text), { name: activeCharInfo().name, ttl: m.bubbleMs || 5000 })
    // 工作简报（/dsh-pet/control 的 report 字段）：头顶挂信封，点开是大号面板
    if (m.report) {
      try {
        const r = m.report
        if (Array.isArray(r)) pushReport(String(r[0] || '工作简报'), String(r[1] || ''))
        else if (typeof r === 'string') pushReport('工作简报', r)
        else pushReport(String(r.title || '工作简报'), String(r.body || r.text || ''))
      } catch (err) {}
    }
    if (m.attention) {
      ui.root.classList.add('dshp-open')
      setTimeout(() => closePanels(), 3000)
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 十一、待机小动作
  // ——————————————————————————————————————————————————————————————

  /**
   * 待机大脑。
   *
   * 这是「她自己会动」的来源——用户明确说过不想自己一个个去点表情，
   * 要她闲着自己动一动。所以按权重随机挑事情做：
   *
   *   · 大部分时间只是看看别处、换个姿势、偶尔换个表情（很快收回）
   *   · 吹泡泡糖是稀有事件（权重 2/100），不再是主旋律
   *   · 长时间没人理 → 打哈欠 → 打瞌睡（渐进式，鼠标一动就醒）
   *
   * 权重表就是性格；想让她更活泼就调大 motion 类，想更安静就调大 glance。
   */
  /**
   * 待机行为权重表。
   *
   * 主人明确要求：**待机不放任何「动作」**（不吹泡泡糖、不伸懒腰、不自拍），
   * 待机就是「拿着板夹、平常脸、等命令」——动效只可能在「点击」或「工作事件」
   * 里出现，每个动作配它自己那套台词，且不会乱冒。
   *
   * 所以这里只剩三类：看别处、自己换个表情（几秒收回）、说句话。
   */
  const IDLE_TABLE = [
    ['glance', 46], // 看别处 / 发呆
    ['express', 28], // 自己换个表情，几秒后收回
    ['mutter', 22], // 自言自语（人设台词）
    ['hungry', 4], // 喊饿
    ['nopang', 2], // 强调自己不胖（主人说「别老生气」，权重砍半）
  ]
  const IDLE_TOTAL = IDLE_TABLE.reduce((a, b) => a + b[1], 0)

  const idle = { sleep: 0, nextAt: 0, expressTimer: null, propTimer: null }

  function wakeUp() {
    if (idle.sleep === 0) return
    idle.sleep = 0
    act({ mood: 'alert', line: pick(SAY.wake), ms: 1800 })
  }

  function pickIdleBehavior() {
    let r = Math.random() * IDLE_TOTAL
    for (const [name, w] of IDLE_TABLE) {
      r -= w
      if (r <= 0) return name
    }
    return 'glance'
  }

  /** 待机时自己换个表情，过几秒悄悄收回（除非有真实事件插进来）。 */
  function idleExpress() {
    // 注意：'dizzy'（圈圈眼）主人说老出不好看，已从所有自动行为里移除
    // 待机时换的表情，**必须是不会改变眼睛大小的**——
    // 主人要的「平常动作」就是「正常眼型 + 正常表情」，所以像
    // 开心兴奋（闭眼）、调皮（闭一只眼，就是那个"挤眼睛"）这类
    // 一律不进待机池，只留给点击互动那种明确的场合。
    // 'grumpy'（生气）也踢掉了：主人抱怨「别老生气」，待机时无缘无故
    // 摆一张生气的脸很莫名，换成「流汗」。
    const pool = ['shy', 'confused', 'excited', 'alert', 'tongue', 'sweat', 'love']
    const m = pick(pool)
    const ms = 2200 + Math.random() * 2600
    act({ mood: m, props: IDLE_PROPS, ms })
    idle.expressUntil = performance.now() + ms
  }

  /** 待机时拨弄一个道具：临时戴上，随 override 一起过期，不用手动摘。 */
  function idleFiddle() {
    const keys = Object.keys(PROPS).filter((k) => EXPR[PROPS[k].expr])
    const key = pickFresh(keys, 'fiddle')
    act({ props: [key], ms: 5000 + Math.random() * 4000 })
  }

  function runIdleBehavior() {
    // 正有一个一次性反应在放，就别插新的——否则会叠在一起，
    // 而且旧反应会被顶掉、看起来像「卡住」
    if (rig.override) return

    const b = pickIdleBehavior()
    switch (b) {
      case 'glance':
        gaze.nextDrift = 0 // 立刻换一个新的视线落点
        break
      case 'express':
        idleExpress()
        break
      case 'mutter':
        act({ props: IDLE_PROPS, line: pickFresh(SAY.idle, 'idle'), ms: 4200 })
        break
      case 'fiddle':
        idleFiddle()
        break
      case 'hungry':
        act({ mood: 'pout', props: IDLE_PROPS, line: pickFresh(SAY.hungry, 'hungry'), ms: 4600 })
        break
      case 'nopang':
        act({ mood: 'grumpy', props: IDLE_PROPS, line: pickFresh(SAY.fat, 'fat'), ms: 4200 })
        break
    }
  }

  function startLoops() {
    // 定期向桌面壳同步包围盒用于高效零开销排除
    setInterval(reportBoundsToShell, 1000)

    // 视线/自主动作：40ms 一跳（对应 clawd-on-desk 的 50ms 轮询）
    setInterval(gazeTick, 40)

    // 干活时的轮播（认真/摸鱼/思考），和下面的待机大脑互斥
    setInterval(() => {
      if (agent.status === 'idle') return
      workTick()
    }, 1500)

    // 兜底复位：只要空闲、又没有一次性表演在放，底层状态就必须是「平常」。
    // 有了它，就算哪条事件路径漏了复位，也不会出现「一直挂着某张脸」。
    setInterval(() => {
      if (agent.status !== 'idle') return
      if (rig.override) return
      if (rig.base.mood !== 'neutral') setBase('neutral', IDLE_PROPS)
      if (gaze.biasTarget !== 0) gaze.biasTarget = 0
    }, 2000)

    // 待机大脑：3.5–7.5 秒挑一件事
    setInterval(() => {
      if (agent.status !== 'idle') return
      if (PERF.low) return                      // 低性能档：不自言自语、不自己找戏
      if (ui.root.classList.contains('dshp-hidden')) return
      if (document.hidden) return
      const now = performance.now()
      if (now < idle.nextAt) return
      idle.nextAt = now + 3500 + Math.random() * 4000
      runIdleBehavior()
    }, 1200)

    // 睡眠序列：先打哈欠，再睡着；鼠标一动就醒
    setInterval(() => {
      if (!CFG.sleepAfterMs || agent.status !== 'idle') return
      if (PERF.low) return                      // 低性能档：连打哈欠/睡觉都省掉
      const quiet = Date.now() - agent.lastActivity
      if (idle.sleep === 0 && quiet > CFG.sleepAfterMs) {
        idle.sleep = 2
        setBase('sleepy', IDLE_PROPS)
        ui.bubble.show(pick(['Zzz…', '（打瞌睡）', '（趴桌上睡着了）']), { name: activeCharInfo().name, ttl: 9000 })
      } else if (idle.sleep === 0 && quiet > CFG.sleepAfterMs * 0.55 && Math.random() < 0.4) {
        // 打哈欠
        act({ mood: 'sleepy', props: IDLE_PROPS, line: '（打了个哈欠）', ms: 2600 })
      }
    }, 15000)

    // 屏幕视觉与场景感知监测轮询：基于统一前台场景神经与桌面灵机制接收关怀事件
    let lastHandledVisionId = null
    let currentCareCardEl = null
    let careCountdownTimer = null

    function dismissCareCard() {
      if (careCountdownTimer) {
        clearInterval(careCountdownTimer)
        careCountdownTimer = null
      }
      if (currentCareCardEl) {
        const el = currentCareCardEl
        currentCareCardEl = null
        el.classList.add('dshp-hidden')
        reportBoundsToShell()
        setTimeout(() => {
          if (el.parentNode) el.parentNode.removeChild(el)
          reportBoundsToShell()
        }, 220)
      }
    }

    async function handleCareUserReply(ev, replyText) {
      dismissCareCard()
      const cleanReply = String(replyText || '').trim()
      if (!cleanReply) return

      // 用户回复时的专属情境台词 (遵循主人硬约束：不再使用机械语句，改为“我看到了哦，让我想一想~”)
      ui.bubble.show('我看到了哦，让我想一想~', { name: activeCharInfo().name, ttl: 4000 })
      act({ mood: 'listening', props: IDLE_PROPS, line: '我看到了哦，让我想一想~', ms: 3200 })

      try {
        // 1. 每接到用户的一份回复，立即截图一次 (防自截)
        let capShot = null
        try {
          const capRes = await perceptionFetch('/perception/capture', { method: 'POST', body: '{}' })
          if (capRes && capRes.shot && capRes.shot.base64) {
            capShot = capRes.shot
          }
        } catch (ce) {
          console.warn('[CareReply] 截图捕获降级:', ce)
        }

        // 2. 对比主人话语与画面，组装去技术化、严格角色 Guardrail 的自然闲聊 Prompt
        const activeName = (activeCharInfo() && activeCharInfo().name) || '桌宠伴侣'
        const prompt = `【桌宠日常闲聊】你现在是陪伴在主人身边的桌面伴侣【${activeName}】。
刚才你在桌面上看到主人在忙，主动问候了一声：“${ev.text || '主人在忙什么呀？'}”，主人回复你说：“${cleanReply}”。

【硬性要求】
1. 严禁进行任何技术分析、代码审计或工具调用，严禁长篇大论；
2. 请直接以【${activeName}】亲切、自然、贴心的口吻，像身旁的小伙伴一样回复主人 1~2 句话（40字以内）；
3. （附带的截屏仅作为主人的生活背景参考，请不要对着截屏里的代码长篇说教）。`

        const payload = {
          text: prompt,
          userText: cleanReply,
          sessionId: currentSessionId || undefined,
        }
        if (capShot && capShot.base64) {
          payload.image = capShot.base64
          payload.imageMime = capShot.mime || 'image/jpeg'
        }

        const sayRes = await apiFetch(BASE + '/say', {
          method: 'POST',
          body: JSON.stringify(payload)
        })
        if (!sayRes || !sayRes.ok) {
          console.warn('[CareReply] /say 处理返回异常:', sayRes)
          ui.bubble.show('发送异常：' + ((sayRes && sayRes.error) || '请求未完成'), { name: activeCharInfo().name, ttl: 3500 })
        }
      } catch (err) {
        console.warn('[CareReply] 递送至 DSH 异常:', err)
        ui.bubble.show('抱歉主人，发送异常：' + err.message, { name: activeCharInfo().name, ttl: 3500 })
      }
    }

    function showProactiveCareCard(ev) {
      dismissCareCard()

      const card = $('div', 'dshp-panel dshp-care-card dshp-on')
      currentCareCardEl = card

      // 阻断拖拽与点击穿透
      const stopEv = (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
      }
      card.addEventListener('pointerdown', stopEv)
      card.addEventListener('mousedown', stopEv)
      card.addEventListener('click', stopEv)

      // 顶部标题与图标
      const iconMap = {
        travel: '✈️ 出行行程关怀',
        rental: '🏠 租房房源助手',
        shopping: '🛍️ 好物随行伴聊',
        steam: '🎮 Steam 游戏时光',
        game: '🎯 游戏伴聊关怀',
      }
      const titleTxt = iconMap[ev.category] || '💡 伴侣温馨提示'
      const titleRow = $('div', 'dshp-care-title', titleTxt)
      titleRow.style.fontWeight = 'bold'
      titleRow.style.fontSize = '12.5px'
      titleRow.style.marginBottom = '6px'
      titleRow.style.color = 'var(--dshp-accent)'

      const qRow = $('div', 'dshp-care-question', ev.text || '')
      qRow.style.lineHeight = '1.45'
      qRow.style.marginBottom = '8px'
      qRow.style.fontSize = '12px'

      // 快捷互动选项
      const chipRow = $('div', 'dshp-row dshp-care-chips')
      chipRow.style.display = 'flex'
      chipRow.style.gap = '6px'
      chipRow.style.flexWrap = 'wrap'
      chipRow.style.marginBottom = '8px'

      const quickOptions = []
      if (ev.category === 'travel') {
        quickOptions.push('✈️ 去旅行度假', '💼 出差订票', '帮我挑挑选选')
      } else if (ev.category === 'steam' || ev.category === 'game') {
        quickOptions.push('🎮 痛快玩一把', '逛逛特惠', '今天先休息')
      } else if (ev.category === 'rental') {
        quickOptions.push('看新房源', '查看周边配套', '随便瞧瞧')
      } else if (ev.category === 'shopping') {
        quickOptions.push('挑个好物', '先加购物车', '看看比价')
      } else {
        quickOptions.push('好呀', '一起看看', '稍后聊')
      }

      quickOptions.forEach((optText) => {
        const chip = $('button', 'dshp-btn dshp-chip', optText)
        chip.style.fontSize = '11px'
        chip.style.padding = '3px 8px'
        chip.style.border = '1px solid var(--dshp-line)'
        chip.style.borderRadius = '6px'
        chip.style.background = 'rgba(255,255,255,0.06)'
        chip.style.cursor = 'pointer'
        chip.addEventListener('pointerdown', stopEv)
        chip.addEventListener('mousedown', stopEv)
        chip.addEventListener('click', (e) => {
          stopEv(e)
          handleCareUserReply(ev, optText)
        })
        chipRow.appendChild(chip)
      })

      // 输入行
      const inputRow = $('div', 'dshp-row dshp-care-input-row')
      inputRow.style.display = 'flex'
      inputRow.style.gap = '6px'

      const inp = document.createElement('input')
      inp.className = 'dshp-input'
      inp.type = 'text'
      inp.placeholder = '输入你的回复…'
      inp.style.flex = '1'
      inp.style.fontSize = '11px'
      inp.style.padding = '4px 8px'
      inp.style.borderRadius = '6px'
      inp.style.border = '1px solid var(--dshp-line)'
      inp.style.background = 'transparent'
      inp.style.color = 'inherit'
      inp.style.outline = 'none'

      inp.addEventListener('pointerdown', (e) => { stopEv(e); inp.focus() })
      inp.addEventListener('mousedown', (e) => { stopEv(e); inp.focus() })
      inp.addEventListener('click', (e) => { stopEv(e); inp.focus() })
      for (const evName of ['keydown', 'keyup', 'keypress']) {
        inp.addEventListener(evName, stopEv)
      }

      const sendBtn = $('button', 'dshp-btn dshp-primary', '发送')
      sendBtn.style.fontSize = '11px'
      sendBtn.style.padding = '4px 10px'
      sendBtn.addEventListener('pointerdown', stopEv)
      sendBtn.addEventListener('mousedown', stopEv)
      sendBtn.addEventListener('click', (e) => {
        stopEv(e)
        if (inp.value.trim()) handleCareUserReply(ev, inp.value.trim())
      })
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && inp.value.trim()) {
          e.preventDefault()
          handleCareUserReply(ev, inp.value.trim())
        }
      })

      inputRow.append(inp, sendBtn)

      // 20 秒无视倒计时进度条 (单次询问协议：无视即彻底静默)
      const progressBar = $('div', 'dshp-care-progress')
      progressBar.style.width = '100%'

      card.append(titleRow, qRow, chipRow, inputRow, progressBar)
      ui.root.appendChild(card)
      reportBoundsToShell()
      setTimeout(() => reportBoundsToShell(), 50)

      let remainingMs = 20000
      const stepMs = 200
      careCountdownTimer = setInterval(() => {
        remainingMs -= stepMs
        if (remainingMs <= 0) {
          dismissCareCard()
        } else {
          progressBar.style.width = `${Math.max(0, (remainingMs / 20000) * 100)}%`
        }
      }, stepMs)
    }

    setInterval(async () => {
      if (CFG.screenVision === false && CFG.screenVisionEnabled === false) return
      if (agent.status !== 'idle') return
      try {
        const res = await perceptionFetch('/perception/status')
        if (res && res.ok && res.screenSensor) {
          const ev = res.screenSensor.lastEvent
          if (ev && ev.id && ev.id !== lastHandledVisionId) {
            lastHandledVisionId = ev.id
            if (CFG.screenVisionMode !== 'quiet' && ev.text) {
              if (ui.bubble) {
                ui.bubble.show(ev.text, { name: activeCharInfo().name, duration: 8000 })
              }
              if (CFG.sound !== false && typeof speakCharacterText === 'function') {
                speakCharacterText(ev.text, activeCharacterId)
              }
              // 触发单次关怀卡片，启动用户回复即截图互动链路
              showProactiveCareCard(ev)
            }
          }
        }
      } catch (e) {}
    }, 2500)

    // 开机初始同步自定义游戏与视觉设置至感知中枢
    setTimeout(() => {
      try {
        if (Array.isArray(CFG.customGames) && CFG.customGames.length > 0) {
          perceptionFetch('/perception/game-list', {
            method: 'POST',
            body: JSON.stringify({ customGames: CFG.customGames })
          }).catch(() => {})
        }
        perceptionFetch('/perception/vision-config', {
          method: 'POST',
          body: JSON.stringify({
            enabled: CFG.screenVisionEnabled !== false,
            mode: CFG.screenVisionMode || 'companion'
          })
        }).catch(() => {})
      } catch (e) {}
    }, 1500)
  }

  // ——————————————————————————————————————————————————————————————
  // 十二、对外小接口（控制台调试 / 扩展）
  // ——————————————————————————————————————————————————————————————
  window.DSHPet = {
    setBase,
    setReaction,
    clearReaction,
    setUserFace,
    clearUserFace,
    setProp,
    clearProps,
    playMotion,
    hitTest,
    feedPointer,
    /** 隐藏 / 恢复。壳子（桌面版）收起成小球后，靠它把页面里的状态一起改回来 */
    setHidden,
    /** 壳子告诉页面「你记着的连接档位是哪一档」（设置页据此高亮） */
    setHostPref: (v) => {
      try {
        if (window.__dshpSetHostPref) window.__dshpSetHostPref(v)
      } catch (err) {}
    },
    setFullscreenPrimary: (v) => {
      try {
        CFG.fullscreenPrimary = !!v
        saveLayout({ fullscreenPrimary: !!v })
        if (window.__dshpSetFullscreenPrimary) window.__dshpSetFullscreenPrimary(!!v)
      } catch (err) {}
    },
    /** 推一条工作简报（头顶出现信封，点开是大号面板） */
    report: (title, body) => pushReport(title || '工作简报', body),
    /** 性能档：壳子/设置页用它切「低性能模式」 */
    setLowPower,
    isLowPower: () => PERF.low,
    rebuildMask: () => {
      mask.dirty = true
    },
    resetGazeStats: () => {
      gaze.stepRate = 0
    },
    /**
     * 诊断用：现在的「手速档位」。
     * 测试靠它验证「正常速度点击不会让她生气」。
     */
    pokeTier: () => pokeTier(),
    /** 诊断用：给一串点击间隔（毫秒），纯计算出会落哪一档。 */
    pokeTierFor: (gaps) => pokeTierForGaps(gaps || []),
    /** 诊断用：清空连点记录。 */
    clearPokes: () => {
      pokeState.times.length = 0
      pokeState.softAt = 0
      pokeState.angerAt = 0
    },
    resetEverything,
    /**
     * 诊断用：菜单现在的样子（按钮名、当前状态行）。
     * 测试用它验证「同一个表情不会出现两次」「点每一项都真的有台词」。
     */
    menu() {
      const chips = []
      if (ui && ui.menu && ui.menu.el) {
        for (const c of ui.menu.el.querySelectorAll('.dshp-chip')) {
          chips.push({ label: c.textContent, on: c.classList.contains('dshp-on'), title: c.title })
        }
      }
      return {
        open: !!(ui && ui.menu && ui.menu.el && ui.menu.el.classList.contains('dshp-on')),
        focused: ui && ui.menu ? ui.menu.focused : null,
        status: menuStatusLine(),
        chips,
        userProps: Array.from(rig.userProps),
        face: rig.user.face,
      }
    },
    /** 诊断用：某个菜单项配的台词（验证「每一项都有话可说」）。 */
    itemLines(kind, key) {
      const t = kind === 'face' ? FACE_ACT : kind === 'decor' ? PROP_ACT : kind === 'action' ? ACTIONS : SCENE_ACT
      return (t && t[key] && t[key].lines) || null
    },
    /** 诊断用：一次动作有哪些可选（测试逐项点一遍）。 */
    actions() {
      return ACTION_KEYS.map((k) => ({ key: k, label: ACTIONS[k].label, expr: ACTIONS[k].expr || null, motion: ACTIONS[k].motion || null, ms: ACTIONS[k].ms }))
    },
    /** 诊断用：直接演一个一次性动作。 */
    playAction: (key) => playAction(key),
    /** 诊断用：某个动作会写哪些参数 / 这些参数当前的值（验证「动作停了姿势有没有清掉」）。 */
    motionParams(group) {
      const meta = (manifest && manifest.motions && manifest.motions[group]) || null
      const ids = meta ? meta.params || [] : []
      const read = (id) => {
        try {
          return typeof coreModel.getParameterValueById === 'function'
            ? +coreModel.getParameterValueById(id).toFixed(4)
            : null
        } catch (e) {
          return null
        }
      }
      const def = (id) => {
        try {
          return typeof coreModel.getParameterDefaultValue === 'function'
            ? +coreModel.getParameterDefaultValue(id).toFixed(4)
            : null
        } catch (e) {
          return null
        }
      }
      return { group, ids: ids.slice(0, 8), total: ids.length, values: ids.map(read), defaults: ids.map(def) }
    },
    /** 诊断用：读某个参数当前值 / 默认值；eyes() 返回眼睛睁开程度（0 闭 1 睁）。 */
    paramValue: (id) => paramValue(id),
    paramDefault: (id) => paramDefault(id),
    eyes: () => eyesOpen(),
    /** 诊断用：眨眼的当前状态（测试用它数「15 秒眨了几次」）。 */
    blink: () => ({ phase: blink.phase, gate: blink.gate, count: blink.count,
      nextIn: Math.max(0, Math.round(blink.nextAt - performance.now())) }),
    /** 诊断用：主动清一次动作姿势（测试与 /control 都能用）。 */
    clearMotionPose: () => clearMotionPose(),
    /** 诊断用：HUD（余额/计价面板）状态与当前显示的文字。 */
    hud: {
      open: () => hud.open,
      show: (opts) => openHud(opts || { flash: true }),
      hide: () => closeHud(),
      refresh: () => hudFetch(true),
      read: () => ({
        open: hud.open,
        source: hud.source || null,
        peak: hud.data ? hud.data.isPeak : null,
        balance: hud.data ? hud.data.totalBalance : null,
        currency: hud.data ? hud.data.currency : null,
        todayUsage: hud.data ? hud.data.todayUsage : null,
        turn: hud.turn ? { amount: hud.turn.amount, tokens: hud.turn.tokens, seq: hud.turn.seq } : null,
        left: hud.left === undefined ? null : hud.left,
        err: hud.err,
        text: ui && ui.hud
          ? {
              badge: ui.hud.badge.textContent,
              badgeClass: ui.hud.badge.className,
              money: ui.hud.money.textContent,
              today: ui.hud.today.textContent,
              turn: ui.hud.turn.textContent,
              countdown: ui.hud.countdown.textContent,
              foot: ui.hud.foot.textContent,
            }
          : null,
      }),
    },
    /**
     * 诊断用：把当前画面降采样成一小撮像素。
     * 测试工具靠它做「施加某个表情前后画面有没有变化」的客观比对——
     * 比肉眼看「这个按钮点了好像没反应」靠谱得多。
     */
    sampleCanvas(size) {
      if (!app || !app.view || !app.view.width) return null
      const W = size || 40
      const H = Math.max(6, Math.round((W * app.view.height) / app.view.width))
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d', { willReadFrequently: true })
      g.clearRect(0, 0, W, H)
      g.drawImage(app.view, 0, 0, W, H)
      const d = g.getImageData(0, 0, W, H).data
      const out = new Array(d.length)
      for (let i = 0; i < d.length; i++) out[i] = d[i]
      return out
    },
    /** 诊断用：某个表达式会写哪些参数、这些参数模型里有没有。 */
    describe(name) {
      const ps = EXPR[name]
      if (!ps) return null
      return {
        params: ps.map((p) => ({ id: p.id, value: p.value, exists: MODEL_PARAMS.has(p.id) })),
        allExist: ps.every((p) => MODEL_PARAMS.has(p.id)),
      }
    },
    /** 诊断用：列出所有可用表情名与道具 key。 */
    catalog() {
      return {
        expressions: Object.keys(EXPR),
        // 菜单的三类：装饰（常驻）/ 场景（常驻）/ 动作（一次性）
        props: Object.keys(PROPS),
        decor: Object.keys(PROPS),
        scenes: Object.keys(SCENES),
        actions: ACTION_KEYS,
        baseItems: Object.keys(BASE_ITEMS),
        moods: Object.keys(MOOD_FACE),
        motions: manifest ? Object.keys(manifest.motions || {}) : [],
      }
    },
    get state() {
      return {
        agent: Object.assign({}, agent),
        mood,
        face: rig.face,
        props: Array.from(rig.props),
        // 诊断用：三层状态各自持有什么，以及「干活轮播/小设备」的开关。
        // 卡住类 bug 全靠这几个字段定位（比如底层还挂着某个道具、轮播还在跑）。
        // 注意：base 这个字段名下面（对象末尾）已经用来放「底层情绪字符串」了，
        // 要保持兼容，所以这里第二个字段叫 baseMood/baseProps。
        userProps: Array.from(rig.userProps),
        overrideProps: rig.override ? (rig.override.props || []).slice() : null,
        overrideLeft: rig.override ? Math.max(0, Math.round(rig.override.until - performance.now())) : 0,
        work: { active: work.active, i: work.i },
        device: { out: device.out },
        modelSize: model ? { w: model.internalModel.width, h: model.internalModel.height } : null,
        view: lastView,
        panels: (() => {
          const read = (el) => {
            if (!el) return null
            const cs = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return {
              on: el.classList.contains('dshp-on'),
              shift: cs.getPropertyValue('--dshp-shift').trim() || '0px',
              left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
            }
          }
          return {
            headX: Math.round(headScreenX()),
            rootCenter: ui && ui.root ? Math.round(ui.root.getBoundingClientRect().left + ui.root.getBoundingClientRect().width / 2) : null,
            menu: read(ui && ui.menu && ui.menu.el),
            composer: read(ui && ui.composer && ui.composer.el),
            hud: read(ui && ui.hud && ui.hud.el),
          }
        })(),
        placement: (() => {
          const r = ui && ui.root ? ui.root.getBoundingClientRect() : null
          return {
            edge: (ui && ui.root && ui.root.dataset.edge) || null,
            left: r ? Math.round(r.left) : null,
            top: r ? Math.round(r.top) : null,
            right: r ? Math.round(window.innerWidth - r.right) : null,
            bottom: r ? Math.round(window.innerHeight - r.bottom) : null,
          }
        })(),
        contentBox,
        exclusive: rig.exclusive || null,
        motion: { playing: !!motionTimer || motionActive(), active: motionActive() },
        acting: acting ? { left: Math.max(0, Math.round(acting.until - performance.now())) } : null,
        // 诊断用：视线控制器 + 框架里真正生效的焦点值（测试靠它验证「有没有阻尼住」）
        gaze: {
          x: +gaze.x.toFixed(4),
          y: +gaze.y.toFixed(4),
          mode: gaze.mode,
          detached: performance.now() < gaze.detachUntil,
          stepRate: +(gaze.stepRate || 0).toFixed(3),
          fcX: gaze.fcX === undefined ? null : +gaze.fcX.toFixed(4),
          fcErr: gaze.fcErr || null,
          limit: gazeCfg().rate,
        },
        focus: model
          ? {
              x: +model.internalModel.focusController.x.toFixed(4),
              y: +model.internalModel.focusController.y.toFixed(4),
            }
          : null,
        override: rig.override ? { mood: rig.override.mood, until: Math.round(rig.override.until - performance.now()) } : null,
      base: rig.base.mood,
      baseMood: rig.base.mood,
      baseProps: rig.base.props.slice().sort(),
        idleSleep: idle.sleep,
        droppedParams: Array.from(droppedParams),
        expressions: Object.keys(EXPR),
        motions: manifest ? Object.keys(manifest.motions || {}) : [],
      }
    },
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main)
  else main()
})()
