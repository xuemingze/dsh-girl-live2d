# dsh-girl-live2d · Multi-Companion Live2D Desktop Pet (DeepSeek Harness)

<div align="center">

**A Multi-Companion Live2D Desktop Pet & Voice-Interactive AI Plugin for DeepSeek Harness (DSH)**

[![Version](https://img.shields.io/badge/version-1.0.16-7c5cff.svg)](https://github.com/xuemingze/dsh-girl-live2d/releases)
[![License: MIT](https://img.shields.io/badge/Code_License-MIT-green.svg)](./LICENSE)
[![Live2D Cubism](https://img.shields.io/badge/Live2D-Cubism_4%2F5-ff66a5.svg)](https://www.live2d.com/)

[**🇨🇳 中文文档 (README.md)**](./README.md) • [**📦 Changelog**](./CHANGELOG.md)

</div>

---

> [!IMPORTANT]
> **Attribution & Acknowledgements**  
> This project is an extended and refactored evolution of [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d). It preserves the original DSH plugin architecture, Whale Girl baseline interactions, and task briefing mechanism while upgrading to a **multi-companion Live2D ecosystem**, **independent desktop detachment with pixel-level click-through (`WinSta0\Default`)**, **an Object-Oriented (OOP) tap & work-state voice engine**, **dynamic model asset analysis**, **natural-language voice synthesis**, and **desktop visual automation**.

---

## 🌟 Key Features

### 1. 🖥️ Independent Desktop Detachment & Always-on-Top Shell (`v1.0.16`)
- **One-Click Detach from Client**: Click **`[🖥️ 脱离客户端 · 独立桌面常驻]`** in the Settings panel (`Host` row) to pop the Live2D companion out of the DSH client window directly onto your native Windows desktop (`WinSta0\Default`).
- **Minimize-Resilient & Background Dialogue**: Minimize the DSH client at any time—the companion stays on your desktop with full click interaction, chat input, streaming speech bubbles, TTS voice playback, and Live2D animations while the DSH client remains hidden in the background without stealing focus.
- **Pixel-Level Click-Through (`WS_EX_TRANSPARENT`)**: Powered by a 50ms alpha hit-mask probe and dynamic `HWND` tracking, mouse clicks pass straight through empty space to desktop icons and background apps, while hovering over the character or dock seamlessly restores interactivity.
- **Host Lifecycle Watchdog & Instant Recall**: Built-in 500ms host PID monitor (`OpenProcess`) + HTTP heartbeat ensures the desktop window closes immediately when the DSH client exits. Recall the companion back into the client anytime via the bottom-right restore pill or Settings button (`[📥 收回至客户端渲染]`).

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
- **Dual-Track Action Cue Parser**: Supports stage directions like `（歪头）` or `（眼睛发亮）` in dialogue lines—**displayed in full inside speech bubbles while automatically triggering matching Live2D expressions and stripped from TTS audio synthesis** for clean vocal playback.
- **Dedicated `👆 Click` Menu Tab**: Toggle click voice, preview dual-track bubble vs. voice output in real time, add/delete custom tap lines, and test Thinking/Reading states with one click.

### 4. 🧩 Smart Asset Analyzer & Custom Model Import/Delete
- **Drag-and-Drop Custom Models**: Import any Live2D Cubism 3/4 model (`.zip` archive or folder).
- **Automated Categorization (`character-asset-analyzer.js`)**: Recursively scans `.model3.json`, `.cdi3.json`, and `.vtube.json` to classify assets into **Decor**, **Scene**, **Action**, and **Emotion**, automatically mapping standard emotion slots and recovering idle breathing (`Idle Resurrection`) after one-shot motions.

### 5. 🎙️ Prompt-to-Voice Generator & `<think>` Chain Filtering
- **Zero-VRAM Local TTS Service (Port `9880`)**: Built on `edge-tts` with real-time Lip-Sync.
- **Natural-Language Voice Design**: Describe the desired voice in plain text (e.g., *"sweet energetic young girl, upbeat tone"* or *"cool mature sister"*) to automatically configure base voice, rate, and pitch, or select from local reference audio files (`.wav` / `.mp3`).
- **Clean Reasoning Filter**: Automatically strips `<think>`, `<thought>`, and `<reasoning>` blocks from DeepSeek-R1/V3 responses so speech bubbles, voice narration, and task briefings only present the final polished answer.

### 6. 🛡️ 4-Layer Anti-Watermark & Parameter Lock
- Prevents inverse-opacity watermark traps (such as `Param123` / `sy.exp3.json`) via a 4-layer lock across `character.json` (`defaultParams`), idle motion curves, `beforeModelUpdate` per-frame parameter enforcement, and texture alpha zeroing.

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

### Option 4: Standalone Preview Mode (Without DSH Host)

```bash
npm run preview
```
Open in browser: [http://127.0.0.1:5199/dsh-pet/standalone](http://127.0.0.1:5199/dsh-pet/standalone)

---

## ⚙️ Directory Structure

```text
dsh-girl-live2d/
├── assets/                  # Frontend runtime (Pixi.js, Live2D Cubism, pet.js)
├── characters/              # Built-in & imported character models (whale / tutu / yuyu / keke / xiaoxiao)
├── desktop/                 # Independent desktop shell (desktop_launcher.py - PySide6 transparent topmost window)
├── lib/                     # DSH plugin backend middleware & HTTP/SSE routes (index.js)
├── tools/                   # Asset analyzer (character-asset-analyzer.js) & test scripts
├── visual_hands/            # Desktop visual automation engine (NCC template matching)
├── voice_engine/            # Local TTS voice server (tts_service.py:9880) & desktop launcher bridge
├── cordis.patch.yml         # DSH plugin mount manifest
└── package.json             # Package metadata & scripts
```

---

## 🤝 Credits & License

1. **Original Project**:
   - Special thanks to **[Andersen216](https://github.com/Andersen216)** for open-sourcing [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d).
2. **Character & Artwork Attribution**:
   - **Whale Girl**: Original character design by [上善无形](https://space.bilibili.com/4456176) ("Mingyue"); Maid redesign by [ZipZipPipe](https://space.bilibili.com/4168597); Live2D rigging & animation by [氵六青](https://space.bilibili.com/11272072) (CC BY-NC-SA 4.0, Non-Commercial).
   - **Live2D Model Assets**: Provided strictly for non-commercial communication, technical learning, and personal entertainment. Commercial use is prohibited.
3. **Software License**:
   - The source code of this project is licensed under the **MIT License**.
