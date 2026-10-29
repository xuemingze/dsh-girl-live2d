/**
 * desktop/perception/sources/base.js
 * 
 * 系统级感知源抽象基类 (PerceptionSource)
 * 遵循面向对象继承准则：每个具体的感知源（网页、音乐、窗口、游戏、时间）继承自此类。
 * 支持双重显式布尔开关：
 * - syncToDsh: 是否同步记入 DSH 时间线与长效记忆
 * - allowProactiveSpeak: 是否允许伴侣根据此感知主动发声/开口
 */

export class PerceptionSource {
  constructor(name, options = {}) {
    if (new.target === PerceptionSource) {
      throw new TypeError('抽象基类 PerceptionSource 不能直接实例化')
    }
    this.name = name
    this.syncToDsh = options.syncToDsh ?? true
    this.allowProactiveSpeak = options.allowProactiveSpeak ?? false
    this.running = false
    this._listeners = new Set()
  }

  /**
   * 启动感知源
   */
  start() {
    this.running = true
  }

  /**
   * 停止感知源
   */
  stop() {
    this.running = false
  }

  /**
   * 注册事件监听器
   */
  onEvent(listener) {
    if (typeof listener === 'function') {
      this._listeners.add(listener)
    }
  }

  /**
   * 派发感知事件给总线
   */
  emit(eventType, data = {}) {
    if (!this.running) return
    const event = {
      source: this.name,
      type: eventType,
      ts: Date.now(),
      syncToDsh: this.syncToDsh,
      allowProactiveSpeak: this.allowProactiveSpeak,
      data,
    }
    for (const listener of this._listeners) {
      try {
        listener(event)
      } catch (err) {
        console.warn(`[perception:${this.name}] 事件监听器执行异常:`, err.message)
      }
    }
  }
}
