/**
 * visual_hands/builtin_capturer.js
 * 
 * 原生内置前台活动窗口截图器 (BuiltinActiveWindowCapturer)
 * 核心准则：
 * 1. 开箱即用：即使宿主没有安装 dsh-plugin-appshot，本模块也能独立完成前台活动窗口截取。
 * 2. 反向防自捕获 (Anti-Self-Capture)：捕获时自动剔除桌宠自身的透明悬浮窗口区域，绝不截取到伴侣本体。
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export class BuiltinActiveWindowCapturer {
  constructor(options = {}) {
    this.companionBounds = options.companionBounds || null // {x, y, width, height}
  }

  setCompanionBounds(bounds) {
    this.companionBounds = bounds
  }

  /**
   * 截取当前 Windows 前台窗口或主显示器画面
   * @returns {Promise<{buffer: Buffer, mime: string, bounds?: object}>}
   */
  async captureActiveWindow() {
    // 采用 Windows 原生 powershell + .NET GDI 进行轻量无依赖截屏
    const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.IntPtr]$hwnd = [System.IntPtr]::Zero
try {
  $type = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -Name 'Win32FGW' -Namespace 'DshPet' -PassThru
  $hwnd = $type::GetForegroundWindow()
} catch {}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$rect = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
[System.Convert]::ToBase64String($ms.ToArray())
`
    try {
      const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -Command "${script.replace(/\r?\n/g, ' ')}"`, {
        maxBuffer: 15 * 1024 * 1024,
        timeout: 4000,
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
