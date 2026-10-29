"""
voice_engine/tts_service.py - dsh-girl-live2d 本地极速 9880 TTS 声带服务
支持多伴侣专属音色、提示词自适应声音生成器、本地参考音色池及韵律微调
"""
import io
import os
import json
import logging
import asyncio
import re
import sys
import subprocess
import base64
import ctypes
from ctypes import wintypes
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Optional

from PIL import Image
import soundfile as sf
import edge_tts

logger = logging.getLogger("tts_service")

# 5 大角色对应的高品质默认基座音色字典
CHARACTER_VOICES = {
    "tutu": "zh-CN-XiaoyiNeural",           # 兔兔：活泼甜美少女
    "yuyu": "zh-CN-XiaoniNeural",           # 玉玉：冷艳御姐
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",     # 小小：温柔治愈
    "keke": "zh-CN-XiaoyiNeural",           # 可可：元气女仆
    "whale": "zh-CN-XiaoxiaoNeural",        # 鲸鱼娘：深海女仆
}

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
LOCAL_VOICES_POOL_DIR = os.environ.get("DSH_VOICES_POOL_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices_pool"))
_LATEST_AUDIO_BUFFER: Optional[bytes] = None

# 内存 LRU 音频快速缓存（最高 200 条，针对伴侣高频互动台词实现 0ms 闪电发音）
import threading, time
_AUDIO_CACHE = {}
_AUDIO_CACHE_KEYS = []
_AUDIO_CACHE_LOCK = threading.Lock()
_LAST_TTS_TIME = time.time()

def _get_from_audio_cache(key):
    with _AUDIO_CACHE_LOCK:
        if key in _AUDIO_CACHE:
            try:
                _AUDIO_CACHE_KEYS.remove(key)
                _AUDIO_CACHE_KEYS.append(key)
            except ValueError:
                pass
            return _AUDIO_CACHE[key]
    return None

def _put_into_audio_cache(key, val):
    with _AUDIO_CACHE_LOCK:
        if key in _AUDIO_CACHE:
            _AUDIO_CACHE[key] = val
            return
        if len(_AUDIO_CACHE_KEYS) >= 200:
            oldest = _AUDIO_CACHE_KEYS.pop(0)
            _AUDIO_CACHE.pop(oldest, None)
        _AUDIO_CACHE_KEYS.append(key)
        _AUDIO_CACHE[key] = val

# 预设音色库定义
AVAILABLE_VOICES = [
    {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓 (温柔治愈姐姐)", "gender": "female", "style": "gentle"},
    {"id": "zh-CN-XiaoyiNeural", "name": "晓伊 (甜美活泼少女)", "gender": "female", "style": "sweet"},
    {"id": "zh-CN-XiaoniNeural", "name": "晓妮 (冷艳成熟御姐)", "gender": "female", "style": "cool"},
    {"id": "zh-CN-YunjianNeural", "name": "云健 (清朗沉稳青年)", "gender": "male", "style": "calm"},
    {"id": "zh-CN-YunxiNeural", "name": "云希 (阳光邻家少年)", "gender": "male", "style": "sunny"},
    {"id": "zh-CN-liaoning-XiaobeiNeural", "name": "东北小北 (幽默风趣)", "gender": "female", "style": "humor"},
    {"id": "zh-TW-HsiaoChenNeural", "name": "晓臻 (软萌台湾腔)", "gender": "female", "style": "cute"},
    {"id": "zh-HK-HiuMaanNeural", "name": "晓曼 (粤语甜美)", "gender": "female", "style": "cantonese"},
]



import ctypes
import ctypes.wintypes
import psutil

desktop_pid = None

class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', ctypes.wintypes.DWORD),
        ('lpReserved', ctypes.wintypes.LPWSTR),
        ('lpDesktop', ctypes.wintypes.LPWSTR),
        ('lpTitle', ctypes.wintypes.LPWSTR),
        ('dwX', ctypes.wintypes.DWORD),
        ('dwY', ctypes.wintypes.DWORD),
        ('dwXSize', ctypes.wintypes.DWORD),
        ('dwYSize', ctypes.wintypes.DWORD),
        ('dwXCountChars', ctypes.wintypes.DWORD),
        ('dwYCountChars', ctypes.wintypes.DWORD),
        ('dwFillAttribute', ctypes.wintypes.DWORD),
        ('dwFlags', ctypes.wintypes.DWORD),
        ('wShowWindow', ctypes.wintypes.WORD),
        ('cbReserved2', ctypes.wintypes.WORD),
        ('lpReserved2', ctypes.c_void_p),
        ('hStdInput', ctypes.wintypes.HANDLE),
        ('hStdOutput', ctypes.wintypes.HANDLE),
        ('hStdError', ctypes.wintypes.HANDLE),
    ]

class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', ctypes.wintypes.HANDLE),
        ('hThread', ctypes.wintypes.HANDLE),
        ('dwProcessId', ctypes.wintypes.DWORD),
        ('dwThreadId', ctypes.wintypes.DWORD),
    ]

def _is_desktop_pid_running(pid):
    if not pid:
        return False
    try:
        p = psutil.Process(int(pid))
        return p.is_running() and p.status() != psutil.STATUS_ZOMBIE
    except Exception:
        return False

def get_dsh_host_pid():
    """自动探查 Windows 上运行中的 DSH / nanomuse-desktop 主进程 PID"""
    try:
        for p in psutil.process_iter(['pid', 'name', 'cmdline']):
            name = (p.info.get('name') or '').lower()
            cmd = ' '.join(p.info.get('cmdline') or []).lower()
            if 'nanomuse' in name and any('--expose-internals' in arg for arg in (p.info.get('cmdline') or [])):
                return p.info['pid']
            if 'dsh' in cmd and 'node' in name:
                return p.info['pid']
    except Exception:
        pass
    return 0

