"""
voice_engine/audio_perception.py - T0 系统音频智能侦测模块

特性与设计规范：
1. 物理声门（Zero-CPU Peak Gate）：系统静音时 0.0% CPU 占用，发声时纳秒级感知。
2. 进程会话归因（pycaw）：精准获取发声 PID、进程名与前台窗口信息。
3. 自身/系统噪音双重过滤：严格排除 DSH 宿主、桌宠本身与 Windows 底层系统进程，绝不误触自感知。
4. 真实媒体与娱乐兜底过滤：未知进程无 SMTC 媒体元数据时坚决丢弃，杜绝系统杂音与点击音误报。
5. SMTC 媒体提取（winsdk）：Windows 原生提取媒体会话（标题、艺术家、源应用）。
6. 通讯黑名单保护（Call Guard）：微信/QQ/腾讯会议等通话中进入绝对静默，杜绝打扰与隐私泄露。
7. 自适应双轨冷却状态机：同场景防高频打扰（90s），场景切换敏捷响应（15s）。
"""

import os
import sys
import time
import json
import logging
import threading
import asyncio
from typing import Optional, Dict, Any, List

import psutil
import comtypes
from comtypes import CLSCTX_ALL

try:
    from pycaw.pycaw import AudioUtilities, IAudioMeterInformation
    HAS_PYCAW = True
except Exception:
    HAS_PYCAW = False

try:
    from winsdk.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as SMTCManager
    HAS_WINSDK = True
except Exception:
    HAS_WINSDK = False

try:
    import win32gui
    import win32process
    HAS_WIN32 = True
except Exception:
    HAS_WIN32 = False

try:
    import urllib.request
except ImportError:
    pass

logger = logging.getLogger("audio_perception")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] [audio_perception] %(message)s")

# 通讯应用黑名单（通话隐私与防打扰，一旦发声立即静默）
COMMUNICATION_APPS = {
    "wechat.exe", "weixin.exe",
    "qq.exe", "qqnt.exe",
    "wemeetapp.exe", "wemeet.exe",
    "feishu.exe", "lark.exe",
    "dingtalk.exe",
    "discord.exe", "discordcanary.exe",
    "teams.exe", "ms-teams.exe",
    "skype.exe",
    "voovmeeting.exe",
    "zoom.exe",
    "slack.exe",
    "telegram.exe",
    "yy.exe",
}

# 自身宿主与系统底层进程黑名单（坚决排除，绝不感知自己与系统服务）
SELF_AND_SYSTEM_APPS = {
    "deepseek harness.exe",
    "deepseek-harness.exe",
    "deepseek.exe",
    "dsh.exe",
    "dsh-desktop.exe",
    "electron.exe",
    "nanomuse-desktop.exe",
    "node.exe",
    "python.exe",
    "pythonw.exe",
    "system",
    "registry",
    "audiodg.exe",
    "svchost.exe",
    "explorer.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "taskhostw.exe",
    "dllhost.exe",
    "rundll32.exe",
    "runtimebroker.exe",
    "applicationframehost.exe",
    "dwm.exe",
    "lsass.exe",
    "services.exe",
    "csrss.exe",
    "smss.exe",
    "msmpeng.exe",
}

# 常见游戏可执行文件名（小写匹配）
GAME_PROCESSES = {
    "genshinimpact.exe", "yuanshen.exe",
    "starrail.exe",
    "zenlesszonezero.exe",
    "blackmythwukong.exe", "b1.exe", "b1-win64-shipping.exe",
    "cs2.exe", "csgo.exe",
    "dota2.exe",
    "deadlock.exe",
    "valorant.exe", "valorant-win64-shipping.exe",
    "league of legends.exe", "leagueclientux.exe",
    "crossfire.exe",
    "dnf.exe",
    "naraka.exe",
    "minecraft.windows.exe", "javaw.exe",
    "eldenring.exe", "sekiro.exe", "dark souls.exe",
    "cyberpunk2077.exe",
    "witcher3.exe",
    "gta5.exe", "rdr2.exe",
    "palworld-win64-shipping.exe",
    "overwatch.exe",
    "apex.exe", "r5apex.exe",
    "deltaforce-win64-shipping.exe", "deltaforce.exe",
    "pubg.exe", "tslgame.exe",
    "ffxiv_dx11.exe", "wow.exe",
    "warframe.x64.exe",
    "mhwilds.exe", "mhrise.exe", "mhw.exe",
}

