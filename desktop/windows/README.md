# 桌面版（Windows）· Desktop shell for Windows

> **和 macOS 版是同一个东西的两个平台实现**：她本身还是那份 DSH 插件
> （模型、联动、菜单、钱包全在插件里），这里只是一个**透明、无边框、永远置顶**的窗口，
> 加载插件提供的那一页。

---

> ⚠️ **重要：请解压到「纯英文、不含空格」的路径**
>
> 例如纯英文无空格目录 ✅；含空格、含中文路径 ❌ —— 后两种情况目前在部分机器上会**双击即闪退**
> （退出码 `0x80000003`，Electron 在创建 userData 之前就崩，详见
> [Issue #6](https://github.com/Andersen216/dsh-whale-girl-live2d/issues/6)）。
> 换到纯英文无空格路径即可正常使用。

### 启动不了？先双击 `run-with-fallback.cmd`

如果双击 `DS-WhaleGirl-Pet.exe` **没有任何反应**（没窗口、没托盘、没日志），
在同一个文件夹里双击 **`run-with-fallback.cmd`** —— 它会依次用
「常规 → 禁用 GPU → 禁用 GPU+沙箱 → 软件渲染」四种方式重试，
把每次的退出码写进 `%APPDATA%\ds-whale-girl-pet\launcher.log`，
并告诉你哪种能跑起来。

## 怎么装（三步，不用开命令行）

**① 先装插件**（在 DSH 里，任选一种）

```bash
dsh plugin --profile web add github:xuemingze/dsh-girl-live2d
```

或者进入本地下载目录直接 link：
```bash
dsh plugin --profile web add "link:."
```

**② 下载客户端**

到 [Releases](https://github.com/xuemingze/dsh-girl-live2d/releases) 下载 Windows 桌面端：

- **解压到任意纯英文无空格目录**
- **双击里面的 `DS 鲸鱼娘桌宠.exe`** —— 免安装
- 想常驻就右键那个 exe →「发送到」→「桌面快捷方式」；再右键快捷方式 →「固定到开始屏幕」