def launch_desktop(port=59684, host_pid=0):
    global desktop_pid
    if _is_desktop_pid_running(desktop_pid):
        return {"ok": True, "status": "already_running", "pid": desktop_pid}

    token = ""
    token_file = Path.home() / ".dsh" / "dsh-live2d-pet-desktop.json"
    try:
        if token_file.exists():
            data = json.loads(token_file.read_text(encoding="utf-8"))
            token = data.get("token", "")
            data["port"] = port
            token_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        logger.error(f"Error reading/writing token file: {e}")

    if not host_pid:
        host_pid = get_dsh_host_pid()

    launcher_path = Path(__file__).resolve().parent.parent / "desktop" / "desktop_launcher.py"
    exec_bin = str(Path(sys.executable))

    try:
        if os.name == 'nt':
            si = _STARTUPINFOW()
            si.cb = ctypes.sizeof(_STARTUPINFOW)
            # 强制指定用户真实交互桌面 WinSta0\Default，并使用 CREATE_NO_WINDOW 脱离沙箱控制台
            si.lpDesktop = r"WinSta0\Default".replace("\\\\", "\\")
            pi = _PROCESS_INFORMATION()
            cmd_line = f'"{exec_bin}" "{launcher_path}" --port {port} --token "{token}" --host-pid {host_pid}'
            CREATE_NO_WINDOW = 0x08000000
            ok = ctypes.windll.kernel32.CreateProcessW(
                None,
                ctypes.create_unicode_buffer(cmd_line),
                None,
                None,
                False,
                CREATE_NO_WINDOW,
                None,
                None,
                ctypes.byref(si),
                ctypes.byref(pi),
            )
            if not ok:
                err_code = ctypes.windll.kernel32.GetLastError()
                raise RuntimeError(f"CreateProcessW failed with error {err_code}")
            desktop_pid = int(pi.dwProcessId)
            ctypes.windll.kernel32.CloseHandle(pi.hThread)
            ctypes.windll.kernel32.CloseHandle(pi.hProcess)
        else:
            proc = subprocess.Popen([exec_bin, str(launcher_path), "--port", str(port), "--token", str(token), "--host-pid", str(host_pid)])
            desktop_pid = proc.pid

        logger.info(f"[TTS Service] 已在 WinSta0\\Default 启动独立桌面常驻窗口: PID={desktop_pid}, port={port}, host_pid={host_pid}")
        return {"ok": True, "status": "launched", "pid": desktop_pid}
    except Exception as e:
        logger.error(f"[TTS Service] 启动桌面常驻窗口失败: {e}")
        return {"ok": False, "error": str(e)}

def close_desktop():
    global desktop_pid
    if _is_desktop_pid_running(desktop_pid):
        try:
            p = psutil.Process(int(desktop_pid))
            for ch in p.children(recursive=True):
                try:
                    ch.kill()
                except Exception:
                    pass
            p.kill()
        except Exception:
            pass
        desktop_pid = None
        return {"ok": True, "status": "closed"}
    desktop_pid = None
    return {"ok": True, "status": "not_running"}

def get_desktop_status():
    global desktop_pid
    is_running = _is_desktop_pid_running(desktop_pid)
    if not is_running:
        desktop_pid = None
    return {"ok": True, "running": is_running, "pid": desktop_pid if is_running else None}

