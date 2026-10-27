# dsh-girl-live2d · Live2D 多伴侣桌宠插件 (DeepSeek Harness)

<div align="center">

**面向 DeepSeek Harness (DSH) Web 与桌面环境的 Live2D 多伴侣桌宠与 AI 交互增强插件**

[功能特性](#-功能特性) • [安装与快速上手](#-安装与快速上手) • [伴侣角色与模型](#-伴侣角色与模型) • [声带服务与伴读](#-声带服务与伴读) • [开源声明与致谢](#-开源声明与致谢)

</div>

---

> [!IMPORTANT]
> **声明与致谢**：本项目基于原开源项目 [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 进行深度扩展与重构。继承了原项目优秀的 DSH 插件挂载架构与工作简报机制，在此基础上全面升级为**多伴侣 Live2D 体系**、**动态资产分析引擎**、**提示词专属声线生成器**、**对话语音伴读**与**桌面视觉协同**。

---

## 🌟 功能特性

### 1. 🎭 多伴侣 Live2D 自由切换
- **5 大精选内置伴侣**：
  - **深海鲸鱼娘**（默认）：经典女仆形象，完整的情绪与动作库。
  - **兔兔（茕兔）**：活泼可爱萝莉少女，具有丰富的表情与动作交互，内置防盗版参数常驻锁定防御。
  - **西域舞女（玉玉）**：异域风情高冷御姐，支持数十种服饰发型部件替换与舞动。
  - **可可女仆**：元气甜美女仆，支持多种餐盘手势与发型装扮。
  - **冰冰龙（小小）**：软萌治愈系龙娘伴侣。
- **即时无缝切换**：右键菜单一键切换伴侣，独立保存各自的外观、音色与映射配置。

### 2. 🧩 智能动态资产分析与第三方角色导入/删除
- **新模型拖拽/导入即用**：支持导入任意 Live2D Cubism 3/4 模型（支持 `.zip` 压缩包与解压文件夹）。
- **内置 `character-asset-analyzer.js` 资产分析引擎**：
  - 递归扫描模型目录与文件引用（`.model3.json`、`.cdi3.json`、`.vtube.json`）。
  - 自动提取中英文参数名、动作组与表情文件。
  - 智能分类至四大维度：**装饰（decor）**、**场景（scene）**、**动作（action）**、**表情（emotion）**。
  - 自动推导标准情绪映射（happy, love, angry, sad, shy, sleepy, excited 等）与动作槽位（idle, click, done）。
- **角色管理**：支持右键菜单一键删除已导入的自定义角色。

### 3. 🎯 可视化表情与动作映射面板
- **标准化映射体系**：以鲸鱼娘的标准表情与动作为参照基准，新导入角色自动对齐标准情感槽位。
- **可视化点播与试看**：
  - 实时表情/动作点播，支持动作试看并具备自动缩放与防遮挡排版。
  - 动作试看结束后自动唤醒循环待机（Idle Resurrection），彻底解决模型卡死或肢体隐身问题。

### 4. 🎙️ 专属声线生成器与双轨对话伴读
- **本地极速 TTS 服务（9880 端口）**：基于 `edge-tts` 与轻量音频引擎，零显存负担。
- **自然语言提示词生成专属声线**：
  - 可在右键“伴侣发声”菜单中直接填写自然语言描述（如“元气甜美活泼少女，语调轻快”或“冷艳高冷成熟御姐”），AI 自动解析匹配基座音色并调节语速与音调。
- **本地参考音频音色池**：支持导入本地参考音频文件（`.wav` / `.mp3`），即选即用。
- **DeepSeek 对话实时伴读**：DeepSeek 回复流式结束时伴侣自动语音播报，支持音量滑块调节并消除了输出重音。

### 5. 🛡️ Live2D 闭环防盗版与水印参数锁定
- 针对部分模型将水印参数（如 `Param123` / `sy.exp3.json`）与本体透明度反向绑定的陷阱，在渲染管线每帧必经路径通过 `beforeModelUpdate` 强保常驻参数，实现无水印且模型本体完整显现。

### 6. 🖐️ 桌面自动化视觉协同（Visual Hands）
- 集成轻量化 PIL + NumPy 向量化 NCC 模板匹配与键鼠执行引擎，毫秒级定位桌面图标与按钮。

---

## 📦 安装与快速上手

与原 `dsh-whale-girl-live2d` 插件保持一致，完全采用**相对路径**（或由 DSH 自动管理），支持任意无空格无中文路径。

### 方式一：在 DeepSeek Harness 中直接安装（推荐）

打开终端，执行以下命令安装插件（自动克隆到 DSH 插件目录并启用）：

```bash
dsh plugin --profile web add github:xuemingze/dsh-girl-live2d
```

### 方式二：克隆或下载到本地任意目录安装（进入下载目录后使用相对路径）

1. 克隆或下载代码到任意本地路径：
```bash
git clone https://github.com/xuemingze/dsh-girl-live2d.git
cd dsh-girl-live2d
npm install
```

2. 进入下载目录后，通过相对路径 link 挂载到 DSH：
```bash
dsh plugin --profile web add "link:."
```
> 也可以在上一级目录执行：`dsh plugin --profile web add "link:./dsh-girl-live2d"`

3. 重启或刷新 DSH Web 界面即可看到桌宠。

### 方式三：独立预览模式（无需 DSH 即可直接体验）

如果只想单独体验桌宠和调试模型，可使用内置轻量预览服务器：

```bash
# 在下载目录下执行
npm run preview
```
在浏览器中打开：
- 独立桌宠体验页：[http://127.0.0.1:5199/dsh-pet/standalone](http://127.0.0.1:5199/dsh-pet/standalone)
- 预览页面：[http://127.0.0.1:5199/dsh-pet/](http://127.0.0.1:5199/dsh-pet/)

---

## 🔊 启动伴侣声带服务（TTS）

桌宠的声音合成与伴读功能依赖本地轻量 TTS 引擎：

1. **安装 Python 依赖**：
```bash
pip install edge-tts soundfile
```

2. **在项目目录下启动声带服务**：
```bash
python voice_engine/tts_service.py
```
服务将在 `http://127.0.0.1:9880` 启动，提供毫秒级语音合成与音色生成支持。

---

## ⚙️ 目录结构说明

```text
dsh-girl-live2d/
├── assets/                  # 前端核心运行时（Pixi.js, Live2D Cubism, pet.js）
├── characters/              # 内置与导入的角色模型目录
│   ├── whale/               # 鲸鱼娘
│   ├── tutu/                # 兔兔（茕兔）
│   ├── yuyu/                # 西域舞女
│   ├── keke/                # 可可女仆
│   └── xiaoxiao/            # 冰冰龙
├── lib/                     # DSH 插件后端中间件与路由 (index.js)
├── tools/                   # 资产分析器 (character-asset-analyzer.js) 与调试工具
├── visual_hands/            # 桌面自动化视觉执行引擎
│   └── samples/             # 视觉匹配模板相对目录
├── voice_engine/            # 本地 TTS 声带引擎与语音客户端
│   ├── tts_service.py       # 9880 HTTP 语音合成服务端
│   ├── tts_client.js        # 前端音频播放与伴读控制器
│   └── voices_pool/         # 本地参考音频池相对目录
├── cordis.patch.yml         # DSH 插件配置文件（支持相对路径挂载）
└── package.json             # 插件元信息与脚本定义
```

---

## 🤝 开源致谢与版权声明

1. **原项目致谢**：
   - 感谢 **[Andersen216](https://github.com/Andersen216)** 开源了出色的 [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 项目。
2. **角色与美术资产授权**：
   - **鲸鱼娘**：形象原作 [上善无形](https://space.bilibili.com/4456176)「溟月」；二次设计 [ZipZipPipe](https://space.bilibili.com/4168597)；Live2D 制作 [氵六青](https://space.bilibili.com/11272072)。
   - **Live2D 模型文件** 仅供非商业交流、技术学习与个人娱乐使用，禁止用于任何商业用途。
3. **软件许可证**：
   - 本项目代码部分遵循 **MIT License**。
