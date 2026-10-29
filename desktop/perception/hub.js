/**
 * desktop/perception/hub.js
 * 
 * 系统级感知中枢总线 (PerceptionHub)
 * 统一聚合各类感知源，维护长效时间线，向 DSH 大脑提供上下文快照。
 * 并与 SpeechArbitrator 发言权仲裁器协同，严格执行防打扰与优先级过闸。
 */

import { WebPagePerceptionSource } from './sources/web.js'
import { MediaPerceptionSource } from './sources/media.js'
import { GamePerceptionSource } from './sources/game.js'
import { WindowPerceptionSource } from './sources/window.js'
import { speechArbitrator, Priority } from '../../lib/speech-arbitrator.js'

export class PerceptionHub {
  constructor(options = {}) {
    this.web = new WebPagePerceptionSource(options.web || {})
    this.media = new MediaPerceptionSource(options.media || {})
    this.game = new GamePerceptionSource(options.game || {})
    this.window = new WindowPerceptionSource(options.window || {})

    this.sources = [this.web, this.media, this.game, this.window]
    this._timeline = [] // 最近 50 条感知历史时间线
    this._onCompanionSpeakCallback = null

    this._bindEvents()
  }

  setCompanionSpeakCallback(cb) {
    this._onCompanionSpeakCallback = cb
  }

  startAll() {
    for (const src of this.sources) {
      src.start()
    }
  }

  stopAll() {
    for (const src of this.sources) {
      src.stop()
    }
  }

  _bindEvents() {
    for (const src of this.sources) {
      src.onEvent((event) => {
        // 1. 如果需要同步给 DSH 记忆，录入本地时间线
        if (event.syncToDsh) {
          this._timeline.unshift({
            source: event.source,
            type: event.type,
            ts: event.ts,
            data: event.data,
          })
          if (this._timeline.length > 50) {
            this._timeline.pop()
          }
        }

        // 2. 如果是单次关怀提问或音乐评论，检查是否允许开口
        if (event.type === 'proactive_inquiry' || event.type === 'proactive_music_comment') {
          this._handleProactiveSpeak(event)
        }
      })
    }
  }

  _handleProactiveSpeak(event) {
    // 游戏全屏且未开启伴聊模式时，强制静音不开口
    if (this.game.isMutedForGame()) {
      return
    }

    // 向发言权仲裁器申请优先级为 PERCEPTION_PROACTIVE 的信标
    const token = speechArbitrator.acquire(Priority.PERCEPTION_PROACTIVE, `perception_${event.type}`, () => {
      // 被更高优先级打断时立即静默
    })

    if (!token) {
      // 当前有更高优先级任务（如 DSH 回复或告警），主动发言自动取消
      return
    }

    const text = event.data?.questionText || event.data?.suggestedLine || ''
    if (text && typeof this._onCompanionSpeakCallback === 'function') {
      try {
        this._onCompanionSpeakCallback(text, event)
      } catch (err) {
        console.warn('[perception-hub] 伴侣主动发声回调异常:', err.message)
      }
    }
  }

  /**
   * 提供给 DSH 大脑的只读环境快照 (System Lens)
   */
  getContextSnapshot() {
    return {
      currentTrack: this.media.currentTrack,
      foregroundApp: this.window.currentForeground,
      inGame: this.game.inGame,
      currentGame: this.game.currentGame,
      recentTimeline: this._timeline.slice(0, 10),
    }
  }
}

export const perceptionHub = new PerceptionHub()
