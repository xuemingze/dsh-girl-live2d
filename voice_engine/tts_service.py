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
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Optional, Any

import soundfile as sf
import edge_tts

logger = logging.getLogger("tts_service")

def check_python_dependencies():
    missing = []
    for mod, pkg in [
        ('edge_tts', 'edge-tts>=7.0.0'),
        ('soundfile', 'soundfile>=0.12.0'),
        ('psutil', 'psutil>=5.9.0'),
        ('comtypes', 'comtypes>=1.4.0'),
        ('pycaw', 'pycaw>=20240210'),
    ]:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if missing:
        logger.warning(
            f'[Dependency Warning] 检测到缺少关键依赖: {", ".join(missing)}。\n'
            f'请在桌宠目录下运行: pip install -r requirements.txt 安装完整依赖环境。'
        )
    return len(missing) == 0



# 引入 T0 系统音频感知引擎
try:
    from voice_engine.audio_perception import AudioPerceptionEngine
except ImportError:
    try:
        from audio_perception import AudioPerceptionEngine
    except ImportError:
        AudioPerceptionEngine = None

PERCEPTION_ENGINE: Optional[Any] = None

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
        elif clean_path in ("/perception/status", "/dsh-pet/perception/status"):
            if PERCEPTION_ENGINE:
                self._send_json(200, PERCEPTION_ENGINE.get_status())
            else:
                self._send_json(200, {"enabled": False, "running": False, "error": "Not initialized"})
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
        elif clean_path in ("/perception/toggle", "/dsh-pet/perception/toggle"):
            if PERCEPTION_ENGINE:
                PERCEPTION_ENGINE.enabled = not PERCEPTION_ENGINE.enabled
                self._send_json(200, {"ok": True, "enabled": PERCEPTION_ENGINE.enabled})
            else:
                self._send_error_json(500, "Perception engine not available")
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
        else:
            self._send_error_json(404, f"Not Found: {self.path}")

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

        logger.info(f"[TTS Service] [{char_id}] 正在合成: '{clean_text[:35]}...' (音色: {voice}, 语速: {rate}, 音调: {pitch})")

        if PERCEPTION_ENGINE:
            PERCEPTION_ENGINE.set_tts_playing(True)

        try:
            wav_bytes = asyncio.run(_synthesize_edge_tts_to_wav(clean_text, voice, rate=rate, pitch=pitch))
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)
            logger.info(f"[TTS Service] 合成完毕，返回音频流 ({len(wav_bytes)} 字节)")
            if PERCEPTION_ENGINE:
                duration_sec = max(2.0, len(wav_bytes) / 48000.0)
                threading.Timer(duration_sec + 0.5, lambda: PERCEPTION_ENGINE.set_tts_playing(False)).start()
        except Exception as e:
            if PERCEPTION_ENGINE:
                PERCEPTION_ENGINE.set_tts_playing(False)
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
        global PERCEPTION_ENGINE
        if PERCEPTION_ENGINE:
            try:
                PERCEPTION_ENGINE.stop()
            except Exception:
                pass
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

    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("127.0.0.1", args.port), TTSServiceHandler)
    logger.info("[TTS Service] 9880 声带服务已就绪: http://127.0.0.1:9880/tts")

    if AudioPerceptionEngine:
        try:
            check_python_dependencies()
            PERCEPTION_ENGINE = AudioPerceptionEngine(host_pid=args.host_pid)
            PERCEPTION_ENGINE.start()
            logger.info("[Perception Engine] 系统音频感知引擎自动拉起就绪")
        except Exception as e:
            logger.warning(f"[Perception Engine] 启动音频感知引擎异常: {e}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        if PERCEPTION_ENGINE:
            PERCEPTION_ENGINE.stop()
        server.server_close()
