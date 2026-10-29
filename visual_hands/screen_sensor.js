/**
 * visual_hands/screen_sensor.js
 * 
 * 伴侣前台视觉感官神经枢纽 (ScreenSensorManager)
 * 遵循面向对象设计：
 * - 结合 ScreenChangeDetector（移植自桌面灵的 RGB 特征差分，不持续截屏）
 * - 结合 BuiltinActiveWindowCapturer（内置开箱即用）与 AppshotPluginAdapter（生态协同）
 * - 动态多媒体（电影/视频播放器/游戏）抑制感知：识别视频播放器与游戏，防止动态画面滥截屏
 * - 伴侣只做“眼睛”，把图像无摩擦送入 DSH 大脑，绝不自建额外视觉 AI 模型
 */

import { ScreenChangeDetector } from './change_detector.js'
import { BuiltinActiveWindowCapturer } from './builtin_capturer.js'
import { AppshotPluginAdapter } from './appshot_adapter.js'

// 常见桌面视频播放器（防动态画面误判）
export const KNOWN_VIDEO_PLAYERS = new Set([
  'potplayer.exe',
  'potplayer64.exe',
  'vlc.exe',
  'mpv.exe',
  'bilibili.exe',
  'iqiyi.exe',
  'youku.exe',
  'qiyi.exe',
  'kmplayer.exe',
  'wmplayer.exe',
])

export class ScreenSensorManager {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true
    this.hostPort = options.hostPort || 19387
    this.detector = new ScreenChangeDetector({
      stableWaitMs: options.stableWaitMs || 1200,
      noiseThreshold: options.noiseThreshold || 0.02,
      candidateThreshold: options.candidateThreshold || 0.08,
      motionWindowMs: options.motionWindowMs || 5000,
      motionFreqThreshold: options.motionFreqThreshold || 3,
      calmDurationMs: options.calmDurationMs || 3500,
    })
    this.builtinCapturer = new BuiltinActiveWindowCapturer()
    this.appshotAdapter = new AppshotPluginAdapter({ hostPort: this.hostPort })
    this._recentVisualSnapshots = [] // 视觉历史环形缓冲区
    this._lastAutoCaptureAt = 0 // 上次自动捕获时间
    this.autoCaptureCooldownMs = options.autoCaptureCooldownMs || 30000 // 自动感官触发至少冷却 30 秒
  }

  setEnabled(val) {
    this.enabled = !!val
    if (!this.enabled) {
      this.detector.reset()
    }
  }

  /**
   * 探测并返回当前视觉捕获引擎状态
   */
  async getStatus() {
    const appshotInstalled = await this.appshotAdapter.probe()
    return {
      enabled: this.enabled,
      mode: appshotInstalled ? 'appshot_integrated' : 'builtin_standalone',
      appshotInstalled,
      isDynamicStream: this.detector.isDynamicStream,
    }
  }

  /**
   * 触发一次前台窗口或活动画面捕获
   * 优先复用生态已有的 dsh-plugin-appshot，未安装时无缝走内置截屏器
   */
  async captureActiveContext(sessionId = 'default') {
    if (!this.enabled) {
      throw new Error('视觉感官未开启')
    }

    const appshotReady = await this.appshotAdapter.probe()
    if (appshotReady) {
      try {
        const result = await this.appshotAdapter.triggerCapture(sessionId)
        return {
          source: 'appshot',
          capturedAt: Date.now(),
          data: result,
        }
      } catch (err) {
        console.warn('[screen-sensor] appshot 触发失败，无缝回退至内置原生截图器:', err.message)
      }
    }

    // 走内置原生截图器
    const shot = await this.builtinCapturer.captureActiveWindow()
    const snapshot = {
      source: 'builtin',
      capturedAt: Date.now(),
      buffer: shot.buffer,
      base64: shot.buffer ? shot.buffer.toString('base64') : '',
      mime: shot.mime || 'image/png',
      width: shot.width,
      height: shot.height,
    }

    this._recentVisualSnapshots.unshift(snapshot)
    if (this._recentVisualSnapshots.length > 5) {
      this._recentVisualSnapshots.pop()
    }

    return snapshot
  }

  /**
   * 评估特征差分，决定是否需要主动注意
   * @param {Buffer} signature 1728 字节特征散列
   * @param {string} sourceKey 来源标识
   * @param {string} foregroundProc 前台进程名
   */
  evaluateSignature(signature, sourceKey, foregroundProc = '') {
    if (!this.enabled) return { changed: false, ratio: 0, isDynamicStream: false }

    // 1. 若前台为已知视频播放器，强制判定为动态视频流抑制
    if (foregroundProc && KNOWN_VIDEO_PLAYERS.has(foregroundProc.toLowerCase())) {
      return { changed: false, ratio: 0, reason: 'known_video_player_suppressed', isDynamicStream: true }
    }

    const result = this.detector.evaluate(signature, sourceKey)

    // 2. 检查自动冷却
    if (result.changed) {
      const now = Date.now()
      if (now - this._lastAutoCaptureAt < this.autoCaptureCooldownMs) {
        return { changed: false, ratio: result.ratio, reason: 'cooldown_suppressed', isDynamicStream: false }
      }
      this._lastAutoCaptureAt = now
    }

    return result
  }
}

export const screenSensorManager = new ScreenSensorManager()
