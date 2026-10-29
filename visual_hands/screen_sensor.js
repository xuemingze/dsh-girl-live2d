/**
 * visual_hands/screen_sensor.js
 * 
 * 伴侣前台视觉感官神经枢纽 (ScreenSensorManager)
 * 遵循面向对象设计：
 * - 结合 ScreenChangeDetector（移植自桌面灵的 RGB 特征差分，不持续截屏）
 * - 结合 BuiltinActiveWindowCapturer（内置开箱即用）与 AppshotPluginAdapter（生态协同）
 * - 伴侣只做“眼睛”，把图像无摩擦送入 DSH 大脑，绝不自建额外视觉 AI 模型
 */

import { ScreenChangeDetector } from './change_detector.js'
import { BuiltinActiveWindowCapturer } from './builtin_capturer.js'
import { AppshotPluginAdapter } from './appshot_adapter.js'

export class ScreenSensorManager {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true
    this.hostPort = options.hostPort || 19387
    this.detector = new ScreenChangeDetector({
      stableWaitMs: options.stableWaitMs || 1200,
      noiseThreshold: options.noiseThreshold || 0.02,
      candidateThreshold: options.candidateThreshold || 0.08,
    })
    this.builtinCapturer = new BuiltinActiveWindowCapturer()
    this.appshotAdapter = new AppshotPluginAdapter({ hostPort: this.hostPort })
    this._recentVisualSnapshots = [] // 视觉历史环形缓冲区
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
      mime: shot.mime,
    }

    this._recentVisualSnapshots.unshift(snapshot)
    if (this._recentVisualSnapshots.length > 5) {
      this._recentVisualSnapshots.pop()
    }

    return snapshot
  }

  /**
   * 评估特征差分，决定是否需要主动注意
   */
  evaluateSignature(signature, sourceKey) {
    if (!this.enabled) return { changed: false, ratio: 0 }
    return this.detector.evaluate(signature, sourceKey)
  }
}

export const screenSensorManager = new ScreenSensorManager()
