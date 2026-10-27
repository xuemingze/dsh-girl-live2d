"""
visual_mcp/matcher.py - 纯 PIL + NumPy 向量化 NCC 模板匹配
不依赖 OpenCV DLL，跨平台超轻量，毫秒级定位桌面图标与按钮
"""
from typing import Optional, Tuple, Any
from pathlib import Path
from PIL import Image
import numpy as np
import pyautogui


def compute_ncc_map(screen: Any, template: Any, step: int = 4) -> Tuple[Any, Any]:
    """向量化 NCC 计算 - 一次性快速计算滑动窗口归一化互相关分数"""
    if screen.ndim == 3:
        screen = screen.mean(axis=2)
    if template.ndim == 3:
        template = template.mean(axis=2)

    s_h, s_w = screen.shape
    t_h, t_w = template.shape

    if t_h > s_h or t_w > s_w:
        return np.array([[]]), np.array([])

    t_mean = template.mean()
    t_norm = (template - t_mean).ravel()
    t_std = np.sqrt((t_norm ** 2).sum()) + 1e-6

    # 滑动窗口视图
    windows = np.lib.stride_tricks.sliding_window_view(screen, (t_h, t_w))
    if step > 1:
        windows = windows[::step, ::step]

    n_y, n_x = windows.shape[:2]
    flat = windows.reshape(n_y, n_x, -1).astype(np.float32)
    w_mean = flat.mean(axis=2, keepdims=True)
    w_norm = flat - w_mean
    w_std = np.sqrt((w_norm ** 2).sum(axis=2, keepdims=True)) + 1e-6

    dot = (w_norm * t_norm).sum(axis=2)
    ncc = dot / (t_std * w_std.squeeze(axis=2))

    positions = np.array([[y * step, x * step] for y in range(n_y) for x in range(n_x)])
    return ncc, positions


def locate_template(
    template_path: str,
    confidence: float = 0.7,
    screenshot: Optional[Image.Image] = None
) -> Optional[Tuple[int, int, int, int, float]]:
    """
    在屏幕上定位模板图像
    返回: (center_x, center_y, width, height, confidence_score) 或 None
    """
    t_path = Path(template_path)
    if not t_path.exists():
        return None

    try:
        template = Image.open(t_path).convert("RGB")
    except Exception:
        return None

    t_w, t_h = template.size

    if screenshot is None:
        screenshot = pyautogui.screenshot()
    s_w, s_h = screenshot.size

    if t_w > s_w or t_h > s_h:
        return None

    t_arr = np.array(template, dtype=np.float32)
    s_arr = np.array(screenshot, dtype=np.float32)

    # 1. 粗搜索 (步长 4)
    ncc_map, positions = compute_ncc_map(s_arr, t_arr, step=4)
    if ncc_map.size == 0:
        return None

    best_idx = np.argmax(ncc_map)
    best_y, best_x = positions[best_idx]
    best_score = float(ncc_map.flat[best_idx])

    if best_score < confidence:
        return None

    # 2. 精搜索 (在粗搜索命中点周围 ±4 像素内做步长 1 微调)
    pad = 4
    sub_y1 = max(0, best_y - pad)
    sub_y2 = min(s_h, best_y + t_h + pad)
    sub_x1 = max(0, best_x - pad)
    sub_x2 = min(s_w, best_x + t_w + pad)

    sub_screen = s_arr[sub_y1:sub_y2, sub_x1:sub_x2]
    fine_ncc, fine_pos = compute_ncc_map(sub_screen, t_arr, step=1)

    if fine_ncc.size > 0:
        fine_idx = np.argmax(fine_ncc)
        fine_score = float(fine_ncc.flat[fine_idx])
        if fine_score >= confidence:
            fy, fx = fine_pos[fine_idx]
            best_x = sub_x1 + fx
            best_y = sub_y1 + fy
            best_score = fine_score

    center_x = int(best_x + t_w // 2)
    center_y = int(best_y + t_h // 2)
    return (center_x, center_y, t_w, t_h, best_score)
