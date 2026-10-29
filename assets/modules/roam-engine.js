/**
 * assets/modules/roam-engine.js
 * 
 * 全桌面漫步巡逻与动作联动引擎 (DesktopRoamEngine)
 * 采用策略模式驱动行走动画：
 * - NativeMotionWalkStrategy: 模型自身声明了 walk 动画（如 可可女仆 / 走路动画.motion3.json）
 * - ProceduralSpringWalkStrategy: 无独立走路动画的模型（鲸鱼娘 / 兔兔 / 西域舞女等），利用弹簧物理步态跳跃(Bobbing)与侧倾
 */

export class WalkAnimationStrategy {
  enter(context) {}
  update(context, dt, phase) {}
  exit(context) {}
}

export class NativeMotionWalkStrategy extends WalkAnimationStrategy {
  constructor(walkMotionFile) {
    super()
    this.walkMotionFile = walkMotionFile
  }

  enter(context) {
    if (!context.model || !context.model.internalModel) return
    const mm = context.model.internalModel.motionManager
    if (!mm || !mm.definitions) return
    if (typeof context.previewMotion === 'function') {
      context.previewMotion(this.walkMotionFile, true)
    }
  }

  update(context, dt, phase) {
    // 原生动作自身包含动画曲线
  }

  exit(context) {
    if (typeof context.resumeIdle === 'function') {
      context.resumeIdle()
    }
  }
}

export class ProceduralSpringWalkStrategy extends WalkAnimationStrategy {
  constructor(springController) {
    super()
    this.spring = springController
    this.phase = 0
  }

  enter(context) {
    this.phase = 0
  }

  update(context, dt, phase) {
    // 步态跳动 (Bobbing)：模拟走动时身体轻盈上下起伏与轻度左右微倾
    const bobAmp = 5 // 像素起伏
    const bobY = -Math.abs(Math.sin(phase)) * bobAmp
    const swayAngle = Math.sin(phase) * 0.035 // 约 2 度侧倾
    if (context.model) {
      context.model.y = (context.baseModelY || 0) + bobY
      context.model.rotation = swayAngle
    }
  }

  exit(context) {
    if (context.model) {
      context.model.y = context.baseModelY || 0
      context.model.rotation = 0
    }
    // 落步缓冲：轻微弹跳收脚
    if (this.spring) {
      this.spring.kick(0.25)
    }
    if (typeof context.resumeIdle === 'function') {
      context.resumeIdle()
    }
  }
}

export class DesktopRoamEngine {
  constructor(options = {}) {
    this.stageEl = options.stageEl
    this.modelGetter = options.modelGetter
    this.springCtrl = options.springController || options.springCtrl
    this.previewMotion = options.previewMotion
    this.resumeIdle = options.resumeIdle
    this.onPositionChange = options.onPositionChange
    this.getCharacterAssets = options.getCharacterAssets

    // 状态机
    this.state = 'IDLE' // 'IDLE' | 'WALKING' | 'PAUSED' | 'RETURNING'
    this.enabled = true
    this.facing = 1     // 1 = 朝右, -1 = 朝左

    // 坐标与视口
    this.x = options.initialX || 0
    this.y = options.initialY || 0
    this.targetX = this.x
    this.targetY = this.y
    this.anchorX = this.x
    this.anchorY = this.y
    this.speed = 100    // 像素/秒

    this.walkPhase = 0
    this.stepFreq = 7   // 步频 (rad/s)
    this.nextPatrolTime = Date.now() + 25000 // 首次漫步等待 25 秒

    this.currentStrategy = null
    this.pausedReason = null
    this.baseModelY = 0
  }

  resolveStrategy() {
    const assets = typeof this.getCharacterAssets === 'function' ? this.getCharacterAssets() : null
    let walkFile = null
    if (assets && assets.motions) {
      if (assets.motions.walk) walkFile = assets.motions.walk
      else if (assets.motions.click && assets.motions.click.includes('走')) walkFile = assets.motions.click
      else {
        const actions = (assets.categories && assets.categories.action) || []
        const found = actions.find(a => a.toLowerCase().includes('走') || a.toLowerCase().includes('walk'))
        if (found) walkFile = found
      }
    }

    if (walkFile) {
      return new NativeMotionWalkStrategy(walkFile)
    }
    return new ProceduralSpringWalkStrategy(this.springCtrl)
  }

