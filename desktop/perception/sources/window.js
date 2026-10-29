/**
 * desktop/perception/sources/window.js
 * 
 * 前台窗口焦点感知源 (WindowPerceptionSource)
 * 借鉴本地 DesktopAICompanion 的窗口管理与进程扫描逻辑。
 * 捕获用户当前正在交互的软件应用（VS Code、终端、设计工具、办公套件），
 * 将工作状态摘要记录入 DSH 时间线。
 */

import { PerceptionSource } from './base.js'

export class WindowPerceptionSource extends PerceptionSource {
  constructor(options = {}) {
    super('window', {
      syncToDsh: options.syncToDsh ?? true,
      allowProactiveSpeak: options.allowProactiveSpeak ?? false,
    })
    this.currentForeground = null // { procName, title, hwnd }
    this.lastChangedAt = 0
  }

  /**
   * 更新前台焦点窗口
   */
  updateForeground(procName, title = '', hwnd = 0) {
    if (!procName) return
    const key = `${procName}::${title}`
    if (this.currentForeground && this.currentForeground.key === key) return

    this.currentForeground = { procName, title, hwnd, key, switchedAt: Date.now() }
    this.lastChangedAt = Date.now()

    this.emit('foreground_switched', this.currentForeground)
  }
}
