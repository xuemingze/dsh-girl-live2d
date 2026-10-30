# dsh-girl-live2d · Multi-Companion Live2D Desktop Pet (DeepSeek Harness)

<div align="center">

**A Multi-Companion Live2D Desktop Pet & Voice-Interactive AI Plugin for DeepSeek Harness (DSH)**

[![Version](https://img.shields.io/badge/version-1.1.07-7c5cff.svg)](https://github.com/xuemingze/dsh-girl-live2d/releases)
[![License: MIT](https://img.shields.io/badge/Code_License-MIT-green.svg)](./LICENSE)
[![Live2D Cubism](https://img.shields.io/badge/Live2D-Cubism_4%2F5-ff66a5.svg)](https://www.live2d.com/)

[**🇨🇳 Chinese Documentation (README.md)**](./README.md) • [**📦 Release Notes**](./CHANGELOG.md)

</div>

<img width="989" height="817" alt="live2d" src="https://github.com/user-attachments/assets/6e59c3df-8462-4abf-bf71-4651619e1770" />

---

> [!IMPORTANT]
> **Attribution & Acknowledgements**  
> This project is an extended and refactored evolution of [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d). It fully preserves the original DSH plugin architecture and Whale Girl baseline while upgrading to a **multi-companion Live2D ecosystem**, **independent desktop detachment with pixel-level click-through (`WinSta0\Default`)**, **an Object-Oriented (OOP) interactive voice engine**, **T0 system audio perception engine**, **unified speech arbitration (`SpeechSequencer`)**, **side-docked adaptive menu**, **prompt-driven voice design**, and **desktop visual automation**.

---

## 📖 Vision & Core Philosophy

Built upon **Andersen216/dsh-whale-girl-live2d**, this project connects high-fidelity **Live2D avatars directly to the DeepSeek Harness (DSH) AI brain**, serving as an expressive, voice-interactive ambassador:
- **Daily Companionship**: Chat directly with your Live2D companion through real-time streaming speech bubbles and dynamic voice synthesis.
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

---

### 2. 🖥️ Detached Desktop Window & Pixel-Level Click-Through
- **One-Click Detach**: Click **`[🖥️ 脱离客户端 · 独立桌面常驻]`** in the settings panel to detach the companion directly onto the Windows desktop (`WinSta0\Default`).
- **Minimize-Proof**: Even when DeepSeek Harness is minimized to the taskbar, your companion stays active and interactive on top.
- **Alpha Mask Click-Through (`WS_EX_TRANSPARENT`)**: Only opaque character and UI pixels capture mouse clicks; transparent areas allow full click-through to underlying games and windows.
- **Dock Controls**: Quick access buttons under the companion: `_` for minimize/dock, `⚙` for settings, and a bottom-right restore pill.

---

### 3. 🎭 Multi-Companion Live2D Ecosystem & Custom Model Imports
- **5 Built-In Companions**:
  - **Deep-Sea Whale Girl (`whale`)**: The classic maid companion with 52 hotkey-mapped expressions/actions, 12% water-splash Easter egg, and anti-spam rage cooldown.
  - **Tutu (`tutu`)**: Lively girl companion with rich expressions and permanent anti-watermark parameter locking.
  - **Western Dancer Yuyu (`yuyu`)**: Elegant dancer with customizable veils, eye colors, hairstyles, and accessories.
  - **Keke Maid (`keke`)**: Sweet energetic maid with bubble tea, menu, tray gestures, and multi-color hair toggles.
  - **Ice Dragon Xiaoxiao (`xiaoxiao`)**: Cute healing dragon-girl companion.
- **Custom Model Drag-and-Drop**: Import any Live2D Cubism 3/4 model with automated asset scanning and slot mapping via `character-asset-analyzer.js`.
- **In-Page Safe Deletion**: In-page modal confirm dialog eliminates OS popup freezes and safely unlinks junction symlinks on Windows.

---

### 4. 🎼 SpeechSequencer & Priority Arbitration
- Eliminates dual-audio overlap, thought vs. answer collisions, and network race conditions.
- Priority hierarchy:
  $$\text{P0 (Abort)} > \text{P1 (Answer)} > \text{P2 (Interactive Tap)} > \text{P3 (Perception)} > \text{P4 (Thinking Monologue)}$$
- Perceptions (P3) smoothly preempt thinking cues (P4), while answers (P1) always take precedence.
- Token gating prevents asynchronous network latency from cutting off new active speech.

---

### 5. 🎙️ High-Speed Local TTS & Natural Prompt Voice Design
- Zero-VRAM local speech synthesis on port `9880` powered by `edge-tts` with multi-frequency Lip-Sync.
- Generate voice pitch, speed, and timbre directly from natural-language descriptions.
- Automatically strips `<think>` chains and DSH system routing metadata to ensure clean, in-character vocal output.

---

### 6. 📐 Side-Docked Adaptive Menu & Boundary Clamping
- Intelligently anchors to the right or left of the character depending on the screen half.
- 4-corner boundary clamping ensures buttons and settings never clip beyond screen edges.

---

## 📦 Installation & Quick Start

### 1. Requirements
Recommended for **Windows 10 / 11** with Python 3.10+:
```bash
# Install all required Python packages
pip install -r requirements.txt
```

### 2. Option A: Install via DeepSeek Harness (Recommended)
```bash
# For Web Profile
dsh plugin --profile web add github:xuemingze/dsh-girl-live2d

# For Desktop Profile
dsh plugin --profile desktop add github:xuemingze/dsh-girl-live2d
```

### 3. Option B: Local Clone & Link
```bash
git clone https://github.com/xuemingze/dsh-girl-live2d.git
cd dsh-girl-live2d
npm install
pip install -r requirements.txt

dsh plugin --profile web add "link:."
dsh plugin --profile desktop add "link:."
```

### 4. Option C: Start Local Background Service
```bash
python voice_engine/tts_service.py --port 9880
```

---

## 📜 Credits & License

1. **Original Project Attribution**:
   - Special thanks to **[Andersen216](https://github.com/Andersen216)** for the baseline [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d).
2. **Character Assets**:
   - **Whale Girl**: Illustration by [天然怠惰](https://space.bilibili.com/4456176), Model by [ZipZipPipe](https://space.bilibili.com/4168597), Live2D by [梦梦](https://space.bilibili.com/11272072) (CC BY-NC-SA 4.0 Non-Commercial).
   - All Live2D models in this repository are for educational and non-commercial research use only.
3. **Software License**:
   - Code is licensed under the **MIT License**.
