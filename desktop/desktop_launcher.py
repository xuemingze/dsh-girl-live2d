# -*- coding: utf-8 -*-
"""
DS 鲸鱼娘 · 独立桌面常驻启动器 (Windows 独立渲染外壳)
======================================================
实现机制：
1. 强制绑定 WinSta0\\Default 真实交互桌面，确保无论从何种后台服务/沙箱进程拉起，窗口 100% 呈现在用户真实桌面上。
2. 基于 PySide6 (QtWebEngine) 创建工作区全屏透明、置顶、无边框原生桌面窗口。
3. 动态点击穿透 (Dynamic WS_EX_TRANSPARENT Click-Through)：
   鼠标位于角色实体/UI面板上时捕获点击与拖拽；位于透明空白处时光标与点击直接穿透到 Windows 桌面及底层应用。
4. 宿主生命周期双向守护 (Mutual Guardianship)：
   - 监听宿主 DSH 进程 PID，宿主一旦退出，常驻窗口立即协同退出。
   - 监听 HTTP 健康心跳，若 DSH 端口连续失联，立即安全退出。
"""

import sys
import os
import json
import time
import argparse
import ctypes
import ctypes.wintypes
from urllib.request import Request, urlopen
from pathlib import Path

# 1. 日志重定向（避免无控制台或编码错误导致崩溃）
try:
    log_dir = Path.home() / ".dsh"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = open(log_dir / "desktop_launcher.log", "w", encoding="utf-8", buffering=1)
    sys.stdout = log_file
    sys.stderr = log_file
except Exception:
    pass

# 2. Win32 API 类型声明（严格 64 位句柄兼容）
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

user32.OpenDesktopW.argtypes = [ctypes.wintypes.LPCWSTR, ctypes.wintypes.DWORD, ctypes.wintypes.BOOL, ctypes.wintypes.DWORD]
user32.OpenDesktopW.restype = ctypes.wintypes.HANDLE
user32.SetThreadDesktop.argtypes = [ctypes.wintypes.HANDLE]
user32.SetThreadDesktop.restype = ctypes.wintypes.BOOL
user32.GetWindowLongW.argtypes = [ctypes.wintypes.HWND, ctypes.c_int]
user32.GetWindowLongW.restype = ctypes.wintypes.LONG
user32.SetWindowLongW.argtypes = [ctypes.wintypes.HWND, ctypes.c_int, ctypes.wintypes.LONG]
user32.SetWindowLongW.restype = ctypes.wintypes.LONG
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.wintypes.SHORT

kernel32.OpenProcess.argtypes = [ctypes.wintypes.DWORD, ctypes.wintypes.BOOL, ctypes.wintypes.DWORD]
kernel32.OpenProcess.restype = ctypes.wintypes.HANDLE
kernel32.GetExitCodeProcess.argtypes = [ctypes.wintypes.HANDLE, ctypes.POINTER(ctypes.wintypes.DWORD)]
kernel32.GetExitCodeProcess.restype = ctypes.wintypes.BOOL
kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
kernel32.CloseHandle.restype = ctypes.wintypes.BOOL

# 3. 在导入 Qt 前设置 Chromium 标志并确保当前线程绑定到真实用户桌面 WinSta0\Default
os.environ["QTWEBENGINE_DISABLE_SANDBOX"] = "1"
os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = "--no-sandbox --disable-gpu-sandbox --disable-web-security --allow-file-access-from-files --autoplay-policy=no-user-gesture-required"

try:
    hdesk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
    if hdesk:
        user32.SetThreadDesktop(hdesk)
except Exception as e:
    print(f"[launcher] SetThreadDesktop warning: {e}")

from PySide6.QtCore import Qt, QTimer, QPoint, QUrl
from PySide6.QtGui import QCursor, QIcon
from PySide6.QtWidgets import QApplication, QSystemTrayIcon, QMenu
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEngineSettings, QWebEngineProfile, QWebEnginePage
from PySide6.QtNetwork import QNetworkCookie

GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
VK_LBUTTON = 0x01
VK_RBUTTON = 0x02


def is_pid_alive(pid: int) -> bool:
    """检查宿主 PID 是否依然存活"""
    if not pid or pid <= 0:
        return False
    SYNCHRONIZE = 0x00100000
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, int(pid))
    if not handle:
        return False
    try:
        exit_code = ctypes.wintypes.DWORD()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return exit_code.value == 259  # STILL_ACTIVE
        return False
    finally:
        kernel32.CloseHandle(handle)


def read_dsh_token_file():
    """读取 ~/.dsh/dsh-live2d-pet-desktop.json 中的端口和令牌"""
    home = Path.home()
    path = home / ".dsh" / "dsh-live2d-pet-desktop.json"
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


class PetWebPage(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, message, lineNumber, sourceID):
        print(f"[JS] {sourceID}:{lineNumber} -> {message}")

    def javaScriptConfirm(self, securityOrigin, msg):
        try:
            from PySide6.QtWidgets import QMessageBox
            mb = QMessageBox(QMessageBox.Icon.Question, "确认操作", msg, QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, self.view())
            mb.setStyleSheet(
                "QMessageBox { background-color: #1e1e24; color: #ffffff; font-family: 'Segoe UI', system-ui; }"
                "QLabel { color: #ffffff; font-size: 13px; font-weight: normal; }"
                "QPushButton { background-color: #3b3b44; color: #ffffff; padding: 6px 16px; border-radius: 4px; font-size: 12px; }"
                "QPushButton:hover { background-color: #4f4f5c; }"
            )
            return mb.exec() == QMessageBox.StandardButton.Yes
        except Exception as e:
            print(f"[launcher] javaScriptConfirm fallback error: {e}")
            return True

    def javaScriptAlert(self, securityOrigin, msg):
        try:
            from PySide6.QtWidgets import QMessageBox
            mb = QMessageBox(QMessageBox.Icon.Information, "系统提示", msg, QMessageBox.StandardButton.Ok, self.view())
            mb.setStyleSheet(
                "QMessageBox { background-color: #1e1e24; color: #ffffff; font-family: 'Segoe UI', system-ui; }"
                "QLabel { color: #ffffff; font-size: 13px; font-weight: normal; }"
                "QPushButton { background-color: #3b3b44; color: #ffffff; padding: 6px 16px; border-radius: 4px; font-size: 12px; }"
                "QPushButton:hover { background-color: #4f4f5c; }"
            )
            mb.exec()
        except Exception as e:
            print(f"[launcher] javaScriptAlert fallback error: {e}")