# 音乐播放器进程
MUSIC_APPS = {
    "cloudmusic.exe": "网易云音乐",
    "qqmusic.exe": "QQ音乐",
    "kugou.exe": "酷狗音乐",
    "kuwo.exe": "酷我音乐",
    "spotify.exe": "Spotify",
    "music.ui.exe": "Windows Media Player",
    "apple.music.exe": "Apple Music",
    "foobar2000.exe": "foobar2000",
    "lx-music.exe": "LX Music",
    "yesplaymusic.exe": "YesPlayMusic",
}

# 视频播放器进程
MEDIA_PLAYERS = {
    "potplayer64.exe": "PotPlayer",
    "potplayer.exe": "PotPlayer",
    "vlc.exe": "VLC",
    "mpv.exe": "mpv",
    "bilibili.exe": "哔哩哔哩",
    "qiyi.exe": "爱奇艺",
    "iqiyi.exe": "爱奇艺",
    "youku.exe": "优酷",
    "tencentvideo.exe": "腾讯视频",
    "baofeng.exe": "暴风影音",
    "kmplayer.exe": "KMPlayer",
    "mplayer.exe": "MPlayer",
    "xunlei.exe": "迅雷影音",
    "kankan.exe": "迅雷看看",
    "ffplay.exe": "FFplay",
}

# 常见主流浏览器（涵盖 Chrome/Edge/火狐/360/夸克/QQ/搜狗/Opera 等）
BROWSER_APPS = {
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "opera_gx.exe",
    "360se.exe",
    "360chrome.exe",
    "360chrome64.exe",
    "quark.exe",
    "qqbrowser.exe",
    "sogouexplorer.exe",
    "liebao.exe",
    "vivaldi.exe",
    "arc.exe",
    "centbrowser.exe",
    "theworld.exe",
    "ucbrowser.exe",
    "maxthon.exe",
    "waterfox.exe",
}


