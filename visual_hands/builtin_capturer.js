/**
 * visual_hands/builtin_capturer.js
 * 
 * 原生内置前台活动窗口截图器 (BuiltinActiveWindowCapturer)
 * 核心准则：
 * 1. 开箱即用：即使宿主没有安装 dsh-plugin-appshot，本模块也能独立完成截取。
 * 2. 纯净稳定：使用 PowerShell -EncodedCommand (UTF-16LE Base64) 执行，零转义坑、零参数歧义。
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export class BuiltinActiveWindowCapturer {
  constructor(options = {}) {
    this.companionBounds = options.companionBounds || null
  }

  setCompanionBounds(bounds) {
    this.companionBounds = bounds
  }

  /**
   * 截取当前 Windows 前台窗口或主显示器画面
   * @returns {Promise<{buffer: Buffer, mime: string, width: number, height: number}>}
   */
  async captureActiveWindow() {
    // 采用 Windows 原生 powershell + .NET GDI 进行轻量无依赖截屏
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -AssemblyName System.Drawing;',
      '$screen = [System.Windows.Forms.Screen]::PrimaryScreen;',
      '$rect = $screen.Bounds;',
      '$bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height;',
      '$g = [System.Drawing.Graphics]::FromImage($bmp);',
      '$g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size);',
      '$ms = New-Object System.IO.MemoryStream;',
      '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg);',
      '$b64 = [System.Convert]::ToBase64String($ms.ToArray());',
      '$g.Dispose();',
      '$bmp.Dispose();',
      '$ms.Dispose();',
      'Write-Output $b64;'
    ].join('\n')

    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    try {
      const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
        maxBuffer: 25 * 1024 * 1024,
        timeout: 6000,
      })
      const b64 = stdout.trim()
      if (!b64) throw new Error('截图数据为空')
      const buffer = Buffer.from(b64, 'base64')
      return {
        buffer,
        mime: 'image/jpeg',
        width: 1920,
        height: 1080,
      }
    } catch (err) {
      console.warn('[builtin-capturer] 原生截屏执行异常:', err.message)
      throw err
    }
  }
}
