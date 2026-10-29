/**
 * desktop/perception/sources/game.js
 * 
 * 游戏与全屏感知源 (GamePerceptionSource)
 * 监听全屏独占与游戏进程状态，严格提供「伴聊模式」双态切换：
 * - 伴聊模式关闭（默认）：一旦进入全屏游戏，伴侣立即全局静默，绝不挡视线或抢音频！
 * - 伴聊模式开启：在游戏空档期间轻度互动。
 */

import { PerceptionSource } from './base.js'

export class GamePerceptionSource extends PerceptionSource {
  constructor(options = {}) {
    super('game', {
      syncToDsh: options.syncToDsh ?? true,
      allowProactiveSpeak: options.allowProactiveSpeak ?? false,
    })
    this.companionMode = options.companionMode ?? false // 伴聊模式开关
    this.inGame = false
    this.currentGame = null
  }

  setCompanionMode(enabled) {
    this.companionMode = !!enabled
  }

  /**
   * 更新游戏状态
   */
  setGameState(inGame, gameName = '') {
    const wasInGame = this.inGame
    this.inGame = !!inGame
    this.currentGame = inGame ? gameName : null

    if (!wasInGame && this.inGame) {
      this.emit('game_entered', {
        game: gameName,
        companionMode: this.companionMode,
        shouldSilence: !this.companionMode,
      })
    } else if (wasInGame && !this.inGame) {
      this.emit('game_exited', {
        game: gameName,
        companionMode: this.companionMode,
      })
    }
  }

  /**
   * 判定当前是否应该强制静音
   */
  isMutedForGame() {
    return this.inGame && !this.companionMode
  }
}