  walkTo(targetX, targetY, reason = 'patrol') {
    if (!this.enabled) return
    const bounds = this.getScreenBounds()
    this.targetX = Math.max(bounds.minX, Math.min(bounds.maxX, targetX))
    this.targetY = Math.max(bounds.minY, Math.min(bounds.maxY, targetY))

    const dx = this.targetX - this.x
    if (Math.abs(dx) < 15 && Math.abs(this.targetY - this.y) < 15) return

    // 面向目的地
    this.setFacing(dx >= 0 ? 1 : -1)

    this.currentStrategy = this.resolveStrategy()
    const ctx = this.getStrategyContext()
    this.currentStrategy.enter(ctx)

    this.state = reason === 'return' ? 'RETURNING' : 'WALKING'
    this.walkPhase = 0
  }

  setFacing(direction) {
    this.facing = direction >= 0 ? 1 : -1
  }

  getScreenBounds() {
    const winW = typeof window !== 'undefined' ? (window.innerWidth || 1920) : 1920
    const winH = typeof window !== 'undefined' ? (window.innerHeight || 1080) : 1080
    const pad = 24
    const petW = this.stageEl ? this.stageEl.offsetWidth || 180 : 180
    const petH = this.stageEl ? this.stageEl.offsetHeight || 180 : 180
    return {
      minX: pad,
      maxX: Math.max(pad + 100, winW - petW - pad),
      minY: Math.max(pad, winH - petH - 120), // 在任务栏上方巡逻
      maxY: Math.max(pad, winH - petH - pad),
    }
  }

  startRandomPatrol() {
    const bounds = this.getScreenBounds()
    const randX = bounds.minX + Math.random() * (bounds.maxX - bounds.minX)
    const randY = bounds.minY + Math.random() * (bounds.maxY - bounds.minY)
    this.walkTo(randX, randY, 'patrol')
  }

  setBlocked(blocked, reason = 'ui') {
    const b = !!blocked
    if (this.isBlockedByUI === b) return
    this.isBlockedByUI = b
    if (this.isBlockedByUI) {
      if (this.state === 'WALKING' || this.state === 'RETURNING') {
        this.pause(reason)
      }
      this.nextPatrolTime = Date.now() + 25000
    } else {
      if (this.state === 'PAUSED' && (this.pausedReason === 'ui' || this.pausedReason === 'hover' || this.pausedReason === 'setting' || this.pausedReason === 'menu')) {
        this.resume()
      }
    }
  }

  setRoaming(enabled) {
    this.enabled = !!enabled
    if (!this.enabled && (this.state === 'WALKING' || this.state === 'RETURNING')) {
      this.state = 'IDLE'
      if (this.currentStrategy) {
        this.currentStrategy.exit(this.getStrategyContext())
        this.currentStrategy = null
      }
    }
  }

  setAnchor(x, y) {
    if (this.currentStrategy && (this.state === 'WALKING' || this.state === 'RETURNING')) {
      try {
        this.currentStrategy.exit(this.getStrategyContext())
      } catch (e) {}
      this.currentStrategy = null
    }
    this.state = 'IDLE'
    this.pausedReason = null
    this.anchorX = x
    this.anchorY = y
    this.x = x
    this.y = y
    this.targetX = x
    this.targetY = y
    this.nextPatrolTime = Date.now() + 30000
  }

  onDragStart(x, y) {
    this.isDragging = true
    if (this.currentStrategy) {
      try {
        this.currentStrategy.exit(this.getStrategyContext())
      } catch (e) {}
      this.currentStrategy = null
    }
    this.state = 'IDLE'
    this.pausedReason = null
    if (typeof x === 'number' && !isNaN(x)) {
      this.x = x
      this.targetX = x
      this.anchorX = x
    }
    if (typeof y === 'number' && !isNaN(y)) {
      this.y = y
      this.targetY = y
      this.anchorY = y
    }
    this.nextPatrolTime = Date.now() + 30000
  }

