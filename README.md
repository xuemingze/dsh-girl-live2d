# dsh-girl-live2d · Live2D 多伴侣桌宠插件 / Multi-Companion Live2D Desktop Pet (DeepSeek Harness)

<div align="center">

**面向 DeepSeek Harness (DSH) Web 与桌面环境的 Live2D 多伴侣桌宠与 AI 交互增强插件**  
**A Multi-Companion Live2D Desktop Pet & Voice-Interactive AI Plugin for DeepSeek Harness (DSH)**

[![Version](https://img.shields.io/badge/version-1.1.08-7c5cff.svg)](https://github.com/xuemingze/dsh-girl-live2d/releases)
[![License: MIT](https://img.shields.io/badge/Code_License-MIT-green.svg)](./LICENSE)
[![Live2D Cubism](https://img.shields.io/badge/Live2D-Cubism_4%2F5-ff66a5.svg)](https://www.live2d.com/)

[**🇨🇳 中文文档**](#-功能全景) • [**🇬🇧 English Documentation**](#-english-documentation) • [**🇬🇧 README_EN.md**](./README_EN.md) • [**📦 Release Notes**](./CHANGELOG.md)

</div>

<img width="989" height="817" alt="live2d" src="https://github.com/user-attachments/assets/6e59c3df-8462-4abf-bf71-4651619e1770" />

---

> [!IMPORTANT]
> **声明与致谢 / Attribution & Acknowledgements**  
> 本项目基于原开源项目 [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 进行深度扩展与架构重构。在完整保留原项目优秀的 DSH 插件挂载架构、深海鲸鱼娘基准交互与工作简报机制的基础上，全面升级为**多伴侣 Live2D 体系**、**脱离客户端独立桌面常驻渲染（Windows 原生透明穿透壳）**、**面向对象（OOP）点击与工作状态语音交互引擎**、**T0 系统音频多媒体智能嗅探与环境感知**、**统一语音时序调度器（SpeechSequencer）**、**侧边自适应菜单与四角防溢出吸附**、**提示词专属声线生成器**与**桌面视觉协同**。  
> *This project is an extended and refactored evolution of [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d), preserving the original DSH plugin architecture and Whale Girl baseline while introducing a multi-companion Live2D ecosystem, independent desktop detachment, T0 system audio multimedia perception, unified speech arbitration, side-docked adaptive menu, and natural voice design.*

---

## 📖 设计愿景与核心理念

在原生 **Andersen216/dsh-whale-girl-live2d** 基础上，本项目嫁接了高表现力的 **Live2D** 形象系统，让 Live2D 真正成为 **DeepSeek Harness (DSH) 大脑的灵动传声筒**：
- **日常生活**：直接与桌宠角色展开语音与流式气泡对话，提供随叫随到的情感陪伴与互动；
- **工作项目**：AI 编写代码、执行工具或跑长任务时，桌宠在旁认真办公，并在关键节点或任务完成时主动向你汇报提醒；
- **环境感知**：无感感知你正在玩的 PC 游戏、正在听的音乐或正在看的高清视频，自然随口搭话吐槽，做你数字生活的贴心桌面搭子。

---

## 🌟 功能全景

### 1. 🎧 T0 系统音频智能嗅探与环境感知 (`AudioPerceptionEngine`)
- **使用目的与意图**：
  彻底舍弃高耗能、易误判、涉隐私的后台频繁截屏轮询（OCR / 视觉大模型识图），采用**物理声门峰值监听 + 前端会话嗅探**的方式。最大程度减少显卡与 CPU 占用，玩游戏或看电影时也不会有任何卡顿干扰。遵循“**被动陪伴走音频嗅探（看片/听歌/打游戏），主动提问走快捷键截图**”的设计分工，让桌宠获知你在干什么并适时贴心搭话。
  > 💡 *小提示：玩游戏时记得点击角色脚下的 “_” 按钮，可将伴侣快速收起或降至托盘，需要时一键唤回。*
- **使用方法与体验**：
  随本地 9880 守护服务开箱即启，**零额外配置**：
  - 状态查询：`GET http://127.0.0.1:9880/perception/status`
  - 快捷开关：`POST http://127.0.0.1:9880/perception/toggle`
  - **看片与听歌感知**：打开 B站、网易云音乐、QQ音乐、爱奇艺、腾讯视频或 PotPlayer、VLC 等主流播放器，声音持续 2~3 秒后，桌宠通过 Windows 原生 SMTC 或窗口标题智能嗅探片名/曲名，在恰当时机自然随口聊一句互动吐槽。
  - **游戏场景识别**：启动 CS2、原神、崩铁、绝区零、黑神话：悟空、三角洲行动、无畏契约、艾尔登法环等热门游戏，零反作弊风险自动归类为游戏场景。
  - **通话隐私自动静默 (Call Guard)**：一旦检测到微信、QQ、腾讯会议、钉钉、飞书、Discord 等通讯软件发声，系统立即进入绝对静默，杜绝打扰与隐私外泄。
- **技术保障**：
  - **0.0% 静息 CPU**：基于 Windows 原生 WASAPI Peak Gate，系统静音时绝对休眠不录音。
  - **双轨自适应智能冷却**：同一场景/游戏保持 90 秒防打扰冷却；切换应用或更换视频时 15 秒敏捷响应。
  - **排除自身与底层噪音**：坚决排除 DSH 宿主、桌宠自身及系统蜂鸣杂音，杜绝自捕获死锁。

---

### 2. 🖥️ 脱离客户端 · 独立桌面常驻渲染（Windows 原生透明置顶壳）
- **一键跳出客户端**：在桌宠「设置」面板「宿主」行点击 **`[🖥️ 脱离客户端 · 独立桌面常驻]`**，伴侣即可从 DSH 客户端窗口完全剥离，直接驻留在 Windows 系统桌面上（基于 `WinSta0\Default` 独立渲染通道）。
- **客户端最小化无感联通**：即便将 DSH 软件最小化到任务栏，角色依然在桌面上方最前列陪伴；点击互动、发起对话、流式气泡、TTS 语音播报与动作表情全程可用。
- **像素级鼠标穿透 (`WS_EX_TRANSPARENT`)**：基于 50ms 实时透明碰撞探针，仅角色本体与面板响应鼠标，透明空白区域 100% 穿透点击底层游戏窗口或桌面图标。
- **极简托盘收纳**：角色脚下常驻快捷按钮：“`_`” 一键最小化隐藏，“`⚙`” 一键打开快捷菜单，右下角提供快速恢复胶囊。

---

### 3. 🎭 多伴侣 Live2D 自由切换与自定义模型导入
- **5 大精选内置伴侣**：
  - **深海鲸鱼娘 (`whale`)**：经典元祖伴侣，配备 52 套动作/表情映射、12% 喷水彩蛋与防连点冷静期机制。
  - **兔兔 (`tutu`)**：活泼灵动的二次元少女，自带动作表情与常驻防盗版反向透明锁。
  - **西域舞女 (`yuyu`)**：冷艳神秘舞者，支持面纱、瞳色、发型与饰品多重切换。
  - **可可女仆 (`keke`)**：元气可爱女仆，随带奶茶、餐盘、托盘动作与多色发型。
  - **冰冰龙 (`xiaoxiao`)**：呆萌治愈系龙女伴侣。
- **即时无缝切换**：在菜单「伴侣」栏一键切换角色，自动清理上一角色的工作锁，独立记忆各自的缩放、音色与映射参数。
- **自定义模型导入与安全删除**：
  - 支持将任意 Live2D Cubism 3/4 模型（文件夹或 ZIP）直接导入；
  - 自动运行 `character-asset-analyzer.js` 扫描表情、动作与装饰资产并生成默认映射；
  - 针对自定义角色提供 **内置网页级安全确认删除面板**，避免原生弹窗黑屏与 Windows 软链接死锁。

---

### 4. 🎼 统一语音时序调度器 (`SpeechSequencer & Arbitrator`)
- **设计初衷**：彻底解决 AI 思考碎碎念、环境感知吐槽、鼠标点击交互与正式大模型问答之间的音轨重叠并发、切音吞字与网络异步竞争现象。
- **四级抢占优先级阶梯**：
  $$\text{P0 (紧急打断)} > \text{P1 (正文回答)} > \text{P2 (点击互动)} > \text{P3 (环境感知)} > \text{P4 (思考呢喃)}$$
  - **P0 紧急打断**：按下 Esc 或点击取消，瞬间静音声门并销毁未决网络队列；
  - **P1 正答优先**：DSH 正式回答返回时，80ms 平滑淡出低优碎碎念，优先为主人解答正事；
  - **P2 点击互动**：轻触桌宠触发交互台词，带 800ms 防抖，连点不抽搐；
  - **P3 环境感知**：游戏/视频感知吐槽具备时效性，若桌宠正忙于正答则自动静默，绝不插嘴；但可平滑打断 P4 思考碎碎念；
  - **令牌化防竞态 (Token Gate)**：异步网络延迟再高，也绝不会让过期的旧请求切断当前新对话。

---

### 5. 🎙️ 本地极速 TTS 声带服务与提示词声线定制
- **本地 9880 极速声带**：基于 `edge-tts` 与轻量音频流水线，**0 显存占用**，带多频段实时口型同步（Lip-Sync）。
- **自然语言提示词生成声线**：在面板中直接输入提示词（如 *“元气甜美女仆，语速偏快，语调活泼”* 或 *“冷艳成熟御姐”*），自动推导基座声音、语速与音调配置。
- **纯净伴侣人声**：彻底剥离 `<think>` 思考链、`Route: fast-path` 路由信息与执行用时等工程元数据，桌宠只说生动自然的人话。

---

### 6. 📐 侧边自适应智能菜单与屏幕边界防护
- **动态左右自适应**：
  - 角色位于屏幕左半区：菜单自动贴靠在角色**右侧**展开；
  - 角色位于屏幕右半区：菜单自动贴靠在角色**左侧**展开；
- **四角安全边界软夹**：无论拖拽到屏幕四个角落中的哪一个，菜单均会动态计算可视区域边界并平移对齐，关闭按钮与选项永远 100% 可见可点，永不被任务栏或屏幕边框截断。

---

### 7. 🤖 双轨伴读、任务汇报与桌面视觉协同
- **双轨台词解析 (ActionCueParser)**：台词中的动作神态指令（如 `（歪头微笑）`、`（扶眼镜）`）在气泡中完整展示并即时联动 Live2D 表情动作，而在 TTS 发音层自动剥离，实现生动的“声情并茂”。
- **工作状态轮播**：DSH 跑命令、搜文件、改代码时，桌宠戴上眼镜、掏出工作本低头认真阅读，工作完成后欢快庆祝并弹出用量与结算气泡。
- **桌面视觉协同 (`visual_hands`)**：内置 NCC 模板匹配与屏幕坐标定位算法，为后续辅助点击与桌面自动化操作预留了底层视觉能力。

---

## 📦 安装与快速上手

### 1. 依赖环境准备
本项目推荐在 **Windows 10 / 11** 环境下运行，依赖 Python 3.10+ 环境：
```bash
# 进入插件根目录一键安装所有依赖
pip install -r requirements.txt
```
*(核心依赖包含：`edge-tts`, `soundfile`, `PySide6`, `pycaw`, `winsdk`, `psutil`, `pywin32`, `comtypes`)*

---

### 2. 方式一：在 DeepSeek Harness 中直接安装（推荐）

```bash
# 为 Web 模式安装
dsh plugin --profile web add github:xuemingze/dsh-girl-live2d

# 为桌面端模式安装
dsh plugin --profile desktop add github:xuemingze/dsh-girl-live2d
```

---

### 3. 方式二：本地克隆与软链挂载

```bash
git clone https://github.com/xuemingze/dsh-girl-live2d.git
cd dsh-girl-live2d
npm install
pip install -r requirements.txt

# 挂载到 DSH Web 或 Desktop profile
dsh plugin --profile web add "link:."
dsh plugin --profile desktop add "link:."
```

---

### 4. 方式三：启动独立后端服务（常驻桌面体验）

```bash
# 启动本地 9880 守护服务（包含 TTS 合成、独立桌面壳管理与系统音频感知引擎）
python voice_engine/tts_service.py --port 9880
```

---

## ⚙️ 目录结构说明

```text
dsh-girl-live2d/
├── assets/                  # 前端核心运行时（Pixi.js, Live2D Cubism, pet.js 核心控制器与时序器）
├── characters/              # 内置与自定义伴侣模型目录 (whale / tutu / yuyu / keke / xiaoxiao)
├── desktop/                 # 独立桌面常驻壳 (desktop_launcher.py - PySide6 透明穿透置顶窗口)
├── lib/                     # DSH 插件后端中枢 (index.js 意图调度与 DSH 大脑连接)
├── tools/                   # 资产扫描分析器 (character-asset-analyzer.js) 与发布校验脚本
├── visual_hands/            # 桌面自动化视觉协同引擎 (NCC 模板匹配算法)
├── voice_engine/            # 本地 TTS 服务 (tts_service.py) 与音频感知引擎 (audio_perception.py)
├── requirements.txt         # Python 运行环境依赖清单
├── cordis.patch.yml         # DSH 插件挂载配置
└── package.json             # 插件元信息与脚本定义
```

---

<a id="-english-documentation"></a>

# 🇬🇧 English Documentation

## 📖 Vision & Core Philosophy

Based on the original foundation of **[Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d)**, this project integrates rich **Live2D** companion avatars to serve as the **living, voice-interactive ambassador for the DeepSeek Harness (DSH) AI brain**:
- **Daily Companionship**: Converse directly with your companion via real-time streaming speech bubbles and dynamic voice synthesis.
- **Workflow Briefings**: While DSH writes code or runs autonomous agent tools, your companion stays focused on work alongside you and immediately notifies you upon task completion.
- **Ambient Perception**: Non-intrusively detects the PC game you are playing, the music you are listening to, or the video you are streaming, chiming in with natural, contextual banter.

---

## 🌟 Full Feature Overview

### 1. 🎧 T0 Zero-CPU System Audio Perception Engine (`AudioPerceptionEngine`)
- **Philosophy**: Completely replaces power-hungry background screen recording (OCR / vision LLMs) with **event-driven WASAPI loopback peak gating + session attribution**. Zero GPU/CPU overhead during gaming or streaming.
  > 💡 *Tip: Click the “_” button beneath the companion's feet to minimize her to the tray or dock during gaming sessions.*
- **Features**:
  - **Zero Idle CPU**: 0.0% CPU usage during system silence via native WASAPI hardware peak meters.
  - **Video & Music Awareness**: Detects Bilibili, YouTube, Spotify, NetEase Cloud Music, PotPlayer, VLC, etc., extracting titles via WinRT SMTC and window titles to make brief companion remarks.
  - **Gaming Recognition**: Safe, read-only process matching for CS2, Genshin, Star Rail, Black Myth: Wukong, Delta Force, Elden Ring, and Steam/Epic titles with zero anti-cheat risk.
  - **Call Guard**: Automatically engages strict privacy mute upon detecting communication software (WeChat, Zoom, Teams, Discord, DingTalk).
  - **Dual-Track Adaptive Cooldown**: 90 seconds for continuous scenes (preventing spam) and 15 seconds for switched scenes (delivering responsive agility).

### 2. 🖥️ Detached Desktop Window & Pixel-Level Click-Through
- **One-Click Detach**: Click **`[🖥️ 脱离客户端 · 独立桌面常驻]`** in the settings panel to detach the companion directly onto the Windows desktop (`WinSta0\Default`).
- **Minimize-Proof**: Even when DeepSeek Harness is minimized to the taskbar, your companion stays active and interactive on top.
- **Alpha Mask Click-Through (`WS_EX_TRANSPARENT`)**: Only opaque character and UI pixels capture mouse clicks; transparent areas allow full click-through to underlying games and windows.

### 3. 🎭 Multi-Companion Live2D Ecosystem & Custom Model Imports
- **5 Built-In Companions**: Deep-Sea Whale Girl (`whale`), Tutu (`tutu`), Western Dancer Yuyu (`yuyu`), Keke Maid (`keke`), and Ice Dragon Xiaoxiao (`xiaoxiao`).
- **Custom Model Drag-and-Drop**: Import any Live2D Cubism 3/4 model with automated asset scanning and slot mapping via `character-asset-analyzer.js`.
- **In-Page Safe Deletion**: In-page modal confirm dialog eliminates OS popup freezes and safely unlinks junction symlinks on Windows.

### 4. 🎼 SpeechSequencer & Priority Arbitration
- Eliminates dual-audio overlap, thought vs. answer collisions, and network race conditions.
- Priority hierarchy:
  $$\text{P0 (Abort)} > \text{P1 (Answer)} > \text{P2 (Interactive Tap)} > \text{P3 (Perception)} > \text{P4 (Thinking Monologue)}$$
- Perceptions (P3) smoothly preempt thinking cues (P4), while answers (P1) always take precedence.

### 5. 🎙️ High-Speed Local TTS & Natural Prompt Voice Design
- Zero-VRAM local speech synthesis on port `9880` powered by `edge-tts` with multi-frequency Lip-Sync.
- Generate voice pitch, speed, and timbre directly from natural-language descriptions.
- Automatically strips `<think>` chains and DSH system routing metadata to ensure clean, in-character vocal output.

### 6. 📐 Side-Docked Adaptive Menu & Boundary Clamping
- Intelligently anchors to the right or left of the character depending on the screen half.
- 4-corner boundary clamping ensures buttons and settings never clip beyond screen edges.

---

## 📜 开源许可与致谢 / Credits & License

1. **原项目致谢 / Original Project**:
   - 衷心感谢 **[Andersen216](https://github.com/Andersen216)** 开源的优秀基座 [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d)。
2. **角色资产版权 / Character Attribution**:
   - **鲸鱼娘**：原画 [天然怠惰](https://space.bilibili.com/4456176)、模型 [ZipZipPipe](https://space.bilibili.com/4168597)、Live2D 制作 [梦梦](https://space.bilibili.com/11272072)（CC BY-NC-SA 4.0 非商业）。
   - 本项目所有 Live2D 演示素材均仅供学习交流，严禁商业用途。
3. **软件协议 / Software License**:
   - 本项目代码遵循 **MIT License** 开源。