def resolve_voice_from_prompt(prompt: str, base_voice: str = DEFAULT_VOICE):
    """
    根据用户填写的自然语言提示词（Prompt），智能解析并匹配最契合的基座音色与韵律参数
    返回 (voice_name, rate_int, pitch_int)
    """
    if not prompt:
        return base_voice, 0, 0

    p = prompt.lower()
    voice = base_voice
    rate_val = 0
    pitch_val = 0

    # 1. 音色匹配 - 优先匹配显著特征
    if any(k in p for k in ["台湾", "软萌", "撒娇", "嗲", "傲娇", "小恶魔", "女友", "小可爱"]):
        voice = "zh-TW-HsiaoChenNeural"
        pitch_val += 3
        rate_val += 4
    elif any(k in p for k in ["粤语", "广东", "香港", "港风", "港女"]):
        voice = "zh-HK-HiuMaanNeural"
        pitch_val += 0
        rate_val += 0
    elif any(k in p for k in ["东北", "幽默", "风趣", "大方", "搞笑", "豪爽", "段子"]):
        voice = "zh-CN-liaoning-XiaobeiNeural"
        pitch_val += 1
        rate_val += 6
    elif any(k in p for k in ["御姐", "冷艳", "清冷", "高冷", "成熟", "霸气", "女王", "女帝", "威严", "毒舌", "强气", "冷漠"]):
        voice = "zh-CN-XiaoniNeural"
        pitch_val -= 2
        rate_val -= 5
    elif any(k in p for k in ["温柔", "治愈", "大姐姐", "舒缓", "轻柔", "贴心", "知心", "暖心", "催眠", "助眠", "母性", "安抚"]):
        voice = "zh-CN-XiaoxiaoNeural"
        pitch_val -= 1
        rate_val -= 4
    elif any(k in p for k in ["知性", "干练", "轻熟", "职业", "学者", "正式", "播音", "清晰", "端庄", "新闻", "严谨", "主播"]):
        voice = "zh-CN-XiaoxiaoNeural"
        pitch_val += 0
        rate_val += 2
    elif any(k in p for k in ["大叔", "低音", "深沉", "厚重", "磁性", "低沉", "霸总", "烟嗓", "成熟男人", "老头", "长辈"]):
        voice = "zh-CN-YunjianNeural"
        pitch_val -= 6
        rate_val -= 8
    elif any(k in p for k in ["沉稳", "公子", "少侠", "清朗", "侠客", "温润", "男神", "师兄"]):
        voice = "zh-CN-YunjianNeural"
        pitch_val += 0
        rate_val += 0
    elif any(k in p for k in ["阳光", "少年", "男孩子", "正太", "弟弟", "邻家", "小帅哥", "学弟", "青春", "小哥", "学长"]):
        voice = "zh-CN-YunxiNeural"
        pitch_val += 2
        rate_val += 8
    elif any(k in p for k in ["播音男", "男主持", "央视", "稳重男"]):
        voice = "zh-CN-YunyangNeural"
        pitch_val -= 1
        rate_val += 2
    elif any(k in p for k in ["甜美", "少女", "元气", "活泼", "开朗", "萝莉", "萌", "可爱", "妹妹", "呆萌", "女仆", "欢快", "活泼可爱", "甜", "灵动", "俏皮"]):
        voice = "zh-CN-XiaoyiNeural"
        pitch_val += 3
        rate_val += 8
    elif "男" in p and "女" not in p:
        voice = "zh-CN-YunxiNeural"
        pitch_val += 1
        rate_val += 2
    elif "女" in p and "男" not in p:
        voice = "zh-CN-XiaoyiNeural"
        pitch_val += 2
        rate_val += 4

    # 2. 语速解析
    if any(k in p for k in ["语速极快", "飞快", "超快", "倍速"]):
        rate_val += 25
    elif any(k in p for k in ["语速稍快", "快一点", "快点", "轻快", "急促", "紧凑", "加速"]):
        rate_val += 12
    elif any(k in p for k in ["稍快", "轻快", "快"]):
        rate_val += 8
    elif any(k in p for k in ["语速极慢", "极度缓慢", "特别慢"]):
        rate_val -= 25
    elif any(k in p for k in ["语速稍慢", "慢一点", "慢点", "慵懒", "缓和", "放慢", "慢速"]):
        rate_val -= 12
    elif any(k in p for k in ["稍慢", "缓慢", "慢"]):
        rate_val -= 8

    # 3. 音调解析
    if any(k in p for k in ["极高", "尖锐", "尖细", "高亢"]):
        pitch_val += 8
    elif any(k in p for k in ["高音", "声调高", "调高", "清亮", "尖"]):
        pitch_val += 4
    elif any(k in p for k in ["极低", "极度低沉", "深喉"]):
        pitch_val -= 8
    elif any(k in p for k in ["低音", "深沉", "厚重", "低沉", "声调低", "调低", "压低", "沉闷"]):
        pitch_val -= 4

    return voice, rate_val, pitch_val


