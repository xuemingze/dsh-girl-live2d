/**
 * visual_hands/appshot_adapter.js
 * 
 * TaurusWood/dsh-plugin-appshot 插件生态适配器
 * 自动检测宿主 DSH 环境中是否安装了 dsh-plugin-appshot。
 * 若已安装，无缝对接其 /plugins/appshot/session 与事件总线，实现全局快捷键（如双击 Ctrl）联动。
 */

export class AppshotPluginAdapter {
  constructor(options = {}) {
    this.hostPort = options.hostPort || 19387
    this.isInstalled = false
    this.lastCheckedAt = 0
  }

  /**
   * 探测 dsh-plugin-appshot 插件是否已在宿主中就绪
   */
  async probe(force = false) {
    const now = Date.now()
    if (!force && now - this.lastCheckedAt < 30000) {
      return this.isInstalled
    }
    this.lastCheckedAt = now
    try {
      const res = await fetch(`http://127.0.0.1:${this.hostPort}/plugins/appshot/config`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(1200),
      })
      this.isInstalled = res.ok
    } catch {
      this.isInstalled = false
    }
    return this.isInstalled
  }

  /**
   * 通过 appshot 管道触发一次前台窗口捕获并挂载至会话
   */
  async triggerCapture(sessionId = 'default') {
    const available = await this.probe()
    if (!available) {
      throw new Error('dsh-plugin-appshot 未就绪')
    }
    const res = await fetch(`http://127.0.0.1:${this.hostPort}/plugins/appshot/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, source: 'companion' }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      throw new Error(`appshot 触发失败: HTTP ${res.status}`)
    }
    return await res.json()
  }
}
