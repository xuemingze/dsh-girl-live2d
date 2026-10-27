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
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Optional

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
    t = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.I)
    t = re.sub(r"<analysis>[\s\S]*?</analysis>", "", t, flags=re.I)
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/health", "/ping"):
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'{"status": "ok", "service": "dsh-girl-live2d TTS Service"}')
        elif self.path == "/voices_list":
            local_wavs = []
            if os.path.exists(LOCAL_VOICES_POOL_DIR):
                try:
                    for f in os.listdir(LOCAL_VOICES_POOL_DIR):
                        if f.lower().endswith(('.wav', '.mp3', '.ogg', '.flac', '.m4a')):
                            rel_path = os.path.join("voice_engine", "voices_pool", f).replace("\\", "/")
                            local_wavs.append({"file": f, "path": rel_path})
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
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        else:
            self.send_error(404, f"Not Found: {self.path}")

    def do_POST(self):
        if self.path.startswith("/tts"):
            self._handle_tts()
        elif self.path.startswith("/generate_voice"):
            self._handle_generate_voice()
        else:
            self.send_error(404, f"Not Found: {self.path}")

    def _handle_tts(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length)
            payload = json.loads(body_bytes.decode("utf-8"))
        except Exception as e:
            logger.error(f"[TTS Service] 请求解析失败: {e}")
            self.send_error(400, "Bad Request")
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

        try:
            wav_bytes = asyncio.run(_synthesize_edge_tts_to_wav(clean_text, voice, rate=rate, pitch=pitch))
            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)
            logger.info(f"[TTS Service] 合成完毕，返回音频流 ({len(wav_bytes)} 字节)")
        except Exception as e:
            logger.exception(f"[TTS Service] 合成异常: {e}")
            self.send_error(500, f"Synthesis Error: {e}")

    def _handle_generate_voice(self):
        """处理自然语言声音生成请求"""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length)
            payload = json.loads(body_bytes.decode("utf-8"))
        except Exception as e:
            self.send_error(400, "Bad Request")
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
            self.send_error(500, str(e))

    def log_message(self, format, *args):
        logger.debug(format, *args)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    server = ThreadingHTTPServer(("127.0.0.1", 9880), TTSServiceHandler)
    logger.info("[TTS Service] 9880 声带服务已就绪: http://127.0.0.1:9880/tts")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
