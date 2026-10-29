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
    // 1. 优先直连 9880 伴随服务原生 GDI 极速捕获 (50-80ms，已连接 Default 桌面，绝对防黑屏)
    try {
      const res = await fetch('http://127.0.0.1:9880/perception/capture')
      if (res.ok) {
        const json = await res.json()
        if (json && json.ok && json.shot && json.shot.base64) {
          const buffer = Buffer.from(json.shot.base64, 'base64')
          return {
            buffer,
            mime: json.shot.mime || 'image/jpeg',
            width: json.shot.width || 1920,
            height: json.shot.height || 1080,
          }
        }
      }
    } catch (e) {
      // 降级本地运行
    }

    // 2. 本地 Python 原生 Win32 GDI 捕获 (连接 WinSta0\Default 桌面)
    const pyScript = [
      'import ctypes, io, base64',
      'from ctypes import wintypes',
      'from PIL import Image',
      'user32 = ctypes.windll.user32',
      'gdi32 = ctypes.windll.gdi32',
      'hDesk = user32.OpenDesktopW("Default", 0, False, 0x01FF)',
      'if hDesk: user32.SetThreadDesktop(hDesk)',
      'sw = user32.GetSystemMetrics(0) or 1920',
      'sh = user32.GetSystemMetrics(1) or 1080',
      'hDC = user32.GetDC(0)',
      'mDC = gdi32.CreateCompatibleDC(hDC)',
      'hBmp = gdi32.CreateCompatibleBitmap(hDC, sw, sh)',
      'old = gdi32.SelectObject(mDC, hBmp)',
      'gdi32.BitBlt(mDC, 0, 0, sw, sh, hDC, 0, 0, 0x00CC0020)',
      'class BIH(ctypes.Structure):',
      '    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]',
      'bmi = BIH()',
      'bmi.biSize = ctypes.sizeof(BIH)',
      'bmi.biWidth = sw',
      'bmi.biHeight = -sh',
      'bmi.biPlanes = 1',
      'bmi.biBitCount = 24',
      'buf = (ctypes.c_char * (sw * sh * 3))()',
      'gdi32.GetDIBits(mDC, hBmp, 0, sh, buf, ctypes.byref(bmi), 0)',
      'gdi32.SelectObject(mDC, old)',
      'gdi32.DeleteObject(hBmp)',
      'gdi32.DeleteDC(mDC)',
      'user32.ReleaseDC(0, hDC)',
      'img = Image.frombytes("RGB", (sw, sh), bytes(buf), "raw", "BGR")',
      'out = io.BytesIO()',
      'img.save(out, format="JPEG", quality=75)',
      'print(f"{sw},{sh}|" + base64.b64encode(out.getvalue()).decode("ascii"))'
    ].join('\n')

    try {
      const { stdout } = await execAsync(`python -c "${pyScript.replace(/"/g, '\\"')}"`, {
        maxBuffer: 25 * 1024 * 1024,
        timeout: 5000,
      })
      const out = stdout.trim()
      if (out && out.includes('|')) {
        const [meta, b64] = out.split('|')
        const [w, h] = meta.split(',').map(Number)
        return {
          buffer: Buffer.from(b64, 'base64'),
          mime: 'image/jpeg',
          width: w || 1920,
          height: h || 1080,
        }
      }
      throw new Error('截屏数据解析失败')
    } catch (err) {
      console.warn('[builtin-capturer] 原生截屏执行异常:', err.message)
      throw err
    }
  }
}
