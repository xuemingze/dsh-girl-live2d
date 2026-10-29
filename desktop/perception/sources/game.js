/**
 * desktop/perception/sources/game.js
 * 
 * 游戏感知源 (GamePerceptionSource)
 * 监听游戏进程状态（不依赖全屏独占，只要游戏进程开启即生效），严格提供「伴聊模式」双态切换：
 * - 伴聊模式关闭（默认）：一旦检测到游戏进程运行，伴侣立即全局静默，绝不抢音频打扰！
 * - 伴聊模式开启：在游戏运行期间保持活跃伴聊互动。
 */

import { exec } from 'node:child_process'
import { PerceptionSource } from './base.js'

// 常见游戏可执行文件特征库 (小写匹配)
export const KNOWN_GAME_PROCESSES = {
  'yuanshen.exe': '原神',
  'genshinimpact.exe': '原神 (国际服)',
  'starrail.exe': '崩坏：星穹铁道',
  'zenlesszonezero.exe': '绝区零',
  'bh3.exe': '崩坏3',
  'league of legends.exe': '英雄联盟',
  'leagueclient.exe': '英雄联盟客户端',
  'cs2.exe': '反恐精英 2 (CS2)',
  'csgo.exe': '反恐精英：全球攻势',
  'dota2.exe': 'DOTA 2',
  'valorant-win64-shipping.exe': '无畏契约 (瓦罗兰特)',
  'narakabladepoint.exe': '永劫无间',
  'naraka.exe': '永劫无间',
  'b1-win64-shipping.exe': '黑神话：悟空',
  'cyberpunk2077.exe': '赛博朋克 2077',
  'eldenring.exe': '艾尔登法环',
  'gta5.exe': '侠盗猎车手 5',
  'r5apex.exe': 'Apex 英雄',
  'overwatch.exe': '守望先锋',
  'minecraft.windows.exe': '我的世界 (基岩版)',
  'palworld-win64-shipping.exe': '幻兽帕鲁',
  'monsterhunterworld.exe': '怪物猎人：世界',
  'monsterhunterwilds.exe': '怪物猎人：荒野',
  'crossfire.exe': '穿越火线',
  'dnf.exe': '地下城与勇士',
}

export class GamePerceptionSource extends PerceptionSource {
  constructor(options = {}) {
    super('game', {
      syncToDsh: options.syncToDsh ?? true,
      allowProactiveSpeak: options.allowProactiveSpeak ?? false,
    })
    this.companionMode = options.companionMode ?? false // 伴聊模式开关（true=伴聊，false=静默）
    this.inGame = false
    this.currentGame = null
    this.scanIntervalMs = options.scanIntervalMs ?? 5000
    this._timer = null
    this._customGameList = new Set(options.customGameList || [])
  }

  setCompanionMode(enabled) {
    this.companionMode = !!enabled
  }

  addCustomGame(exeName) {
    if (exeName) this._customGameList.add(exeName.toLowerCase().trim())
  }

  start() {
    super.start()
    if (!this._timer) {
      this._pollProcesses()
      this._timer = setInterval(() => this._pollProcesses(), this.scanIntervalMs)
      if (this._timer && this._timer.unref) this._timer.unref()
    }
  }

  stop() {
    super.stop()
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  /**
   * 扫描 Windows 运行中进程判定游戏状态
   */
  _pollProcesses() {
    if (process.platform !== 'win32') return

    exec('tasklist /fo csv /nh', { windowsHide: true, timeout: 3500 }, (err, stdout) => {
      if (err || !stdout) return
      const lowerOut = stdout.toLowerCase()
      let detectedGame = null

      // 1. 匹配已知游戏字典
      for (const [exe, name] of Object.entries(KNOWN_GAME_PROCESSES)) {
        if (lowerOut.includes(`"${exe}"`)) {
          detectedGame = name
          break
        }
      }

      // 2. 匹配用户自定义游戏
      if (!detectedGame && this._customGameList.size > 0) {
        for (const exe of this._customGameList) {
          if (lowerOut.includes(`"${exe}"`)) {
            detectedGame = exe
            break
          }
        }
      }

      this.setGameState(!!detectedGame, detectedGame || '')
    })
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
   * 规则：只要在游戏中，且未开启“伴聊模式”，即强制静音
   */
  isMutedForGame() {
    return this.inGame && !this.companionMode
  }
}
