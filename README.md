# dsh-girl-live2d · Live2D 多伴侣桌宠插件 / Multi-Companion Live2D Desktop Pet (DeepSeek Harness)

<div align="center">

**面向 DeepSeek Harness (DSH) Web 与桌面环境的 Live2D 多伴侣桌宠与 AI 交互增强插件**  
**A Multi-Companion Live2D Desktop Pet & Voice-Interactive AI Plugin for DeepSeek Harness (DSH)**

[![Version](https://img.shields.io/badge/version-1.0.16-7c5cff.svg)](https://github.com/xuemingze/dsh-girl-live2d/releases)
[![License: MIT](https://img.shields.io/badge/Code_License-MIT-green.svg)](./LICENSE)
[![Live2D Cubism](https://img.shields.io/badge/Live2D-Cubism_4%2F5-ff66a5.svg)](https://www.live2d.com/)

[**🇨🇳 中文文档**](#-功能特性) • [**🇬🇧 English (In-Page)**](#-english-documentation) • [**🇬🇧 README_EN.md**](./README_EN.md) • [**📦 Release Notes**](./CHANGELOG.md)

</div>

---

> [!IMPORTANT]
> **声明与致谢 / Attribution & Acknowledgements**  
> 本项目基于原开源项目 [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 进行深度扩展与重构。在完整保留原项目优秀的 DSH 插件挂载架构、深海鲸鱼娘基准交互与工作简报机制的基础上，全面升级为**多伴侣 Live2D 体系**、**脱离客户端独立桌面常驻渲染（Windows 原生透明穿透壳）**、**面向对象（OOP）点击与工作状态语音交互引擎**、**动态资产分析器**、**提示词专属声线生成器**与**桌面视觉协同**。  
> *This project is an extended and refactored evolution of [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d), preserving the original DSH plugin architecture and Whale Girl baseline while introducing a multi-companion Live2D ecosystem, independent desktop detachment with pixel-level click-through, an OOP voice/tap engine, dynamic model asset analysis, natural-language voice synthesis, and desktop visual automation.*

---

## 🌟 功能特性

### 1. 🖥️ 脱离客户端 · 独立桌面常驻渲染 (v1.0.16 新增)
- **一键跳出客户端**：在桌宠「设置」面板「宿主」行点击 **`[🖥️ 脱离客户端 · 独立桌面常驻]`**，即可将伴侣从 DSH 客户端窗口剥离，直接常驻于 Windows 系统桌面上。
- **客户端最小化无感联通**：即使将 DSH 软件最小化，角色依然保留在桌面最前端；点击互动、发起对话、流式气泡、TTS 语音播报与动作表情全程可用，且对话时客户端保持后台隐藏、绝不弹窗抢焦点。
- **像素级鼠标穿透（`WS_EX_TRANSPARENT`）**：基于 50ms 实时碰撞掩码探针，仅角色与面板实体像素响应鼠标，空白区域 100% 穿透点击桌面图标与底部窗口。
- **共生守护与一键收回**：内置 500ms 宿主进程 PID 探针与心跳检测，**客户端关闭时独立桌面渲染自动秒关**；支持通过客户端右下角悬浮胶囊或设置面板 **`[📥 收回至客户端渲染]`** 随时无缝收回。

### 2. 🎭 多伴侣 Live2D 自由切换
- **5 大精选内置伴侣**：
  - **深海鲸鱼娘**（默认基准）：经典女仆形象，完整保留 52 键位表情动作库、12% 鲸鱼喷水彩蛋与防炸毛机制。
  - **兔兔（茕兔）**：活泼可爱萝莉少女，拥有丰富的表情与动作交互，内置防盗版参数常驻锁定防御。
  - **西域舞女（玉玉）**：异域风情高冷御姐，支持数十种服饰、头纱、瞳色、发型部件替换与舞动。
  - **可可女仆**：元气甜美女仆，支持奶茶、菜单、餐盘手势与多色发型装扮。
  - **冰冰龙（小小）**：软萌治愈系龙娘伴侣。
- **即时无缝切换**：右键菜单一键切换伴侣，自动清理上一角色的工作锁（`workHold`），动态更新气泡专属署名，并独立保存各自的外观、音色与映射配置。

### 3. 👆 面向对象 (OOP) 点击体系与工作状态交互语音
- **全状态人声反馈**：不仅支持摸头/戳身子点击语音，在 AI **「思考中（Thinking）」** 与 **「看资料/调工具（Reading/Tool）」** 阶段也会自动触发各角色专属风格台词与人声播报。
- **动作标志语双轨解析引擎**：支持在台词中编写 `（歪头）`、`（眼睛发亮）` 等动作标志语——**气泡内完整展示文字并自动联动对应 Live2D 表情，TTS 语音合成时自动剥离括号动作词**，只朗读纯净人声台词。
- **「👆 点击」专属交互面板**：支持独立开关点击语音、实时双轨预览、自定义点击台词添加/删除，以及一键演练「思考中」与「看资料」状态。

### 4. 🧩 智能动态资产分析与第三方角色导入/删除
- **新模型导入即用**：支持直接导入任意 Live2D Cubism 3/4 模型（`.zip` 压缩包或模型文件夹）。
- **内置 `character-asset-analyzer.js` 资产分析引擎**：递归扫描 `.model3.json`、`.cdi3.json`、`.vtube.json`，智能分类至 **装饰（decor）**、**场景（scene）**、**动作（action）**、**表情（emotion）** 四大维度，并自动推导标准情绪槽位映射。
- **动作试看自动唤醒（Idle Resurrection）**：试看一次性动作结束后自动恢复待机呼吸循环，彻底解决模型卡死或肢体隐身问题。

### 5. 🎙️ 专属声线生成器与思考链过滤伴读
- **本地极速 TTS 服务（9880 端口）**：基于 `edge-tts` 与轻量音频引擎，零显存占用，带实时口型同步（Lip-Sync）。
- **自然语言生成专属声线**：在「伴侣发声」面板输入自然语言描述（如*“元气甜美活泼少女，语调轻快”*或*“冷艳高冷成熟御姐”*），自动解析匹配基座音色并调节语速与音调；同时支持导入本地参考音频池（`.wav` / `.mp3`）。
- **思考链彻底过滤（`<think>` 剥离）**：自动过滤 DeepSeek-R1 / V3 的 `<think>` 推理过程，气泡流式输出与语音伴读仅播报最终清爽答复，信封简报不被思考草稿污染。

### 6. 🛡️ Live2D 四重闭环去水印与防盗版参数锁定
- 针对部分模型将水印参数（如 `Param123` / `sy.exp3.json`）与本体透明度反向绑定的机制，通过 **配置层 (`defaultParams`) + 动作层 + 渲染管线层 (`beforeModelUpdate` 每帧强锁) + 纹理层** 四重闭环，实现本体 100% 显现且水印永久隐藏。

---

## 📦 安装与快速上手

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

### 方式三：启动语音合成与独立桌面桥接服务

```bash
# 1. 安装 Python 依赖（TTS 声带引擎 + Windows 独立桌面壳）
pip install edge-tts soundfile PySide6

# 2. 启动本地 9880 服务
python voice_engine/tts_service.py
```

### 方式四：独立预览模式（无需 DSH 宿主）

```bash
npm run preview
```
浏览器访问：[http://127.0.0.1:5199/dsh-pet/standalone](http://127.0.0.1:5199/dsh-pet/standalone)

---

## ⚙️ 目录结构说明

```text
dsh-girl-live2d/
├── assets/                  # 前端核心运行时（Pixi.js, Live2D Cubism, pet.js）
├── characters/              # 内置与导入的角色模型目录 (whale / tutu / yuyu / keke / xiaoxiao)
├── desktop/                 # 独立桌面常驻壳 (desktop_launcher.py - PySide6 透明穿透置顶窗口)
├── lib/                     # DSH 插件后端中间件与路由 (index.js)
├── tools/                   # 资产分析器 (character-asset-analyzer.js) 与自动化测试脚本
├── visual_hands/            # 桌面自动化视觉协同引擎 (NCC 模板匹配)
├── voice_engine/            # 本地 TTS 声带服务 (tts_service.py:9880) 与独立桌面跨桌面拉起桥
├── cordis.patch.yml         # DSH 插件挂载配置
└── package.json             # 插件元信息与脚本定义
```

---

<a id="-english-documentation"></a>

# 🇬🇧 English Documentation

## 🌟 Key Features

### 1. 🖥️ Independent Desktop Detachment & Always-on-Top Shell (`v1.0.16`)
- **One-Click Detach from Client**: Click **`[🖥️ 脱离客户端 · 独立桌面常驻]`** in the Settings panel (`Host` row) to pop the Live2D companion out of the DSH client window directly onto your native Windows desktop (`WinSta0\Default`).
- **Minimize-Resilient & Background Dialogue**: Minimize the DSH client at any time—the companion stays on your desktop with full click interaction, chat input, streaming speech bubbles, TTS voice playback, and Live2D animations while the DSH client remains hidden in the background without stealing focus.
- **Pixel-Level Click-Through (`WS_EX_TRANSPARENT`)**: Powered by a 50ms alpha hit-mask probe and dynamic `HWND` tracking, mouse clicks pass straight through empty space to desktop icons and background apps, while hovering over the character or dock seamlessly restores interactivity.
- **Host Lifecycle Watchdog & Instant Recall**: Built-in 500ms host PID monitor (`OpenProcess`) + HTTP heartbeat ensures the desktop window closes immediately when the DSH client exits. Recall the companion back into the client anytime via the bottom-right restore pill or Settings button.

### 2. 🎭 Multi-Companion Live2D Ecosystem
- **5 Built-In Companions**:
  - **Deep-Sea Whale Girl (`whale`)**: The classic maid companion with 52 hotkey-mapped expressions/actions, 12% water-splash Easter egg, and anti-spam rage cooldown.
  - **Tutu (`tutu`)**: Lively girl companion with rich expressions and permanent anti-watermark parameter locking.
  - **Western Dancer Yuyu (`yuyu`)**: Elegant dancer with dozens of customizable veils, eye colors, hairstyles, and props.
  - **Keke Maid (`keke`)**: Sweet energetic maid with bubble tea, menu, tray gestures, and multi-color hair toggles.
  - **Ice Dragon Xiaoxiao (`xiaoxiao`)**: Cute healing dragon-girl companion.
- **Seamless Switching**: Switch characters on the fly via the right-click menu. Automatically clears stale `workHold` locks, updates bubble headers dynamically, and persists per-character outfits, voices, and mappings.

### 3. 👆 Object-Oriented (OOP) Tap & Work-State Voice Engine
- **Full-Lifecycle Voice Feedback**: Characters speak not only when patted or poked, but also automatically vocalize character-specific lines when the AI enters **Thinking (`thinking`)** or **Reading/Tool Execution (`tool`)** states.
- **Dual-Track Action Cue Parser**: Supports stage directions like `（tilts head）` or `（eyes sparkle）` in dialogue lines—**displayed in full inside speech bubbles while automatically triggering matching Live2D expressions and stripped from TTS audio synthesis** for clean vocal playback.
- **Dedicated `👆 Click` Menu Tab**: Toggle click voice, preview dual-track bubble vs. voice output in real time, add/delete custom tap lines, and test Thinking/Reading states with one click.

### 4. 🧩 Smart Asset Analyzer & Custom Model Import/Delete
- **Drag-and-Drop Custom Models**: Import any Live2D Cubism 3/4 model (`.zip` archive or folder).
- **Automated Categorization (`character-asset-analyzer.js`)**: Recursively scans `.model3.json`, `.cdi3.json`, and `.vtube.json` to classify assets into **Decor**, **Scene**, **Action**, and **Emotion**, automatically mapping standard emotion slots and recovering idle breathing (`Idle Resurrection`) after one-shot motions.

### 5. 🎙️ Prompt-to-Voice Generator & `<think>` Chain Filtering
- **Zero-VRAM Local TTS Service (Port `9880`)**: Built on `edge-tts` with real-time Lip-Sync.
- **Natural-Language Voice Design**: Describe the desired voice in plain text (e.g., *"sweet energetic young girl, upbeat tone"* or *"cool mature sister"*) to automatically configure base voice, rate, and pitch, or select from local reference audio files (`.wav` / `.mp3`).
- **Clean Reasoning Filter**: Automatically strips `<think>`, `<thought>`, and `<reasoning>` blocks from DeepSeek-R1/V3 responses so speech bubbles, voice narration, and task briefings only present the final polished answer.

---

## 🚀 Installation & Quick Start

### Option 1: Install Directly via DSH CLI (Recommended)

```bash
# For DSH Web UI
dsh plugin --profile web add github:xuemingze/dsh-girl-live2d

# For DSH Desktop App
dsh plugin --profile desktop add github:xuemingze/dsh-girl-live2d
```

### Option 2: Clone Locally & Link (Relative Path)

```bash
git clone https://github.com/xuemingze/dsh-girl-live2d.git
cd dsh-girl-live2d
npm install

dsh plugin --profile web add "link:."
dsh plugin --profile desktop add "link:."
```

### Option 3: Start the Voice & Desktop Detachment Service

```bash
# 1. Install Python dependencies (TTS engine + PySide6 desktop shell)
pip install edge-tts soundfile PySide6

# 2. Start the local service on port 9880
python voice_engine/tts_service.py
```

---

## 🤝 开源致谢与版权声明 / Credits & License

1. **原项目致谢 / Original Project**:
   - 感谢 **[Andersen216](https://github.com/Andersen216)** 开源了出色的 [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 项目。
   - Special thanks to **[Andersen216](https://github.com/Andersen216)** for the original [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) project.
2. **社区灵感与关键技术致谢 / Community Inspiration & Technical Credits**:
   - 感谢 **[TaurusWood/dsh-plugin-appshot](https://github.com/TaurusWood/dsh-plugin-appshot)**：致敬其卓越的“前台活动窗口靶向精准截取”与“反向防自捕获（Anti-Self-Capture）”设计哲学，为本项目的轻量视觉感官神经提供了极具启发性的架构参考与无缝生态联动。
   - 感谢 **桌面灵 (zhuomianling)** 项目：致敬其高效轻量的 32×18 RGB 散列差分变动检测（ScreenChangeDetector）算法设计，为避免盲目高频截屏提供了优雅的工程参考。
3. **角色与美术资产授权 / Character & Artwork Attribution**:
   - **鲸鱼娘 (Whale Girl)**：形象原作 [上善无形](https://space.bilibili.com/4456176)「溟月」；二次设计 [ZipZipPipe](https://space.bilibili.com/4168597)；Live2D 制作 [氵六青](https://space.bilibili.com/11272072)（CC BY-NC-SA 4.0，非商业使用 / Non-Commercial）。
   - **Live2D 模型资产 / Model Assets**：仅供非商业交流、技术学习与个人娱乐使用，禁止用于任何商业用途。All Live2D model assets are strictly for non-commercial, educational, and personal use only.
3. **软件许可证 / Software License**:
   - 本项目代码部分遵循 **MIT License**。Code is licensed under the **MIT License**.
