/**
 * assets/modules/core-engines.js
 * 
 * 面向对象核心引擎集：
 * 1. SpringPhysicsController - 基于半隐式欧拉积分的真实物理弹簧（捏脸按压 + 步态跳动）
 * 2. FrameRateGovernor - 待机智能降帧控制器（30fps -> 15fps GPU 减半，动静即时唤醒）
 * 3. DockAutoHideController - 四按钮点击按需唤出与贴边自适应
 */

export const PRESS_PROFILE_DEFAULT = {
  depth: 0.12,          // 满压时纵向缩放比例 (0.12 = 88%)
  volume: 0.6,          // 体积守恒程度 0~1 (横向变宽)
  pressOmega: 36,       // 按下自然频率 (rad/s)
  pressZeta: 0.95,      // 按下阻尼比 (接近临界阻尼，干脆不冲)
  releaseOmega: 22,     // 松开自然频率 (rad/s)
  releaseZeta: 0.3,     // 松开阻尼比 (欠阻尼，Q弹晃动 2.5 次)
  kick: 34              // 冲量强度
}

export class SpringPhysicsController {
  constructor(getProfileFn) {
    this.getProfile = typeof getProfileFn === 'function' ? getProfileFn : () => PRESS_PROFILE_DEFAULT
    this.p = 0      // 位移：0=原位，1=满压，<0=过冲拉长
    this.v = 0      // 速度
    this.target = 0 // 目标位移
    this.substep = 1 / 240
  }

  press() {
    this.target = 1
  }

  release() {
    this.target = 0
  }

  kick(power = 1) {
    const p = this.getProfile()
    this.v += (p.kick || 34) * Number(power)
  }

  step(dt) {
    if (!dt || dt <= 0) return
    const p = this.getProfile()
    const isPress = this.target > 0.5
    const omega = isPress ? (p.pressOmega || 36) : (p.releaseOmega || 22)
    const zeta = isPress ? (p.pressZeta || 0.95) : (p.releaseZeta || 0.3)
    const omegaSq = omega * omega
    const twoZetaOmega = 2 * zeta * omega

    let t = Math.min(dt, 0.1) // 限制最大步长防跳帧爆炸
    while (t > 0) {
      const h = Math.min(t, this.substep)
      // 半隐式欧拉
      const a = -omegaSq * (this.p - this.target) - twoZetaOmega * this.v
      this.v += a * h
      this.p += this.v * h
      t -= h
    }

    // 静止休眠吸附
    if (Math.abs(this.p - this.target) < 1e-4 && Math.abs(this.v) < 1e-3) {
      this.p = this.target
      this.v = 0
    }
  }

  getScale() {
    const prof = this.getProfile()
    const depth = prof.depth || 0.12
    const volume = prof.volume || 0.6
    const sy = 1 - depth * this.p
    const safeSy = Math.max(0.2, sy)
    const sx = Math.pow(1 / safeSy, volume)
    return { sx, sy, p: this.p }
  }

  isResting() {
    return Math.abs(this.p - this.target) < 1e-4 && Math.abs(this.v) < 1e-3
  }
}

export class FrameRateGovernor {
  constructor(pixiApp, options = {}) {
    this.app = pixiApp
    this.idleDelayMs = options.idleDelayMs || 4000
    this.normalFps = options.normalFps || 30
    this.lowFps = options.lowFps || 15
    this.lastActivity = Date.now()
    this.isLow = false
    this.enabled = true
  }

  touch() {
    this.lastActivity = Date.now()
    if (this.isLow) {
      this.restoreNormal()
    }
  }

  restoreNormal() {
    this.isLow = false
    if (this.app && this.app.ticker) {
      this.app.ticker.maxFPS = this.normalFps
    }
  }

  enterLowPower() {
    this.isLow = true
    if (this.app && this.app.ticker) {
      this.app.ticker.maxFPS = this.lowFps
    }
  }

  update(now = Date.now()) {
    if (!this.enabled || !this.app || !this.app.ticker) return
    if (!this.isLow && now - this.lastActivity > this.idleDelayMs) {
      this.enterLowPower()
    }
  }
}

export class DockAutoHideController {
  constructor(dockEl, options = {}) {
    this.dock = dockEl
    this.autoHideMs = options.autoHideMs || 4000
    this.timer = null
    this.visible = false
  }

  show() {
    if (!this.dock) return
    this.visible = true
    this.dock.classList.add('dshp-dock-active')
    this.dock.style.opacity = '1'
    this.dock.style.pointerEvents = 'auto'
    this.touch()
  }

  hide() {
    if (!this.dock) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.visible = false
    this.dock.classList.remove('dshp-dock-active')
    this.dock.style.opacity = '0'
    this.dock.style.pointerEvents = 'none'
  }

  touch() {
    if (!this.visible) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.hide(), this.autoHideMs)
  }

  toggle() {
    if (this.visible) this.hide()
    else this.show()
  }
}

if (typeof window !== 'undefined') {
  window.__DSH_ENGINES__ = window.__DSH_ENGINES__ || {}
  Object.assign(window.__DSH_ENGINES__, {
    PRESS_PROFILE_DEFAULT,
    SpringPhysicsController,
    FrameRateGovernor,
    DockAutoHideController
  })
}