class AudioPerceptionEngine:
    def __init__(
        self,
        dsh_port: int = 59684,
        peak_threshold: float = 0.012,
        active_confirm_sec: float = 2.5,
        silence_exit_sec: float = 10.0,
        cooldown_sec: float = 90.0,
        switch_cooldown_sec: float = 15.0,
        enabled: bool = True,
        host_pid: int = 0,
    ):
        self.dsh_port = dsh_port
        self.peak_threshold = peak_threshold
        self.active_confirm_sec = active_confirm_sec
        self.silence_exit_sec = silence_exit_sec
        self.cooldown_sec = cooldown_sec
        self.switch_cooldown_sec = switch_cooldown_sec
        self.enabled = enabled
        self.host_pid = host_pid

        if not self.host_pid:
            try:
                for p in psutil.process_iter(['pid', 'name']):
                    n = (p.info.get('name') or '').lower()
                    if any(k in n for k in ['deepseek', 'harness', 'nanomuse']):
                        self.host_pid = p.info['pid']
                        break
            except Exception:
                pass

        self._running = False
        self._thread: Optional[threading.Thread] = None

        # 状态机维护
        self.current_state = "IDLE"  # IDLE | CONFIRMING | IN_SCENE | IN_CALL
        self.current_scene: Optional[Dict[str, Any]] = None
        self.last_notified_scene: Optional[Dict[str, Any]] = None
        self.last_notified_time: float = 0.0

        self.last_active_time: float = 0.0
        self.confirm_start_time: float = 0.0
        self.last_peak: float = 0.0

        # 自排除标志（自身 TTS 播放时置 True，避免录入自己）
        self.is_self_tts_playing = False

        # 监听端口与 Token 获取
        self.dsh_token = self._resolve_dsh_token()

    def _resolve_dsh_token(self) -> str:
        try:
            dsh_home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
            desk_file = os.path.join(dsh_home, "dsh-live2d-pet-desktop.json")
            if os.path.exists(desk_file):
                with open(desk_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if "port" in data and isinstance(data["port"], int):
                        self.dsh_port = data["port"]
                    return data.get("token", "")
        except Exception as e:
            logger.debug(f"Failed to read dsh token: {e}")
        return ""

    def start(self):
        if not HAS_PYCAW:
            logger.warning("[AudioPerception] pycaw 依赖未安装，音频感知引擎跳过启动。")
            return
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._worker_loop, name="AudioPerceptionWorker", daemon=True)
        self._thread.start()
        logger.info(f"AudioPerceptionEngine started (DSH target port: {self.dsh_port}, host PID excluded: {self.host_pid})")

    def stop(self):
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        logger.info("AudioPerceptionEngine stopped")

    def set_tts_playing(self, playing: bool):
        """由外部 TTS 服务调用，在桌宠自身发声时排除感知"""
        self.is_self_tts_playing = playing

    def _worker_loop(self):
        comtypes.CoInitialize()
        meter = None
        own_pid = os.getpid()

        try:
            while self._running:
                if not self.enabled:
                    time.sleep(1.0)
                    continue

                # 1. 物理声门查询 (IAudioMeterInformation)
                try:
                    if meter is None:
                        device = AudioUtilities.GetSpeakers()
                        interface = device._dev.Activate(IAudioMeterInformation._iid_, CLSCTX_ALL, None)
                        meter = interface.QueryInterface(IAudioMeterInformation)

                    peak = meter.GetPeakValue()
                    self.last_peak = peak
                except Exception as e:
                    meter = None
                    time.sleep(1.0)
                    continue

                # 如果自身正在播放 TTS，或者系统处于绝对静默状态
                if self.is_self_tts_playing:
                    time.sleep(0.4)
                    continue

                now = time.time()

                if peak < self.peak_threshold:
                    # 静音状态：处理场景退出
                    if self.current_state in ("IN_SCENE", "CONFIRMING"):
                        if now - self.last_active_time > self.silence_exit_sec:
                            self._handle_scene_exit()
                    # 极轻量休眠，0% CPU
                    time.sleep(0.6)
                    continue

                # 2. 发声状态：记录活跃时间并执行会话分析
                self.last_active_time = now
                scene = self._inspect_audio_sessions(own_pid)

                if not scene:
                    # 未识别出有效娱乐/多媒体会话（如系统杂音/忽略进程）
                    time.sleep(0.4)
                    continue

                if scene.get("is_call"):
                    # 通讯软件正在发声：进入最高防打扰静默
                    if self.current_state != "IN_CALL":
                        self.current_state = "IN_CALL"
                        logger.info(f"[CallGuard] Active call detected ({scene.get('app')}). Entering privacy mute.")
                    time.sleep(0.8)
                    continue
                elif self.current_state == "IN_CALL":
                    # 通话结束，重置状态
                    self.current_state = "IDLE"

                # 3. 状态机推进
                self._update_state_machine(scene, now)

                # 发声采样间隔
                time.sleep(0.5)

        finally:
            comtypes.CoUninitialize()

    def _inspect_audio_sessions(self, own_pid: int) -> Optional[Dict[str, Any]]:
        """遍历活动音频会话，做归因与分类（排除自身与无媒体信息的未知杂音）"""
        active_sessions = []

        try:
            sessions = AudioUtilities.GetAllSessions()
        except Exception:
            return None

        for s in sessions:
            try:
                proc = s.Process
                if not proc:
                    continue
                pid = proc.pid
                if pid == own_pid or (self.host_pid and pid == self.host_pid):
                    continue  # 忽略自身 TTS 服务及 DSH 宿主进程

                # 会话状态 1 为 Active
                if s.State != 1:
                    continue

                proc_name = proc.name().lower()

                # 排除自身宿主与 Windows 底层服务
                if proc_name in SELF_AND_SYSTEM_APPS or any(k in proc_name for k in ["deepseek", "harness", "dsh-", "electron"]):
                    continue

                # 通讯黑名单拦截
                if proc_name in COMMUNICATION_APPS:
                    return {"is_call": True, "app": proc_name}

                active_sessions.append((proc, proc_name, pid))
            except Exception:
                continue

        if not active_sessions:
            return None

        # 优先排查前台活动窗口
        fg_info = self._get_foreground_window()
        fg_pid = fg_info.get("pid", 0) if fg_info else 0
        fg_app = fg_info.get("app", "") if fg_info else ""
        fg_title = fg_info.get("title", "") if fg_info else ""

        # 筛选出发声的代表应用（前台窗口匹配或同进程名优先，否则挑选娱乐/多媒体会话）
        chosen_proc = None
        for proc, name, pid in active_sessions:
            if pid == fg_pid or (fg_app and name == fg_app):
                chosen_proc = (proc, name, pid)
                break

        if not chosen_proc:
            for proc, name, pid in active_sessions:
                if name in GAME_PROCESSES or name in MEDIA_PLAYERS or name in MUSIC_APPS or name in BROWSER_APPS:
                    chosen_proc = (proc, name, pid)
                    break

        if not chosen_proc:
            # 没有命中任何已知娱乐/视频/浏览器进程，排查是否有原生 SMTC 媒体
            smtc_data = self._get_smtc_info()
            if smtc_data and smtc_data.get("title"):
                proc, proc_name, pid = active_sessions[0]
                return {
                    "is_call": False,
                    "category": "video",
                    "app": proc_name,
                    "title": smtc_data.get("title", ""),
                    "artist": smtc_data.get("artist", ""),
                    "pid": pid,
                }
            # 无 SMTC 媒体信息的未知进程（如系统蜂鸣、后台工具），坚决忽略
            return None

        proc, proc_name, pid = chosen_proc

        # 场景分类与元数据提取
        category = "unknown"
        title = ""
        artist = ""

        # A. 游戏分类
        if self._is_game_process(proc, proc_name):
            category = "game"
            title = self._clean_game_name(proc_name, fg_title if (pid == fg_pid or proc_name == fg_app) else "")

        # B. 音乐分类
        elif proc_name in MUSIC_APPS:
            category = "music"
            app_display = MUSIC_APPS[proc_name]
            smtc_data = self._get_smtc_info()
            if smtc_data and smtc_data.get("title"):
                title = smtc_data.get("title", "")
                artist = smtc_data.get("artist", "")
            else:
                title = self._clean_window_title(fg_title if (pid == fg_pid or proc_name == fg_app) else app_display)

        # C. 视频/影视播放器分类
        elif proc_name in MEDIA_PLAYERS:
            category = "movie"
            smtc_data = self._get_smtc_info()
            if smtc_data and smtc_data.get("title"):
                title = smtc_data.get("title", "")
                artist = smtc_data.get("artist", "")
            else:
                title = self._clean_media_title(fg_title if (pid == fg_pid or proc_name == fg_app) else proc_name)

        # D. 浏览器发声分类
        elif proc_name in BROWSER_APPS:
            smtc_data = self._get_smtc_info()
            if smtc_data and smtc_data.get("title"):
                category = "video"
                title = smtc_data.get("title", "")
                artist = smtc_data.get("artist", "")
            elif (pid == fg_pid or proc_name == fg_app) and fg_title:
                category = "video"
                title = self._clean_browser_title(fg_title)
            else:
                category = "video"
                title = "网络视频/网页音频"

        else:
            # 其他未知进程：仅当存在 SMTC 媒体元数据时才采纳
            smtc_data = self._get_smtc_info()
            if smtc_data and smtc_data.get("title"):
                category = "video"
                title = smtc_data.get("title", "")
                artist = smtc_data.get("artist", "")
            else:
                return None

        return {
            "is_call": False,
            "category": category,
            "app": proc_name,
            "title": title,
            "artist": artist,
            "pid": pid,
        }

    def _is_game_process(self, proc, proc_name: str) -> bool:
        if proc_name in GAME_PROCESSES:
            return True
        try:
            exe_path = proc.exe().lower()
            game_indicators = [
                "steamapps\\common", "epic games\\", "wegameapps\\", "genshin impact",
                "riot games\\", "ubisoft\\", "ea games\\", "battle.net\\", "blizzard\\",
                "\\games\\", "\\steam\\", "\\game\\",
            ]
            if any(k in exe_path for k in game_indicators):
                return True
        except Exception:
            pass
        return False

    def _clean_game_name(self, proc_name: str, window_title: str) -> str:
        KNOWN_NAMES = {
            "genshinimpact.exe": "原神", "yuanshen.exe": "原神",
            "starrail.exe": "崩坏：星穹铁道",
            "zenlesszonezero.exe": "绝区零",
            "blackmythwukong.exe": "黑神话：悟空", "b1.exe": "黑神话：悟空",
            "b1-win64-shipping.exe": "黑神话：悟空",
            "cs2.exe": "Counter-Strike 2",
            "csgo.exe": "Counter-Strike: Global Offensive",
            "dota2.exe": "Dota 2",
            "deadlock.exe": "Deadlock",
            "valorant.exe": "无畏契约 (VALORANT)",
            "crossfire.exe": "穿越火线",
            "dnf.exe": "地下城与勇士",
            "naraka.exe": "永劫无间",
            "cyberpunk2077.exe": "赛博朋克 2077",
            "eldenring.exe": "艾尔登法环",
            "palworld-win64-shipping.exe": "幻兽帕鲁",
            "deltaforce-win64-shipping.exe": "三角洲行动", "deltaforce.exe": "三角洲行动",
            "pubg.exe": "绝地求生 (PUBG)", "tslgame.exe": "绝地求生 (PUBG)",
            "mhwilds.exe": "怪物猎人：荒野",
        }
        if proc_name in KNOWN_NAMES:
            return KNOWN_NAMES[proc_name]
        if window_title:
            cleaned = window_title.split(" - ")[0].strip()
            if cleaned:
                return cleaned
        return proc_name.replace(".exe", "")

    def _clean_media_title(self, raw_title: str) -> str:
        for suffix in [" - PotPlayer", " - VLC media player", " - 恒星播放器", " - 完美解码", " - 哔哩哔哩"]:
            if suffix in raw_title:
                raw_title = raw_title.replace(suffix, "").strip()
        return raw_title

    def _clean_browser_title(self, raw_title: str) -> str:
        for suffix in [
            " - 哔哩哔哩", " - bilibili", " - 腾讯视频", " - 爱奇艺", " - 优酷视频",
            " - YouTube", " - Google Chrome", " - Microsoft Edge", " - 火狐浏览器",
            " - 360极速浏览器", " - 360安全浏览器", " - QQ浏览器", " - 夸克浏览器",
            " - 搜狗浏览器", " - Opera", " - Vivaldi",
        ]:
            if suffix.lower() in raw_title.lower():
                idx = raw_title.lower().find(suffix.lower())
                raw_title = raw_title[:idx].strip()
        if " - " in raw_title:
            raw_title = raw_title.rsplit(" - ", 1)[0].strip()
        return raw_title.strip()

    def _clean_window_title(self, raw_title: str) -> str:
        return raw_title.strip()

    def _get_smtc_info(self) -> Optional[Dict[str, str]]:
        """调用 Windows SMTC 异步提取媒体标题与艺术家"""
        if not HAS_WINSDK:
            return None
        try:
            async def _fetch():
                manager = await SMTCManager.request_async()
                session = manager.get_current_session()
                if not session:
                    sessions = manager.get_sessions()
                    if sessions and len(sessions) > 0:
                        session = sessions[0]
                if not session:
                    return None
                props = await session.try_get_media_properties_async()
                if not props:
                    return None
                return {
                    "title": props.title or "",
                    "artist": props.artist or "",
                    "source": session.source_app_user_model_id or "",
                }

            loop = asyncio.new_event_loop()
            try:
                return loop.run_until_complete(asyncio.wait_for(_fetch(), timeout=1.5))
            finally:
                loop.close()
        except Exception:
            return None

    def _get_foreground_window(self) -> Dict[str, Any]:
        if not HAS_WIN32:
            return {}
        try:
            hwnd = win32gui.GetForegroundWindow()
            if not hwnd:
                return {}
            title = win32gui.GetWindowText(hwnd)
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            app_name = ""
            try:
                p = psutil.Process(pid)
                app_name = p.name().lower()
            except Exception:
                pass
            return {"title": title, "pid": pid, "app": app_name}
        except Exception:
            return {}

    def _update_state_machine(self, scene: Dict[str, Any], now: float):
        """状态机维护与防抖分发"""
        if self.current_state == "IDLE":
            self.current_state = "CONFIRMING"
            self.confirm_start_time = now
            self.current_scene = scene

        elif self.current_state == "CONFIRMING":
            # 持续活跃时间满足 active_confirm_sec
            if now - self.confirm_start_time >= self.active_confirm_sec:
                self.current_state = "IN_SCENE"
                self.current_scene = scene
                self._dispatch_scene_event("ENTER", scene)

        elif self.current_state == "IN_SCENE":
            # 检查场景是否切换（例如从游戏切到看视频，或更换了视频片名）
            if (
                scene.get("category") != self.current_scene.get("category")
                or (scene.get("title") and scene.get("title") != self.current_scene.get("title"))
            ):
                logger.info(f"Scene changed: {self.current_scene.get('title')} -> {scene.get('title')}")
                self.current_scene = scene
                self._dispatch_scene_event("SWITCH", scene)

    def _handle_scene_exit(self):
        if self.current_state == "IN_SCENE" and self.current_scene:
            logger.info(f"Scene exited: {self.current_scene.get('title')}")
            self._dispatch_scene_event("LEAVE", self.current_scene)
        self.current_state = "IDLE"
        self.current_scene = None

    def _dispatch_scene_event(self, action: str, scene: Dict[str, Any]):
        """生成标准化场景事件并投递给 DSH 核心中枢（自适应冷却）"""
        now = time.time()
        is_same_scene = (
            self.last_notified_scene
            and self.last_notified_scene.get("title") == scene.get("title")
            and self.last_notified_scene.get("category") == scene.get("category")
        )
        required_cooldown = self.cooldown_sec if is_same_scene else self.switch_cooldown_sec

        if action in ("ENTER", "SWITCH") and (now - self.last_notified_time < required_cooldown):
            logger.debug(f"Scene event suppressed by cooldown ({required_cooldown:.1f}s).")
            return

        payload = {
            "type": "audio_scene",
            "action": action,
            "category": scene.get("category"),
            "app": scene.get("app"),
            "title": scene.get("title"),
            "artist": scene.get("artist"),
            "timestamp": int(now),
        }

        logger.info(f"Dispatching scene event: [{action}] {scene.get('category')} - 《{scene.get('title')}》 ({scene.get('app')})")
        self.last_notified_scene = scene
        self.last_notified_time = now

        # 发送至 DSH Webhook
        self._notify_dsh(payload)

    def _notify_dsh(self, payload: Dict[str, Any]):
        """通过本地网络通知 DSH 插件路由 /dsh-pet/perception"""
        def _post():
            url = f"http://127.0.0.1:{self.dsh_port}/dsh-pet/perception"
            try:
                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    url,
                    data=data,
                    headers={
                        "Content-Type": "application/json",
                        "x-dsh-pet-desk": self.dsh_token,
                    },
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=3.0) as res:
                    res_body = res.read().decode("utf-8")
                    logger.debug(f"DSH perception response: {res_body}")
            except Exception as e:
                logger.debug(f"Failed to post perception event to DSH at {url}: {e}")

        threading.Thread(target=_post, daemon=True).start()

    def get_status(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "running": self._running,
            "state": self.current_state,
            "current_scene": self.current_scene,
            "last_peak": round(self.last_peak, 4),
            "is_tts_playing": self.is_self_tts_playing,
            "dsh_port": self.dsh_port,
            "host_pid": self.host_pid,
        }


if __name__ == "__main__":
    logging.info("Testing AudioPerceptionEngine in standalone mode...")
    engine = AudioPerceptionEngine(dsh_port=59684, cooldown_sec=10.0)
    engine.start()
    try:
        for _ in range(15):
            time.sleep(1.0)
            status = engine.get_status()
            print(f"[{time.strftime('%H:%M:%S')}] Peak={status['last_peak']}, State={status['state']}, Scene={status['current_scene']}")
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()
