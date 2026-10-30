# dsh-girl-live2d · Live2D 多伴侣桌宠插件 / Multi-Companion Live2D Desktop Pet (DeepSeek Harness)

<div align="center">

**面向 DeepSeek Harness (DSH) Web 与桌面环境的 Live2D 多伴侣桌宠与 AI 交互增强插件**  
**A Multi-Companion Live2D Desktop Pet & Voice-Interactive AI Plugin for DeepSeek Harness (DSH)**

[![Version](https://img.shields.io/badge/version-1.1.06-7c5cff.svg)](https://github.com/xuemingze/dsh-girl-live2d/releases)
[![License: MIT](https://img.shields.io/badge/Code_License-MIT-green.svg)](./LICENSE)
[![Live2D Cubism](https://img.shields.io/badge/Live2D-Cubism_4%2F5-ff66a5.svg)](https://www.live2d.com/)

[**🇨🇳 中文文档**](#-功能特性) • [**🇬🇧 English (In-Page)**](#-english-documentation) • [**🇬🇧 README_EN.md**](./README_EN.md) • [**📦 Release Notes**](./CHANGELOG.md)

</div>

---

> [!IMPORTANT]
> **声明与致谢 / Attribution & Acknowledgements**  
> 本项目基于原开源项目 [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 进行深度扩展与重构。在完整保留原项目优秀的 DSH 插件挂载架构、深海鲸鱼娘基准交互与工作简报机制的基础上，全面升级为**多伴侣 Live2D 体系**、**脱离客户端独立桌面常驻渲染（Windows 原生透明穿透壳）**、**面向对象（OOP）点击与工作状态语音交互引擎**、**T0 系统音频多媒体智能嗅探与环境感知**、**统一语音时序调度器（SpeechSequencer）**、**侧边自适应菜单与四角防溢出吸附**、**提示词专属声线生成器**与**桌面视觉协同**。  
> *This project is an extended and refactored evolution of [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d), preserving the original DSH plugin architecture and Whale Girl baseline while introducing a multi-companion Live2D ecosystem, independent desktop detachment, T0 system audio multimedia perception, unified speech arbitration, side-docked adaptive menu, and natural voice design.*

---

## 🌟 功能特性 (v1.1.06 重点更新)

### 1. 🎧 T0 系统音频智能嗅探与环境感知 (`AudioPerceptionEngine`)
- **使用目的与意图**：
  彻底取代高耗能、易报错、涉隐私的后台频繁截屏轮询（OCR / 视觉大模型）。遵循“被动陪伴走音频嗅探（看片/听歌/打游戏），主动提问走快捷键截图”的设计分工，让桌宠获知你在干什么并适时贴心搭话。
- **使用方法**：
  随本地 9880 Python 守护服务自动启动，**零额外配置**：
  - 状态查询：`GET http://127.0.0.1:9880/perception/status`
  - 快捷开关：`POST http://127.0.0.1:9880/perception/toggle`
  - **听歌/看视频**：打开网易云音乐、QQ音乐、B站视频或本地播放器（PotPlayer 等），发声 3 秒后桌宠自动获知曲名或片名，在合适时机以亲切口吻主动随口吐槽互动。
  - **游戏陪伴**：启动 CS2、原神、星穹铁道、黑神话等游戏，零作弊风险自动归类为游戏场景。
  - **通话隐私自动静默**：检测到微信、QQ、腾讯会议、钉钉、飞书、Discord 等通讯软件发声时，自动进入最高隐私静默，绝不打扰。
- **设计铁律与原则**：
  - **0% 静息 CPU**：基于 Windows 原生 WASAPI Peak Gate，静音时绝对休眠不录音。
  - **零侵入合规**：绝不读取游戏内存或注入进程，避免任何反作弊封号风险。
  - **DSH 唯一大脑**：伴侣端不内置任何大模型，感知事件全部推入 DSH 大脑决策，DSH 输出回答后桌宠才被动演出。

### 2. 🎼 统一语音时序调度器 (`SpeechSequencer & Arbitrator`)
- **使用目的与意图**：
  彻底消灭多音轨重叠并发、思考呢喃与正文回答打架、连续点击抢嘴、以及异步网络请求导致的“话刚说半句突然被腰斩”等“人工智障”现象。
- **时序仲裁与使用体验**：
  - **P0 紧急打断**：按下 Esc 或点击打断，瞬间静音并清空所有未决请求。
  - **P1 正答优先**：DSH 正文回复到达时，80ms 平滑淡出低优碎碎念，桌宠优先回答主人正事。
  - **P2 点击娇嗔**：点击桌宠触发互动语音，内置 800ms 防抖，连点不抽搐。
  - **P3 感知吐槽**：强时效性，若桌宠正忙直接静默丢弃，绝不插嘴抢话。
  - **P4 思考呢喃**：DSH 思考时小声提示，遇强立退。
  - **令牌化防竞态 (Token Gate)**：异步网络延迟再高，也绝不会让过期的旧音频切入。

### 3. 📐 菜单侧边智能动态停靠与屏幕四角吸附
- **使用目的与意图**：
  彻底解决旧版菜单弹在角色头顶或脚部时，挡住对话气泡、遮蔽聊天输入框、以及在屏幕边缘被截断的严重遮挡问题。
- **使用体验**：
  - 角色在屏幕左半区：菜单自动贴靠在角色右侧展开；
  - 角色在屏幕右半区：菜单自动贴靠在角色左侧展开；
  - 无论是左上、右上、左下还是右下角，菜单自动计算屏幕安全边距垂直平移，关闭按钮与选项永远 100% 可见可点；
  - 布局计算毫秒级同步 Electron 穿透区域，点击即刻响应。

### 4. 🖥️ 脱离客户端 · 独立桌面常驻渲染
- **一键跳出客户端**：在桌宠「设置」面板「宿主」行点击 **`[🖥️ 脱离客户端 · 独立桌面常驻]`**，即可将伴侣从 DSH 客户端窗口剥离，直接常驻于 Windows 系统桌面上。
- **客户端最小化无感联通**：即使将 DSH 软件最小化，角色依然保留在桌面最前端；点击互动、发起对话、流式气泡、TTS 语音播报与动作表情全程可用。
- **像素级鼠标穿透（`WS_EX_TRANSPARENT`）**：基于 50ms 实时碰撞掩码探针，仅角色与面板实体像素响应鼠标，空白区域 100% 穿透点击桌面图标与底部窗口。

### 5. 🎭 多伴侣 Live2D 自由切换
- **5 大精选内置伴侣**：深海鲸鱼娘、兔兔（茕兔）、西域舞女（玉玉）、可可女仆、冰冰龙（小小）。
- **即时无缝切换**：右键菜单一键切换伴侣，自动清理上一角色的工作锁，独立保存各自的外观、音色与映射配置。

### 6. 🎙️ 专属声线生成器与元数据纯净过滤
- **本地极速 TTS 服务（9880 端口）**：基于 `edge-tts` 与轻量音频引擎，零显存占用，带多频段实时口型同步（Lip-Sync）。
- **纯净伴侣人声**：彻底剥离 `<think>` 思考链、`Route: fast-path` 路由信息与执行用时等工程元数据，桌宠只说自然角色人话。

---

## 📦 安装与快速上手

### 依赖环境说明
本项目推荐在 **Windows 10 / 11** 环境下运行，依赖轻量 Python 运行环境：
```bash
# 进入插件根目录一键安装所有依赖
pip install -r requirements.txt
```

### 方式一：在 DeepSeek Harness 中直接安装（推荐）

```bash
# Web 模式安装
dsh plugin --profile web add github:xuemingze/dsh-girl-live2d

# 桌面端模式安装
dsh plugin --profile desktop add github:xuemingze/dsh-girl-live2d
```

### 方式二：克隆到本地目录挂载（纯相对路径）

```bash
git clone https://github.com/xuemingze/dsh-girl-live2d.git
cd dsh-girl-live2d
npm install

# 挂载到 DSH Web 或 Desktop profile
dsh plugin --profile web add "link:."
dsh plugin --profile desktop add "link:."
```

### 方式三：启动本地服务并常驻桌面

```bash
# 启动本地 9880 服务（包含 TTS 语音合成、独立桌面壳管理与系统音频感知引擎）
python voice_engine/tts_service.py --port 9880
```

---

## ⚙️ 目录结构说明

```text
dsh-girl-live2d/
├── assets/                  # 前端核心运行时（Pixi.js, Live2D Cubism, pet.js 包含 SpeechSequencer）
├── characters/              # 内置与导入的角色模型目录 (whale / tutu / yuyu / keke / xiaoxiao)
├── desktop/                 # 独立桌面常驻壳 (desktop_launcher.py - PySide6 透明穿透置顶窗口)
├── lib/                     # DSH 插件后端中枢 (index.js 意图调度与 DSH 大脑连接)
├── tools/                   # 资产分析器 (character-asset-analyzer.js) 与自动化测试脚本
├── visual_hands/            # 桌面自动化视觉协同引擎 (NCC 模板匹配)
├── voice_engine/            # 本地 TTS 服务 (tts_service.py) 与系统音频感知引擎 (audio_perception.py)
├── cordis.patch.yml         # DSH 插件挂载配置
└── package.json             # 插件元信息与脚本定义
```

---

<a id="-english-documentation"></a>

# 🇬🇧 English Documentation

## 🌟 Key Highlights in v1.1.06

### 1. 🎧 T0 Zero-CPU System Audio Perception Engine
- **Purpose**: Replaces expensive background screen capturing with passive system audio listening for games, movies, and music, reserving vision capture for explicit hotkey interactions.
- **Usage**: Automatically runs on port 9880. Monitors WASAPI loopback peak gate with 0.0% idle CPU and categorizes active media/game titles via WinRT SMTC and `pycaw`. Automatically mutes when communication apps (WeChat, Zoom, Teams, Discord) are detected.
- **Architecture**: Decoupled from the frontend avatar; structured events feed directly into the DSH brain, allowing the LLM to decide when and how to naturally react.

### 2. 🎼 SpeechSequencer & Arbitrator
- **Purpose**: Eliminates dual-audio overlap, thought vs. answer collisions, and network race conditions.
- **Mechanism**: Token-based preemption ladder (`P0 Abort` > `P1 Answer` > `P2 Poke` > `P3 Perception` > `P4 Thinking`). Asynchronous responses with stale tokens are discarded cleanly in memory.

### 3. 📐 Side-Docked Adaptive Menu
- Menu intelligently anchors to the right or left of the pet depending on screen half, with 4-corner boundary clamping to guarantee that controls are never obscured or clipped by screen edges.

---

## 📜 开源许可与致谢 / Credits & License

1. **原项目致谢 / Original Project**:
   - 感谢 **[Andersen216](https://github.com/Andersen216)** 开源优秀基座 [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d)。
2. **角色资产版权 / Character Attribution**:
   - **鲸鱼娘**：原画 [天然怠惰](https://space.bilibili.com/4456176)、模型 [ZipZipPipe](https://space.bilibili.com/4168597)、Live2D 制作 [梦梦](https://space.bilibili.com/11272072)（CC BY-NC-SA 4.0 非商业）。
   - 本项目所有 Live2D 模型素材均仅供学习交流，严禁商业用途。
3. **软件协议 / Software License**:
   - 本项目代码遵循 **MIT License** 开源。
