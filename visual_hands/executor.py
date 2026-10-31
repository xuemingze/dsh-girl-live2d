"""
visual_mcp/executor.py - 桌面自动化执行器
专注执行桌面视觉与键鼠操作：
- 坐标点击与拖拽
- 模板图像搜索点击
- 桌面图标快捷方式双击/启动
- 视觉工作流自动化执行
- 屏幕截图
"""
import os
import sys
import time
import json
import subprocess
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional

import pyautogui
from PIL import Image

try:
    from visual_hands.matcher import locate_template
except ImportError:
    from matcher import locate_template

logger = logging.getLogger("visual_executor")

WORKFLOWS_PATH = Path.home() / "桌面自动化助手" / "workflows.json"
PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SAMPLES_DIR = Path(os.environ.get("DSH_SAMPLES_DIR", PACKAGE_ROOT / "visual_hands" / "samples"))


class VisualExecutor:
    """桌面视觉与键鼠执行引擎"""

    def __init__(self, samples_dir: Optional[Path] = None):
        self.samples_dir = samples_dir or SAMPLES_DIR

    def resolve_template_path(self, template_name: str) -> Optional[Path]:
        """按名称在 samples 目录或工作区搜索模板文件"""
        p = Path(template_name)
        if p.is_absolute() and p.exists():
            return p

        # 检查 samples 目录
        cand = self.samples_dir / template_name
        if cand.exists():
            return cand
        if not template_name.endswith(".png"):
            cand_png = self.samples_dir / f"{template_name}.png"
            if cand_png.exists():
                return cand_png

        # 模糊查找
        for f in self.samples_dir.glob("*.png"):
            if template_name.lower() in f.stem.lower():
                return f

        return None

    def click_template(self, template_name: str, confidence: float = 0.7, clicks: int = 1) -> Dict[str, Any]:
        """寻找屏幕上的模板图像并点击"""
        t_path = self.resolve_template_path(template_name)
        if not t_path:
            return {"success": False, "message": f"未找到模板图片: {template_name}"}

        match = locate_template(str(t_path), confidence=confidence)
        if not match:
            return {
                "success": False,
                "message": f"在当前屏幕上未匹配到模板 [{t_path.name}] (置信度阈值: {confidence})"
            }

        cx, cy, w, h, score = match
        pyautogui.click(cx, cy, clicks=clicks)
        return {
            "success": True,
            "message": f"成功命中模板 [{t_path.name}]，置信度 {score:.2f}，已点击坐标 ({cx}, {cy})",
            "x": cx,
            "y": cy,
            "confidence": score
        }

    def click_coords(self, x: int, y: int, button: str = "left", clicks: int = 1) -> Dict[str, Any]:
        """直接点击物理坐标"""
        pyautogui.click(x=x, y=y, button=button, clicks=clicks)
        return {"success": True, "message": f"已在屏幕坐标 ({x}, {y}) 执行 {button} 键点击 {clicks} 次"}

    def launch_shortcut(self, name_or_path: str) -> Dict[str, Any]:
        """启动快捷方式或可执行文件"""
        p = Path(name_or_path)
        if p.exists():
            if hasattr(os, "startfile"):
                os.startfile(str(p))
            else:
                subprocess.Popen([str(p)], shell=False)
            return {"success": True, "message": f"已启动文件: {p}"}

        # 检查常见桌面或快捷方式
        desktop_dir = Path.home() / "Desktop"
        for item in desktop_dir.glob("*"):
            if name_or_path.lower() in item.stem.lower():
                os.startfile(str(item))
                return {"success": True, "message": f"已启动桌面快捷方式: {item.name}"}

        return {"success": False, "message": f"未找到匹配的快捷方式或程序: {name_or_path}"}

    def list_workflows(self) -> List[Dict[str, Any]]:
        """列出已录入的所有工作流"""
        if not WORKFLOWS_PATH.exists():
            return []
        try:
            with open(WORKFLOWS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            return [{"id": k, "name": v.get("name", k), "description": v.get("description", ""), "step_count": len(v.get("steps", []))} for k, v in data.items()]
        except Exception as e:
            logger.error(f"读取工作流失败: {e}")
            return []

    def run_workflow(self, workflow_name: str) -> Dict[str, Any]:
        """按名称执行已配置的视觉自动化工作流"""
        if not WORKFLOWS_PATH.exists():
            return {"success": False, "message": "工作流配置文件不存在"}

        try:
            with open(WORKFLOWS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            return {"success": False, "message": f"读取工作流异常: {e}"}

        target_wf = None
        for k, v in data.items():
            if k == workflow_name or v.get("name") == workflow_name:
                target_wf = v
                break

        if not target_wf:
            return {"success": False, "message": f"未找到名为 '{workflow_name}' 的工作流"}

        steps = target_wf.get("steps", [])
        logs = []
        logs.append(f"开始执行工作流: {target_wf.get('name', workflow_name)} (共 {len(steps)} 步)")

        for idx, step in enumerate(steps):
            if not step.get("enabled", True):
                continue
            stype = step.get("type", "")
            sname = step.get("name", stype)
            params = step.get("params", {})
            logs.append(f"[{idx+1}/{len(steps)}] 执行步骤: {sname} ({stype})")

            try:
                if stype == "launch_app":
                    app_path = params.get("path", "")
                    if app_path and Path(app_path).exists():
                        if hasattr(os, "startfile"):
                            os.startfile(str(app_path))
                        else:
                            subprocess.Popen([str(app_path)], shell=False)
                        logs.append(f"  -> 已拉起程序: {app_path}")
                    else:
                        logs.append(f"  -> 程序路径不存在: {app_path}")
                elif stype == "wait":
                    sec = params.get("seconds", 1)
                    time.sleep(sec)
                    logs.append(f"  -> 等待 {sec} 秒完成")
                elif stype == "click_image":
                    img_name = params.get("image_name", "")
                    res = self.click_template(img_name)
                    logs.append(f"  -> 图像点击: {res.get('message')}")
                elif stype == "click_coords":
                    cx = params.get("x", 0)
                    cy = params.get("y", 0)
                    pyautogui.click(cx, cy)
                    logs.append(f"  -> 点击坐标 ({cx}, {cy})")
                elif stype == "type_text":
                    txt = params.get("text", "")
                    pyautogui.write(txt, interval=0.05)
                    logs.append(f"  -> 输入文本完成")
                elif stype == "key_press":
                    key = params.get("key", "")
                    pyautogui.press(key)
                    logs.append(f"  -> 按键 [{key}]")
            except Exception as e:
                logs.append(f"  -> 步骤异常: {e}")

        return {"success": True, "message": "工作流执行完成", "logs": logs}

    def capture_screenshot(self, save_path: Optional[str] = None) -> Dict[str, Any]:
        """截取当前完整屏幕"""
        shot = pyautogui.screenshot()
        if not save_path:
            save_path = str(Path.home() / "Desktop" / f"screen_shot_{int(time.time())}.png")
        shot.save(save_path)
        return {
            "success": True,
            "message": f"屏幕截图已保存至: {save_path}",
            "width": shot.width,
            "height": shot.height,
            "path": save_path
        }