  onDragMove(x, y) {
    this.isDragging = true
    this.state = 'IDLE'
    this.pausedReason = null
    if (typeof x === 'number' && !isNaN(x)) {
      this.x = x
      this.targetX = x
      this.anchorX = x
    }
    if (typeof y === 'number' && !isNaN(y)) {
      this.y = y
      this.targetY = y
      this.anchorY = y
    }
  }

  onDragEnd(x, y) {
    this.isDragging = false
    this.setAnchor(
      typeof x === 'number' && !isNaN(x) ? x : this.x,
      typeof y === 'number' && !isNaN(y) ? y : this.y,
    )
  }

  returnToAnchor() {
    if (this.anchorX != null && this.anchorY != null) {
      this.walkTo(this.anchorX, this.anchorY, 'return')
    } else {
      this.recall()
    }
  }

  recall() {
    if (this.anchorX != null && this.anchorY != null) {
      this.walkTo(this.anchorX, this.anchorY, 'return')
      return
    }
    const bounds = this.getScreenBounds()
    this.walkTo(bounds.maxX - 10, bounds.maxY - 10, 'return')
  }

  pause(reason = 'hover') {
    if (this.state === 'WALKING' || this.state === 'RETURNING') {
      this.state = 'PAUSED'
      this.pausedReason = reason
      if (this.currentStrategy) {
        this.currentStrategy.exit(this.getStrategyContext())
      }
    }
  }

  resume() {
    if (this.state === 'PAUSED') {
      this.state = 'WALKING'
      this.pausedReason = null
      if (this.currentStrategy) {
        this.currentStrategy.enter(this.getStrategyContext())
      }
    }
  }

  getStrategyContext() {
    const model = typeof this.modelGetter === 'function' ? this.modelGetter() : null
    return {
      model,
      previewMotion: this.previewMotion,
      resumeIdle: this.resumeIdle,
      stageEl: this.stageEl,
      baseModelY: this.baseModelY
    }
  }

  update(dt) {
    return this.step(dt)
  }

  step(dt) {
    if (this.isDragging || !this.enabled || this.isBlockedByUI) {
      this.nextPatrolTime = Math.max(this.nextPatrolTime, Date.now() + 25000)
      return
    }
    const now = Date.now()
    if (this.state === 'PAUSED') {
      this.nextPatrolTime = Math.max(this.nextPatrolTime, now + 25000)
      return
    }

    // 空闲定时巡逻
    if (this.state === 'IDLE' && now >= this.nextPatrolTime) {
      this.startRandomPatrol()
      this.nextPatrolTime = now + 35000 + Math.random() * 25000
    }

    if (this.state !== 'WALKING' && this.state !== 'RETURNING') return

    const dx = this.targetX - this.x
    const dy = this.targetY - this.y
    const dist = Math.hypot(dx, dy)

    if (dist <= 4) {
      this.x = this.targetX
      this.y = this.targetY
      this.state = 'IDLE'
      if (this.currentStrategy) {
        this.currentStrategy.exit(this.getStrategyContext())
        this.currentStrategy = null
      }
      this.applyDomPosition()
      this.nextPatrolTime = now + 30000 + Math.random() * 30000
      return
    }

    const moveDist = Math.min(dist, this.speed * dt)
    this.x += (dx / dist) * moveDist
    this.y += (dy / dist) * moveDist

    this.walkPhase += dt * this.stepFreq
    if (this.currentStrategy) {
      this.currentStrategy.update(this.getStrategyContext(), dt, this.walkPhase)
    }

    this.applyDomPosition()
  }

  applyDomPosition() {
    if (this.stageEl) {
      this.stageEl.style.left = `${Math.round(this.x)}px`
      this.stageEl.style.top = `${Math.round(this.y)}px`
      this.stageEl.style.right = 'auto'
      this.stageEl.style.bottom = 'auto'
      this.stageEl.style.position = 'fixed'
    }
    if (typeof this.onPositionChange === 'function') {
      this.onPositionChange(this.x, this.y, this.facing)
    }
  }
}

if (typeof window !== 'undefined') {
  window.__DSH_ENGINES__ = window.__DSH_ENGINES__ || {}
  Object.assign(window.__DSH_ENGINES__, {
    WalkAnimationStrategy,
    NativeMotionWalkStrategy,
    ProceduralSpringWalkStrategy,
    DesktopRoamEngine
  })
}
