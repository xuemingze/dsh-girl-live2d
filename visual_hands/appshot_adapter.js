/**
 * visual_hands/appshot_adapter.js
 * 
 * TaurusWood/dsh-plugin-appshot 插件生态适配器与门面调度器 (Facade)
 * 核心逻辑：
 * 1. 动态探测：探测宿主 DSH 中是否已安装并激活 dsh-plugin-appshot 插件；
 * 2. 优先直调：若用户已安装 dsh-plugin-appshot，直接调用其服务管道（/plugins/appshot/session）捕获前台并交付；
 * 3. 优雅退避：若未安装，平滑切换至本地适配封装的 OOP TargetFilter/TargetWindowFinder 引擎；
 * 4. 彻底绕过自身：无论走哪条路径，均严格贯彻防自截契约。
 */

import { BuiltinActiveWindowCapturer } from './builtin_capturer.js'

export class AppshotPluginAdapter {
  constructor(options = {}) {
    this.hostPort = options.hostPort || 19387
    this.isInstalled = false
    this.lastCheckedAt = 0
    this.builtinCapturer = new BuiltinActiveWindowCapturer(options)
  }

  /**
   * 探测 dsh-plugin-appshot 插件是否已在宿主中就绪
   */
  async probe(force = false) {
    const now = Date.now()
    if (!force && now - this.lastCheckedAt < 15000) {
      return this.isInstalled
    }
    this.lastCheckedAt = now
    try {
      const res = await fetch(`http://127.0.0.1:${this.hostPort}/plugins/appshot/config`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(1000),
      })
      this.isInstalled = res.ok
    } catch {
      this.isInstalled = false
    }
    return this.isInstalled
  }

  /**
   * 执行前台活动窗口捕获：若已安装 dsh-plugin-appshot 则直接调用，否则使用内置 OOP 引擎
   */
  async captureActiveWindow(options = {}) {
    const installed = await this.probe()
    if (installed) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.hostPort}/plugins/appshot/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: options.sessionId || 'companion-active',
            source: 'companion-vision',
          }),
          signal: AbortSignal.timeout(3500),
        })
        if (res.ok) {
          const json = await res.json()
          if (json && json.imagePath) {
            return {
              source: 'dsh-plugin-appshot',
              imagePath: json.imagePath,
              appName: json.appName || '',
              windowTitle: json.windowTitle || '',
            }
          }
        }
      } catch (err) {
        console.warn('[appshot-adapter] 直接调用 dsh-plugin-appshot 异常，降级使用适配封装引擎:', err.message)
      }
    }

    // 未安装或调用异常：使用内置封装的 TargetFilter/GDI 原生捕获
    return await this.builtinCapturer.captureActiveWindow()
  }
}