def clean_tts_text(text: str) -> str:
    """彻底过滤思考链、代码语法与特殊控制字符，保留自然口播文本"""
    t = re.sub(r"<\s*(?:think|thought|reasoning|analysis|reflection)(?:\s[^>]*)?>[\s\S]*?(?:<\/\s*(?:think|thought|reasoning|analysis|reflection)\s*>|$)", "", text, flags=re.I)
    t = re.sub(r"<\|(?:thought|think|reasoning|analysis)\|>[\s\S]*?(?:<\|\/(?:thought|think|reasoning|analysis)\|>|$)", "", t, flags=re.I)
    t = re.sub(r":::thinking[\s\S]*?(?::::|$)", "", t, flags=re.I)
    t = re.sub(r"```(?:thought|thinking)[\s\S]*?(?:```|$)", "", t, flags=re.I)
    t = re.sub(r"\[/?(?:THINK|THOUGHT|REASONING)\][\s\S]*?(?:\[/(?:THINK|THOUGHT|REASONING)\]|$)", "", t, flags=re.I)
    t = re.sub(r"^(?:thought process|thinking process|思考过程|思考路径)\s*[:：][\s\S]*?(?:\n\n|$)", "", t, flags=re.I)
    t = re.sub(r"```[\s\S]*?```", "", t, flags=re.I)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[#*>\-_~|\\/]", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


async def _synthesize_edge_tts_to_wav(
    text: str,
    voice: str = DEFAULT_VOICE,
    rate: str = "+0%",
    pitch: str = "+0Hz"
) -> bytes:
    """使用 edge-tts 合成并在内存中转换为标准 WAV 字节流"""
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    mp3_bytes = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            mp3_bytes.extend(chunk["data"])

    data, sr = sf.read(io.BytesIO(mp3_bytes))
    wav_io = io.BytesIO()
    sf.write(wav_io, data, sr, format="WAV")
    return wav_io.getvalue()


# ============================================================================
# 场景感知总线与视觉感官辅助 (Perception & Screen Sensor Helpers)
# ============================================================================
user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

CUSTOM_GAMES = {} # lowercase exe -> displayName

KNOWN_GAMES_DICT = {
    "genshinimpact.exe": "原神",
    "yuanshen.exe": "原神",
    "starrail.exe": "崩坏：星穹铁道",
    "zenlesszonezero.exe": "绝区零",
    "b1.exe": "黑神话：悟空",
    "b1-win64-shipping.exe": "黑神话：悟空",
    "cs2.exe": "反恐精英 2 (CS2)",
    "valorant.exe": "无畏契约 (VALORANT)",
    "leagueclientux.exe": "英雄联盟",
    "league of legends.exe": "英雄联盟",
    "dota2.exe": "Dota 2",
    "minecraft.windows.exe": "我的世界",
    "javaw.exe": "Minecraft / Java",
    "steam.exe": "Steam",
}

def scan_game_processes():
    try:
        cmd = ["tasklist", "/fo", "csv", "/nh"]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        found_steam = False
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = [p.strip(' "') for p in line.split('","')]
            if parts:
                pname = parts[0].lower()
                # 优先匹配用户自定义新增的游戏进程
                if pname in CUSTOM_GAMES:
                    return True, CUSTOM_GAMES[pname]
                # 匹配内置已知游戏字典
                if pname in KNOWN_GAMES_DICT:
                    if pname == "steam.exe":
                        found_steam = True
                    else:
                        return True, KNOWN_GAMES_DICT[pname]
        if found_steam:
            return True, "Steam"
        return False, None
    except Exception as e:
        logger.warning(f"Error scanning game processes: {e}")
        return False, None

def capture_screen_native(crop_foreground=True):
    """
    Windows 原生 Win32 GDI 极速前台画面捕获 (约 50-80ms，彻底根治 PowerShell/Session 隔离导致的黑屏)
    """
    try:
        # 1. 切换至当前交互式用户桌面 WinSta0\Default
        hDesk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
        if hDesk:
            user32.SetThreadDesktop(hDesk)

        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)
        if screen_w <= 0 or screen_h <= 0:
            screen_w, screen_h = 1920, 1080

        # 2. 探测前台活动窗口尺寸
        crop_rect = None
        if crop_foreground:
            hwnd = user32.GetForegroundWindow()
            if hwnd:
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                cw = rect.right - rect.left
                ch = rect.bottom - rect.top
                # 过滤微小窗口或底部任务栏
                if cw >= 240 and ch >= 180 and not (cw == screen_w and ch <= 60):
                    x = max(0, rect.left)
                    y = max(0, rect.top)
                    cw = min(screen_w - x, cw)
                    ch = min(screen_h - y, ch)
                    if cw > 0 and ch > 0:
                        crop_rect = (x, y, cw, ch)

        # 3. GDI BitBlt 内存捕获
        hDC = user32.GetDC(0)
        memDC = gdi32.CreateCompatibleDC(hDC)
        hBmp = gdi32.CreateCompatibleBitmap(hDC, screen_w, screen_h)
        oldBmp = gdi32.SelectObject(memDC, hBmp)
        gdi32.BitBlt(memDC, 0, 0, screen_w, screen_h, hDC, 0, 0, 0x00CC0020) # SRCCOPY

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", wintypes.DWORD),
                ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD),
                ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG),
                ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD),
            ]

        bmi = BITMAPINFOHEADER()
        bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.biWidth = screen_w
        bmi.biHeight = -screen_h # top-down
        bmi.biPlanes = 1
        bmi.biBitCount = 24
        bmi.biCompression = 0

        buf = (ctypes.c_char * (screen_w * screen_h * 3))()
        gdi32.GetDIBits(memDC, hBmp, 0, screen_h, buf, ctypes.byref(bmi), 0)

        gdi32.SelectObject(memDC, oldBmp)
        gdi32.DeleteObject(hBmp)
        gdi32.DeleteDC(memDC)
        user32.ReleaseDC(0, hDC)

        img = Image.frombytes("RGB", (screen_w, screen_h), bytes(buf), "raw", "BGR")
        if crop_rect:
            x, y, cw, ch = crop_rect
            img = img.crop((x, y, x + cw, y + ch))

        out_io = io.BytesIO()
        img.save(out_io, format="JPEG", quality=80)
        b64 = base64.b64encode(out_io.getvalue()).decode("ascii")
        return b64, img.size[0], img.size[1], img
    except Exception as e:
        logger.error(f"[ScreenCapture] 原生 GDI 截屏异常: {e}")
        raise RuntimeError(f"GDI capture failed: {e}")


# ============================================================================
# 桌面灵视觉采集与交互机制 (Screen Vision Monitor Engine)
# ============================================================================
CHANGED_CELL_THRESHOLD = 0.12 # 桌面灵单一网格变动门槛
CANDIDATE_THRESHOLD = 0.075   # 桌面灵候选变动门槛 (7.5% 面积变动)
STABLE_WAIT_SECONDS = 1.2     # 稳定防抖时长

VISION_CONFIG = {
    "enabled": False,
    "mode": "companion", # "companion" (温情伴聊) | "quiet" (极简静默)
}
_LAST_SCREEN_SIGNATURE = None
_LAST_CANDIDATE_TIME = 0
_LAST_OBSERVED_RATIO = 0.0
_LAST_AUTO_REPLY_TIME = 0
_LATEST_VISION_EVENT = None
_VISION_LOCK = threading.Lock()

def calculate_signature_diff(left_bytes, right_bytes):
    if not left_bytes or not right_bytes or len(left_bytes) != 1728 or len(right_bytes) != 1728:
        return 1.0
    cell_count = 32 * 18
    total_diff = 0.0
    changed_cells = 0
    for i in range(0, 1728, 3):
        cd = (abs(left_bytes[i] - right_bytes[i]) +
              abs(left_bytes[i+1] - right_bytes[i+1]) +
              abs(left_bytes[i+2] - right_bytes[i+2])) / (3.0 * 255.0)
        total_diff += cd
        if cd >= CHANGED_CELL_THRESHOLD:
            changed_cells += 1
    return max(total_diff / cell_count, changed_cells / cell_count)

