/**
 * lib/speech-arbitrator.js
 * 
 * 发言权仲裁器 (SpeechArbitrator)
 * 从根本上解决多音轨打架、回声与气泡被低优先级内容覆盖的抢权顽疾。
 * 
 * 优先级分级定义：
 * 100 - ALERT: 紧急警告、报错提醒（可打断一切）
 *  80 - ASSISTANT_REPLY: DSH 大脑主回复/任务结算（打断主动闲聊，不打断报警）
 *  50 - USER_INTERACTION: 用户主动点击、摸头、拖拽（仅空闲时出声）
 *  30 - PERCEPTION_PROACTIVE: 系统感知单次关怀（听歌、查机票租房问询，排队或让位）
 *  10 - IDLE_ROUTINE: 待机挂机闲聊（最低优先级，随时让位）
 */

export const Priority = {
  ALERT: 100,
  ASSISTANT_REPLY: 80,
  USER_INTERACTION: 50,
  PERCEPTION_PROACTIVE: 30,
  IDLE_ROUTINE: 10,
}

export class SpeechArbitrator {
  constructor() {
    this._activeSession = null
  }

  /**
   * 申请发言权
   * @param {number} priority 优先级数值
   * @param {string} sourceName 来源名称标识（用于调试排查）
   * @param {Function} onPreempted 当被更高优先级打断时的强断回调
   * @returns {string|null} 成功则返回 sessionToken，失败返回 null
   */
  acquire(priority = Priority.IDLE_ROUTINE, sourceName = 'anonymous', onPreempted = null) {
    const currentPriority = this._activeSession ? this._activeSession.priority : 0

    // 严禁低优先级打断高优先级
    if (this._activeSession && priority < currentPriority) {
      return null
    }

    // 若当前有同级或低级发言者，先优雅强断旧发言者
    if (this._activeSession) {
      try {
        if (typeof this._activeSession.onPreempted === 'function') {
          this._activeSession.onPreempted(priority, sourceName)
        }
      } catch (err) {
        console.warn(`[arbitrator] 打断前发言者 [${this._activeSession.sourceName}] 异常:`, err.message)
      }
    }

    const token = 'spk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
    this._activeSession = {
      token,
      priority,
      sourceName,
      startedAt: Date.now(),
      onPreempted,
    }

    return token
  }

  /**
   * 释放发言权
   * @param {string} token 申请时返回的 sessionToken
   */
  release(token) {
    if (this._activeSession && this._activeSession.token === token) {
      this._activeSession = null
      return true
    }
    return false
  }

  /**
   * 当前是否有活动发言者
   */
  isBusy() {
    return !!this._activeSession
  }

  /**
   * 获取当前占用者优先级
   */
  getCurrentPriority() {
    return this._activeSession ? this._activeSession.priority : 0
  }

  /**
   * 强行重置/释放所有占用
   */
  forceReset() {
    if (this._activeSession && typeof this._activeSession.onPreempted === 'function') {
      try {
        this._activeSession.onPreempted(999, 'force_reset')
      } catch (e) {}
    }
    this._activeSession = null
  }
}

export const speechArbitrator = new SpeechArbitrator()