class DesktopPetWindow(QWebEngineView):
    def __init__(self, port: int, token: str, host_pid: int = 0):
        super().__init__()
        self.port = port
        self.token = token
        self.host_pid = host_pid
        self.is_transparent = False
        self.consecutive_heartbeat_fails = 0
        self.last_cursor_pos = QPoint(-1, -1)
        self.check_in_flight = False

        self.custom_page = PetWebPage(self)
        self.setPage(self.custom_page)

        self._setup_window()
        self._setup_settings()
        self._setup_cookies()
        self._setup_tray()
        self._setup_timers()

        target_url = f"http://127.0.0.1:{self.port}/dsh-pet/standalone?k={self.token}&source=desktop"
        print(f"[launcher] Loading URL: {target_url}, host_pid={self.host_pid}")
        self.load(QUrl(target_url))

    def _setup_window(self):
        # 窗口特性：无边框 + 永远置顶 + 工具窗口 (不在 Alt-Tab 抢焦点) + 透明背景
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setStyleSheet("background: transparent;")
        self.page().setBackgroundColor(Qt.transparent)

        # 使用 availableGeometry（排除任务栏区域），避免触发 Windows 全屏独占优化导致透明失效，同时让桌宠站在任务栏上方
        primary_screen = QApplication.primaryScreen()
        if primary_screen:
            geom = primary_screen.availableGeometry()
            if geom.width() <= 0 or geom.height() <= 0:
                geom = primary_screen.geometry()
            self.setGeometry(geom)
            print(f"[launcher] Window geometry set to: {geom}")
        else:
            self.setGeometry(0, 0, 1920, 1040)

        self.show()
        self.raise_()

        self.hwnd = int(self.winId())
        exstyle = user32.GetWindowLongW(self.hwnd, GWL_EXSTYLE)
        print(f"[launcher] Window HWND={self.hwnd}, initial exstyle={hex(exstyle)}")

    def _setup_settings(self):
        settings = self.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.WebGLEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.Accelerated2dCanvasEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.ShowScrollBars, False)

    def _setup_cookies(self):
        self.profile = QWebEngineProfile.defaultProfile()
        cookie = QNetworkCookie(b"dsh_pet_desk", self.token.encode("utf-8"))
        cookie.setDomain("127.0.0.1")
        cookie.setPath("/")
        cookie.setHttpOnly(False)
        self.profile.cookieStore().setCookie(cookie, QUrl(f"http://127.0.0.1:{self.port}"))

    def _setup_tray(self):
        self.tray = QSystemTrayIcon(self)
        icon_path = Path(__file__).resolve().parent / "windows" / "build" / "icon.png"
        if icon_path.exists():
            self.tray.setIcon(QIcon(str(icon_path)))
        else:
            self.tray.setIcon(self.style().standardIcon(self.style().StandardPixmap.SP_DesktopIcon))

        self.tray_menu = QMenu()
        title_action = self.tray_menu.addAction("🖥️ DS 鲸鱼娘 · 独立桌面常驻")
        title_action.setEnabled(False)
        self.tray_menu.addSeparator()

        reload_action = self.tray_menu.addAction("🔄 重新加载")
        reload_action.triggered.connect(self.reload)

        quit_action = self.tray_menu.addAction("📥 收回至客户端 / 关闭常驻")
        quit_action.triggered.connect(QApplication.instance().quit)

        self.tray.setContextMenu(self.tray_menu)
        self.tray.setToolTip("DS 鲸鱼娘 · 独立桌面常驻 (客户端最小化仍可互动)")
        self.tray.show()

    def _setup_timers(self):
        # 1. 点击穿透判定定时器 (60ms)
        self.hit_timer = QTimer(self)
        self.hit_timer.timeout.connect(self._check_hit_and_passthrough)
        self.hit_timer.start(60)

        # 2. 视线与悬停指针同步定时器 (35ms)
        self.gaze_timer = QTimer(self)
        self.gaze_timer.timeout.connect(self._feed_cursor_pos)
        self.gaze_timer.start(35)

        # 3. 宿主生命周期双向守护定时器 (500ms)
        self.watchdog_timer = QTimer(self)
        self.watchdog_timer.timeout.connect(self._check_host_watchdog)
        self.watchdog_timer.start(500)

    def set_click_through(self, transparent: bool):
        """切换 Windows 点击穿透状态（实时读取最新 winId，防止 Qt 重建底层窗口句柄导致失效）"""
        hwnd = int(self.winId())
        cur = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        has_trans = bool(cur & WS_EX_TRANSPARENT)
        if has_trans == transparent:
            return
        self.is_transparent = transparent
        if transparent:
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, cur | WS_EX_LAYERED | WS_EX_TRANSPARENT)
        else:
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, (cur | WS_EX_LAYERED) & ~WS_EX_TRANSPARENT)

    def _check_hit_and_passthrough(self):
        # 鼠标按键按住期间（拖拽角色或操作控件）严禁切换穿透状态
        l_down = bool(user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
        r_down = bool(user32.GetAsyncKeyState(VK_RBUTTON) & 0x8000)
        if l_down or r_down:
            return

        pt = QCursor.pos()
        pos = self.mapFromGlobal(pt)
        x, y = pos.x(), pos.y()

        if x < 0 or y < 0 or x >= self.width() or y >= self.height():
            self.set_click_through(True)
            return

        if self.check_in_flight:
            return
        self.check_in_flight = True

        hit_js = f"""(function(){{
            try {{
                var el = document.elementFromPoint({x}, {y});
                var ui = !!(el && el.closest && el.closest('.dshp-panel,.dshp-menu,.dshp-hud,.dshp-bubble,.dshp-composer,.dshp-dock,.dshp-tab,.dshp-mail,.dshp-row,.dshp-btn,.dshp-toast,.dshp-subview'));
                if (ui) return 'panel';
                if (window.DSHPet && DSHPet.hitTest && DSHPet.hitTest({x}, {y})) return 'model';
                var dock = document.querySelector('.dshp-dock');
                if (dock) {{
                    var dr = dock.getBoundingClientRect();
                    if (dr.width > 0 && {x} >= dr.left - 8 && {x} <= dr.right + 8 && {y} >= dr.top - 12 && {y} <= dr.bottom + 8) {{
                        return 'panel';
                    }}
                }}
                return 'none';
            }} catch(e) {{
                return 'none';
            }}
        }})()"""

        def on_hit_result(result):
            self.check_in_flight = False
            self.set_click_through(result == "none")

        self.page().runJavaScript(hit_js, on_hit_result)

    def _feed_cursor_pos(self):
        """向页面注入光标位置，保持穿透模式下的眼神跟随与工具栏悬停唤醒"""
        l_down = bool(user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
        if l_down:
            return
        pt = QCursor.pos()
        if pt == self.last_cursor_pos:
            return
        self.last_cursor_pos = pt

        pos = self.mapFromGlobal(pt)
        x, y = pos.x(), pos.y()
        if 0 <= x < self.width() and 0 <= y < self.height():
            js = f"window.DSHPet && DSHPet.feedPointer && DSHPet.feedPointer({x}, {y});"
            self.page().runJavaScript(js)

    def _check_host_watchdog(self):
        """客户端关闭，渲染必须要一同关闭"""
        if self.host_pid and self.host_pid > 0:
            if not is_pid_alive(self.host_pid):
                print(f"[launcher] 宿主进程 (PID: {self.host_pid}) 已关闭，桌面常驻窗口协同退出。")
                QApplication.instance().quit()
                return

        try:
            req = Request(f"http://127.0.0.1:{self.port}/dsh-pet/state", headers={"x-dsh-pet-desk": self.token})
            with urlopen(req, timeout=1.2) as resp:
                if resp.status == 200:
                    self.consecutive_heartbeat_fails = 0
                    return
        except Exception:
            self.consecutive_heartbeat_fails += 1
            if self.consecutive_heartbeat_fails >= 4:
                print(f"[launcher] 宿主 HTTP 服务连续 {self.consecutive_heartbeat_fails} 次失联，桌面常驻窗口协同退出。")
                QApplication.instance().quit()


def main():
    parser = argparse.ArgumentParser(description="DSH Live2D Pet Independent Desktop Launcher")
    parser.add_argument("--port", type=int, default=0, help="DSH Web Server Port")
    parser.add_argument("--token", type=str, default="", help="Desktop Auth Token")
    parser.add_argument("--host-pid", type=int, default=0, help="DSH Host Process PID")
    args = parser.parse_args()

    token_data = read_dsh_token_file()
    port = args.port or token_data.get("port") or 59684
    token = args.token or token_data.get("token") or ""
    host_pid = args.host_pid

    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = "--disable-web-security --allow-file-access-from-files --autoplay-policy=no-user-gesture-required"

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("DSH-Live2D-Pet-Desktop")
    app.setQuitOnLastWindowClosed(True)

    window = DesktopPetWindow(port=port, token=token, host_pid=host_pid)

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