def _screen_vision_monitor_loop():
    global _LAST_SCREEN_SIGNATURE, _LAST_CANDIDATE_TIME, _LAST_OBSERVED_RATIO, _LAST_AUTO_REPLY_TIME, _LATEST_VISION_EVENT
    while True:
        try:
            time.sleep(3.0)
            if not VISION_CONFIG.get("enabled"):
                continue

            # 若正处于游戏或全屏独占，暂停视觉主动打扰
            in_game, _ = scan_game_processes()
            if in_game:
                continue

            b64, w, h, img = capture_screen_native(crop_foreground=False)
            thumb = img.resize((32, 18), Image.Resampling.BOX)
            current_sig = thumb.tobytes()

            if _LAST_SCREEN_SIGNATURE is None:
                _LAST_SCREEN_SIGNATURE = current_sig
                continue

            diff = calculate_signature_diff(_LAST_SCREEN_SIGNATURE, current_sig)
            _LAST_OBSERVED_RATIO = diff

            now = time.time()
            cooldown = 25.0 if VISION_CONFIG.get("mode") == "companion" else 60.0

            if diff >= CANDIDATE_THRESHOLD:
                if _LAST_CANDIDATE_TIME == 0:
                    _LAST_CANDIDATE_TIME = now
                elif (now - _LAST_CANDIDATE_TIME) >= STABLE_WAIT_SECONDS:
                    # 稳定且超过冷却期，产生一次视觉关怀事件
                    if (now - _LAST_AUTO_REPLY_TIME) >= cooldown:
                        _LAST_AUTO_REPLY_TIME = now
                        _LAST_SCREEN_SIGNATURE = current_sig
                        _LAST_CANDIDATE_TIME = 0
                        with _VISION_LOCK:
                            _LATEST_VISION_EVENT = {
                                "id": f"vis-{int(now * 1000)}",
                                "timestamp": int(now * 1000),
                                "diffRatio": round(diff, 3),
                                "text": "主人切到新的页面啦~ 需要我一起看看吗？",
                                "shot": {
                                    "source": "builtin",
                                    "mime": "image/jpeg",
                                    "width": w,
                                    "height": h,
                                    "base64": b64,
                                    "capturedAt": int(now * 1000)
                                }
                            }
                            logger.info(f"[ScreenVision] 产生新的视觉交互事件: diff={diff:.3f}")
            else:
                _LAST_CANDIDATE_TIME = 0
        except Exception:
            pass

# 启动后台视觉神经监测线程
_vision_worker_thread = threading.Thread(target=_screen_vision_monitor_loop, daemon=True)
_vision_worker_thread.start()


