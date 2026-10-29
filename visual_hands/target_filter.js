/**
 * visual_hands/target_filter.js
 * 
 * 移植封装自 TaurusWood/dsh-plugin-appshot (Capture/TargetFilter.cs & TargetWindowFinder.cs)
 * 面向对象前台目标窗口过滤与锁定核心
 * 
 * 过滤原则：
 * - 排除 DSH 宿主自身（DSH Desktop、DeepSeek Harness、dsh）
 * - 排除桌宠透明宿主自身（dsh-girl-live2d、Electron 伴侣悬浮窗）
 * - 排除系统外壳（Progman、WorkerW 桌面底层，Shell_TrayWnd、Shell_SecondaryTrayWnd 任务栏）
 * - 排除 Cloaked（DWM 隐藏）、最小化、不可见窗口
 * - 保留有效目标应用窗口，并将矩形约束裁剪至显示器内
 */

export const FilterReason = {
  Capturable: 'Capturable',
  DshWindow: 'DshWindow',
  PetWindow: 'PetWindow',
  Desktop: 'Desktop',
  Taskbar: 'Taskbar',
  Cloaked: 'Cloaked',
  Minimized: 'Minimized',
  NotVisible: 'NotVisible',
}

export class TargetFilter {
  static ClassProgman = 'Progman'
  static ClassWorkerW = 'WorkerW'
  static ClassShellTray = 'Shell_TrayWnd'
  static ClassShellSecondaryTray = 'Shell_SecondaryTrayWnd'

  /**
   * 评估窗口是否可作为截图目标
   * @param {object} win { hwnd, processId, className, title, isCloaked, isIconic, isVisible, processName }
   * @param {object} options { dshPid, petPid, petTitles }
   * @returns {string} FilterReason
   */
  static evaluate(win, options = {}) {
    if (!win.isVisible) return FilterReason.NotVisible
    if (win.isIconic) return FilterReason.Minimized
    if (win.isCloaked) return FilterReason.Cloaked

    // 过滤 DSH 宿主
    if (this.isDshProcess(win.processId, win.processName, options.dshPid)) {
      return FilterReason.DshWindow
    }

    // 过滤伴侣自身悬浮窗 (防止自截)
    if (this.isPetProcess(win.processId, win.processName, win.title, win.className, options)) {
      return FilterReason.PetWindow
    }

    // 过滤桌面表面
    if (win.className === this.ClassProgman || win.className === this.ClassWorkerW) {
      return FilterReason.Desktop
    }

    // 过滤任务栏
    if (win.className === this.ClassShellTray || win.className === this.ClassShellSecondaryTray) {
      return FilterReason.Taskbar
    }

    return FilterReason.Capturable
  }

  static isDshProcess(pid, processName = '', dshPid = 0) {
    if (dshPid > 0 && pid === dshPid) return true
    if (!processName) return false
    const name = processName.toLowerCase().replace(/\.exe$/, '')
    return name === 'dsh desktop' || name === 'deepseek harness' || name === 'dsh'
  }

  static isPetProcess(pid, processName = '', title = '', className = '', options = {}) {
    if (options.petPid && pid === options.petPid) return true
    const pName = (processName || '').toLowerCase()
    const t = (title || '').toLowerCase()
    const c = (className || '').toLowerCase()

    if (t.includes('dsh-girl-live2d') || t.includes('dsh桌宠') || t.includes('live2d pet')) {
      return true
    }
    if (c.includes('live2d') || c.includes('pet_overlay')) {
      return true
    }
    return false
  }
}

export class SingleMonitorCheck {
  static MaximizeTolerance = 16

  /**
   * 检查窗口矩形是否位于显示器范围内
   */
  static isWithinMonitor(winRect, monRect, tolerance = SingleMonitorCheck.MaximizeTolerance) {
    return (
      winRect.left >= monRect.left - tolerance &&
      winRect.top >= monRect.top - tolerance &&
      winRect.right <= monRect.right + tolerance &&
      winRect.bottom <= monRect.bottom + tolerance
    )
  }

  /**
   * 将最大化或超出屏幕的负边框物理裁剪至显示器内
   */
  static clampToMonitor(winRect, monRect) {
    const left = Math.max(winRect.left, monRect.left)
    const top = Math.max(winRect.top, monRect.top)
    const right = Math.min(winRect.right, monRect.right)
    const bottom = Math.min(winRect.bottom, monRect.bottom)
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    }
  }
}