class TTSServiceHandler(BaseHTTPRequestHandler):
    def _send_cors(self):
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-dsh-pet-desk, Authorization, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type")
        if origin != "*":
            self.send_header("Access-Control-Allow-Credentials", "true")

    def _send_json(self, code: int, obj: dict):
        try:
            self.send_response(code)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            logger.warning(f"Error sending json response: {e}")

    def _send_error_json(self, code: int, message: str):
        try:
            self.send_response(code)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            body = json.dumps({"ok": False, "error": str(message)}, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            logger.warning(f"Error sending error response: {e}")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        clean_path = self.path.split("?")[0].rstrip("/") or "/"
        if clean_path in ("/", "/health", "/ping"):
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'{"status": "ok", "service": "dsh-girl-live2d TTS Service"}')
        elif clean_path in ("/desktop/status", "/dsh-pet/desktop/status"):
            self._send_json(200, get_desktop_status())
        elif clean_path in ("/shutdown", "/tts/stop", "/dsh-pet/tts/stop"):
            self._handle_shutdown()
        elif self.path.startswith(("/voices_pool/", "/dsh-pet/voices_pool/")):
            rel_part = self.path.split("/voices_pool/", 1)[-1].split("?")[0]
            from urllib.parse import unquote
            decoded_file = os.path.basename(unquote(rel_part))
            target_p = os.path.join(LOCAL_VOICES_POOL_DIR, decoded_file)
            if os.path.exists(target_p) and os.path.isfile(target_p):
                try:
                    with open(target_p, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self._send_cors()
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                    return
                except Exception as e:
                    self._send_error_json(500, str(e))
                    return
            self._send_error_json(404, f"File Not Found: {decoded_file}")
            return
        elif clean_path in ("/voices_list", "/voices", "/dsh-pet/voices"):
            local_wavs = []
            if os.path.exists(LOCAL_VOICES_POOL_DIR):
                try:
                    for f in sorted(os.listdir(LOCAL_VOICES_POOL_DIR)):
                        if f.lower().endswith(('.wav', '.mp3', '.ogg', '.flac', '.m4a')):
                            full_f = os.path.join(LOCAL_VOICES_POOL_DIR, f)
                            local_wavs.append({
                                "file": f,
                                "name": os.path.splitext(f)[0],
                                "path": f"/dsh-pet/voices_pool/{f}",
                                "size": os.path.getsize(full_f) if os.path.isfile(full_f) else 0
                            })
                except Exception as e:
                    logger.warning(f"读取本地音色池失败: {e}")
            data = {
                "ok": True,
                "systemVoices": AVAILABLE_VOICES,
                "localPool": local_wavs
            }
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif clean_path in ("/init-default-samples", "/init_default_samples", "/dsh-pet/init-default-samples"):
            self._handle_init_default_samples()
            return
        elif self.path.startswith(("/save_to_pool", "/save-to-pool", "/dsh-pet/save-to-pool")):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            name = qs.get("name", [""])[0]
            audio_base64 = qs.get("audioBase64", [""])[0]
            self._save_to_pool_bytes(name=name, audio_base64=audio_base64)
            return
        elif clean_path in ("/perception/status", "/dsh-pet/perception/status"):
            self._handle_perception_status()
            return
        elif clean_path in ("/perception/capture", "/dsh-pet/perception/capture"):
            self._handle_perception_capture()
            return
        elif clean_path in ("/perception/test-inquiry", "/dsh-pet/perception/test-inquiry"):
            self._handle_perception_test_inquiry()
            return
        elif clean_path in ("/perception/game-list", "/dsh-pet/perception/game-list"):
            self._handle_perception_game_list()
            return
        elif clean_path in ("/perception/vision-status", "/dsh-pet/perception/vision-status"):
            self._handle_perception_status()
            return
        else:
            self._send_error_json(404, f"Not Found: {self.path}")

    def do_POST(self):
        clean_path = self.path.split("?")[0].rstrip("/") or "/"
        if clean_path in ("/desktop/launch", "/dsh-pet/desktop/launch"):
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"
                payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            except Exception:
                payload = {}
            port = payload.get("port") or 59684
            host_pid = payload.get("hostPid") or 0
            res = launch_desktop(port=int(port), host_pid=int(host_pid))
            self._send_json(200, res)
        elif clean_path in ("/desktop/close", "/dsh-pet/desktop/close"):
            res = close_desktop()
            self._send_json(200, res)
        elif clean_path in ("/shutdown", "/tts/stop", "/dsh-pet/tts/stop"):
            self._handle_shutdown()
        elif self.path.startswith("/tts"):
            self._handle_tts()
        elif self.path.startswith(("/generate_voice", "/generate-voice", "/dsh-pet/generate-voice")):
            self._handle_generate_voice()
        elif clean_path in ("/init-default-samples", "/init_default_samples", "/dsh-pet/init-default-samples"):
            self._handle_init_default_samples()
        elif self.path.startswith(("/save_to_pool", "/save-to-pool", "/dsh-pet/save-to-pool")):
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body_bytes = self.rfile.read(content_length)
                payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            except Exception:
                payload = {}
            self._save_to_pool_bytes(name=payload.get("name", ""), audio_base64=payload.get("audioBase64", ""))
        elif self.path.startswith(("/delete-pool-voice", "/delete_voice", "/dsh-pet/delete-pool-voice")):
            self._handle_delete_voice()
        elif clean_path in ("/perception/status", "/dsh-pet/perception/status"):
            self._handle_perception_status()
            return
        elif clean_path in ("/perception/capture", "/dsh-pet/perception/capture"):
            self._handle_perception_capture()
            return
        elif clean_path in ("/perception/test-inquiry", "/dsh-pet/perception/test-inquiry"):
            self._handle_perception_test_inquiry()
            return
        elif clean_path in ("/perception/game-list", "/dsh-pet/perception/game-list"):
            self._handle_perception_game_list()
            return
        elif clean_path in ("/perception/vision-config", "/dsh-pet/perception/vision-config"):
            self._handle_perception_vision_config()
            return
        elif clean_path in (
            "/perception/web-event", "/dsh-pet/perception/web-event",
            "/perception/game-event", "/dsh-pet/perception/game-event",
            "/perception/media-event", "/dsh-pet/perception/media-event",
            "/perception/window-event", "/dsh-pet/perception/window-event"
        ):
            self._send_json(200, {"ok": True})
            return
        else:
            self._send_error_json(404, f"Not Found: {self.path}")

    def _handle_perception_game_list(self):
        if self.command == "POST":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"
                payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            except Exception:
                payload = {}
            cg = payload.get("customGames", [])
            CUSTOM_GAMES.clear()
            for item in cg:
                if isinstance(item, dict) and item.get("exe"):
                    k = str(item.get("exe")).lower().strip()
                    n = str(item.get("name") or item.get("exe")).strip()
                    if k:
                        CUSTOM_GAMES[k] = n
                elif isinstance(item, str) and item.strip():
                    k = item.lower().strip()
                    CUSTOM_GAMES[k] = item.strip()
        self._send_json(200, {
            "ok": True,
            "customGames": [{"exe": k, "name": v} for k, v in CUSTOM_GAMES.items()]
        })

    def _handle_perception_vision_config(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception:
            payload = {}
        if "enabled" in payload:
            VISION_CONFIG["enabled"] = bool(payload["enabled"])
        if "mode" in payload:
            VISION_CONFIG["mode"] = str(payload["mode"])
        logger.info(f"[ScreenVision] 更新配置: {VISION_CONFIG}")
        self._send_json(200, {"ok": True, "visionConfig": VISION_CONFIG})

    def _handle_perception_status(self):
        in_game, current_game = scan_game_processes()
        with _VISION_LOCK:
            last_event = _LATEST_VISION_EVENT
        data = {
            "ok": True,
            "perception": {
                "inGame": in_game,
                "currentGame": current_game,
                "customGames": [{"exe": k, "name": v} for k, v in CUSTOM_GAMES.items()],
                "media": None,
                "foregroundWindow": None,
            },
            "screenSensor": {
                "enabled": VISION_CONFIG.get("enabled", False),
                "visionMode": VISION_CONFIG.get("mode", "companion"),
                "mode": "builtin_standalone",
                "appshotInstalled": False,
                "isDynamicStream": False,
                "lastObservedDiff": round(_LAST_OBSERVED_RATIO, 3),
                "lastEvent": last_event,
            }
        }
        self._send_json(200, data)

    def _handle_perception_capture(self):
        try:
            b64, w, h, _ = capture_screen_native(crop_foreground=True)
            res = {
                "ok": True,
                "shot": {
                    "source": "builtin",
                    "mime": "image/jpeg",
                    "width": w,
                    "height": h,
                    "base64": b64,
                    "capturedAt": int(time.time() * 1000)
                }
            }
            self._send_json(200, res)
        except Exception as e:
            logger.error(f"[Perception] Screen capture error: {e}")
            self._send_error_json(500, f"屏幕捕获异常: {e}")

    def _handle_perception_test_inquiry(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception:
            payload = {}
        cat = payload.get("category", "travel")
        questions = {
            "travel": "主人是在看去哪里的行程机票呀？需要我帮忙留心天气吗？",
            "rental": "主人是在看新房源或者租房信息吗？要注意周边通勤和安全呀~",
            "shopping": "主人是在挑选什么心仪的好物吗？要不要我帮你对比看看？",
        }
        q = questions.get(cat, questions["travel"])
        res = {
            "ok": True,
            "result": {
                "ok": True,
                "category": cat,
                "questionText": q,
                "triggeredAt": int(time.time() * 1000)
            }
        }
        self._send_json(200, res)

    def _handle_init_default_samples(self):
        default_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "default_samples")
        count = 0
        try:
            os.makedirs(LOCAL_VOICES_POOL_DIR, exist_ok=True)
            if os.path.exists(default_dir):
                import shutil
                for f in os.listdir(default_dir):
                    if f.lower().endswith(".wav"):
                        src_p = os.path.join(default_dir, f)
                        dst_p = os.path.join(LOCAL_VOICES_POOL_DIR, f)
                        if not os.path.exists(dst_p):
                            shutil.copy2(src_p, dst_p)
                            count += 1
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            body = json.dumps({"ok": True, "restoredCount": count}, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            logger.error(f"[TTS Service] 恢复默认示例音色失败: {e}")
            self._send_error_json(500, str(e))

    def _handle_delete_voice(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length)
            payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            raw_file = payload.get("file", "")
            from urllib.parse import unquote
            safe_file = os.path.basename(unquote(raw_file))
            if not safe_file or safe_file in (".", ".."):
                self._send_error_json(400, "无效的文件名")
                return
            target_p = os.path.join(LOCAL_VOICES_POOL_DIR, safe_file)
            if os.path.exists(target_p) and os.path.isfile(target_p):
                os.remove(target_p)
                logger.info(f"[TTS Service] 已成功删除音色池文件: {safe_file}")
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                res = json.dumps({"ok": True, "deleted": safe_file}, ensure_ascii=False).encode("utf-8")
                self.send_header("Content-Length", str(len(res)))
                self.end_headers()
                self.wfile.write(res)
            else:
                self._send_error_json(404, f"文件不存在: {safe_file}")
        except Exception as e:
            logger.error(f"[TTS Service] 删除文件异常: {e}")
            self._send_error_json(500, str(e))

    def _save_to_pool_bytes(self, name: str = "", audio_base64: str = ""):
        global _LATEST_AUDIO_BUFFER
        import base64
        buf_to_save = None
        if audio_base64:
            try:
                buf_to_save = base64.b64decode(audio_base64)
            except Exception as e:
                logger.warning(f"解码 base64 音频失败: {e}")
        elif _LATEST_AUDIO_BUFFER:
            buf_to_save = _LATEST_AUDIO_BUFFER

        if not buf_to_save:
            self.send_response(400)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": "没有可供保存的音频数据，请先生成声音"}).encode("utf-8"))
            return

        raw_name = (name or f"sample_{int(asyncio.get_event_loop_policy().get_event_loop().time())}").strip()
        safe_name = re.sub(r'[^a-zA-Z0-9_\u4e00-\u9fa5-]', '_', raw_name)
        if not safe_name.lower().endswith(".wav"):
            safe_name += ".wav"
        target_p = os.path.join(LOCAL_VOICES_POOL_DIR, safe_name)
        try:
            with open(target_p, "wb") as f:
                f.write(buf_to_save)
            res_data = {
                "ok": True,
                "file": safe_name,
                "path": f"/voices_pool/{safe_name}"
            }
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(res_data, ensure_ascii=False).encode("utf-8"))
        except Exception as e:
            self.send_response(500)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))

    def _handle_tts(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length)
            payload = json.loads(body_bytes.decode("utf-8"))
        except Exception as e:
            logger.error(f"[TTS Service] 请求解析失败: {e}")
            self._send_error_json(400, "Bad Request")
            return

        raw_text = payload.get("text", "").strip()
        char_id = payload.get("characterId", "tutu")
        prompt = payload.get("prompt", "").strip()
        req_voice = payload.get("voice") or payload.get("voice_name")

        base_voice = req_voice or CHARACTER_VOICES.get(char_id, DEFAULT_VOICE)

        # 优先支持基于提示词自适应解析
        if prompt and not req_voice:
            voice, base_rate, base_pitch = resolve_voice_from_prompt(prompt, base_voice)
        else:
            voice = base_voice
            base_rate = 0
            base_pitch = 0

        rate = None
        pitch = None
        if payload.get("rate") is not None:
            r = payload.get("rate")
            if isinstance(r, (int, float)):
                rate = f"{int(r):+d}%"
            elif isinstance(r, str) and r.strip():
                rate = r.strip() if ("%" in r or "+" in r or "-" in r) else f"+{r.strip()}%"
        if payload.get("pitch") is not None:
            p = payload.get("pitch")
            if isinstance(p, (int, float)):
                pitch = f"{int(p):+d}Hz"
            elif isinstance(p, str) and p.strip():
                pitch = p.strip() if ("Hz" in p or "+" in p or "-" in p) else f"+{p.strip()}Hz"

        if rate is None:
            rate = f"{base_rate:+d}%"
        if pitch is None:
            pitch = f"{base_pitch:+d}Hz"

        clean_text = clean_tts_text(raw_text)
        if not clean_text:
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        global _LAST_TTS_TIME
        _LAST_TTS_TIME = time.time()

        # 优先读取快速内存音频缓存
        cache_key = (clean_text, voice, rate, pitch)
        cached_wav = _get_from_audio_cache(cache_key)
        if cached_wav:
            logger.info(f"[TTS Service] 极速命中音频缓存: '{clean_text[:35]}...' ({len(cached_wav)} 字节, 0ms)")
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(cached_wav)))
            self.end_headers()
            self.wfile.write(cached_wav)
            return

        logger.info(f"[TTS Service] [{char_id}] 正在合成: '{clean_text[:35]}...' (音色: {voice}, 语速: {rate}, 音调: {pitch})")

        try:
            wav_bytes = asyncio.run(_synthesize_edge_tts_to_wav(clean_text, voice, rate=rate, pitch=pitch))
            _put_into_audio_cache(cache_key, wav_bytes)
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)
            logger.info(f"[TTS Service] 合成完毕，返回音频流 ({len(wav_bytes)} 字节)")
        except Exception as e:
            logger.exception(f"[TTS Service] 合成异常: {e}")
            self._send_error_json(500, f"Synthesis Error: {e}")

    def _handle_generate_voice(self):
        """处理自然语言声音生成请求"""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length)
            payload = json.loads(body_bytes.decode("utf-8"))
        except Exception as e:
            self._send_error_json(400, "Bad Request")
            return

        prompt = payload.get("prompt", "").strip()
        test_text = payload.get("text", "").strip() or "你好呀，这是为你生成的专属声音，感觉怎么样呢？"
        char_id = payload.get("characterId", "tutu")
        base_voice = payload.get("baseVoice") or payload.get("voice") or payload.get("voice_name") or CHARACTER_VOICES.get(char_id, DEFAULT_VOICE)

        # 自然语言提示词解析基座音色与基准声学校准
        target_voice, base_rate, base_pitch = resolve_voice_from_prompt(prompt, base_voice)

        # 叠加前端用户手动微调滑块数值
        try:
            r_offset = int(payload.get("rate", 0)) if payload.get("rate") is not None else 0
        except (ValueError, TypeError):
            r_offset = 0
        try:
            p_offset = int(payload.get("pitch", 0)) if payload.get("pitch") is not None else 0
        except (ValueError, TypeError):
            p_offset = 0

        final_rate_val = base_rate + r_offset
        final_pitch_val = base_pitch + p_offset
        rate = f"{final_rate_val:+d}%"
        pitch = f"{final_pitch_val:+d}Hz"

        clean_text = clean_tts_text(test_text)
        logger.info(f"[Voice Gen] 提示词: '{prompt}' -> 解析为: {target_voice}, rate: {rate}, pitch: {pitch}")

        try:
            wav_bytes = asyncio.run(_synthesize_edge_tts_to_wav(clean_text, target_voice, rate=rate, pitch=pitch))
            global _LATEST_AUDIO_BUFFER
            _LATEST_AUDIO_BUFFER = wav_bytes
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.send_header("X-Resolved-Voice", target_voice)
            self.send_header("X-Resolved-Rate", rate)
            self.send_header("X-Resolved-Pitch", pitch)
            self.end_headers()
            self.wfile.write(wav_bytes)
        except Exception as e:
            logger.exception(f"[Voice Gen] 合成失败: {e}")
            self._send_error_json(500, str(e))

    def log_message(self, format, *args):
        logger.debug(format, *args)

    def _handle_shutdown(self):
        """优雅关闭 TTS 后端服务"""
        try:
            close_desktop()
        except Exception:
            pass
        self._send_json(200, {"ok": True, "status": "shutting_down"})
        import threading
        def _stop():
            import time
            time.sleep(0.15)
            try:
                self.server.shutdown()
            except Exception:
                pass
            os._exit(0)
        threading.Thread(target=_stop, daemon=True).start()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    import argparse, shutil, threading, time
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9880)
    parser.add_argument("--host-pid", type=int, default=0)
    args, _ = parser.parse_known_args()

    try:
        os.makedirs(LOCAL_VOICES_POOL_DIR, exist_ok=True)
        default_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "default_samples")
        if os.path.exists(default_dir):
            for f in os.listdir(default_dir):
                if f.lower().endswith(".wav"):
                    src_p = os.path.join(default_dir, f)
                    dst_p = os.path.join(LOCAL_VOICES_POOL_DIR, f)
                    if not os.path.exists(dst_p):
                        shutil.copy2(src_p, dst_p)
    except Exception as e:
        logger.warning(f"[TTS Service] 初始化默认音色样本异常: {e}")

    if args.host_pid and args.host_pid > 0:
        def _watch_host():
            while True:
                time.sleep(3.0)
                if not _is_desktop_pid_running(args.host_pid):
                    logger.info(f"[TTS Service] 检测到宿主进程 (PID={args.host_pid}) 已退出，自动关闭 TTS 后端服务")
                    try:
                        close_desktop()
                    except Exception:
                        pass
                    os._exit(0)
        threading.Thread(target=_watch_host, daemon=True).start()

    # 启动后台温床守护协程（每 45 秒在静默期发起微小预热，杜绝静默一段时间后的 Edge TTS 12秒握手延迟）
    def _keep_warm_worker():
        global _LAST_TTS_TIME
        # 启动即刻预热一次
        try:
            time.sleep(1.0)
            asyncio.run(_synthesize_edge_tts_to_wav("。", DEFAULT_VOICE, "+0%", "+0Hz"))
            logger.info("[TTS Service] 初始预热完成，声带网络链路已激活")
        except Exception as e:
            logger.debug(f"[TTS Service] 初始预热微小波动: {e}")

        while True:
            try:
                time.sleep(45.0)
                if time.time() - _LAST_TTS_TIME >= 40.0:
                    logger.debug("[TTS Service] 执行守护温床预热，保持 TLS 与 WebSocket 长链路畅通...")
                    asyncio.run(_synthesize_edge_tts_to_wav("。", DEFAULT_VOICE, "+0%", "+0Hz"))
                    _LAST_TTS_TIME = time.time()
            except Exception as e:
                logger.debug(f"[TTS Service] 守护温床预热微小波动: {e}")

    threading.Thread(target=_keep_warm_worker, daemon=True).start()

    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("127.0.0.1", args.port), TTSServiceHandler)
    logger.info("[TTS Service] 9880 声带服务已就绪: http://127.0.0.1:9880/tts")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
