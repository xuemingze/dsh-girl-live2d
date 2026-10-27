"""
visual_mcp/subsystem.py - 提纯后的桌面视觉控制子系统 (双手特化多态)
负责调度视觉自动化 MCP Server 与前台窗口感知嗅探
"""
import logging
import threading
from typing import Optional, Dict, Any

from core.interfaces import ICompanionSubsystem, SubsystemStatus, SubsystemState
from core.config_manager import ConfigManager

logger = logging.getLogger("visual_subsystem")


class VisualAutoSubsystem(ICompanionSubsystem):
    """桌面视觉自动化子系统实现"""

    def __init__(self, config_mgr: Optional[ConfigManager] = None):
        self.config_mgr = config_mgr or ConfigManager()
        self._state = SubsystemState.STOPPED
        self._message = "未启动"
        self._server_thread: Optional[threading.Thread] = None
        self._sensor_thread: Optional[threading.Thread] = None

    @property
    def name(self) -> str:
        return "桌面控制与视觉感知"

    def start(self) -> bool:
        if self.is_running():
            logger.info("视觉控制子系统已在运行中")
            return True

        self._state = SubsystemState.STARTING
        self._message = "正在启动视觉 MCP 与传感器..."
        logger.info("正在启动视觉控制子系统...")

        try:
            # 标记为运行状态 (在阶段二接入完整 MCP Server 和 Sensor)
            self._state = SubsystemState.RUNNING
            self._message = "MCP 监听中"
            self.config_mgr.set("visual_auto", "enabled", True)
            logger.info("视觉控制子系统已就绪")
            return True
        except Exception as e:
            self._state = SubsystemState.ERROR
            self._message = f"启动失败: {e}"
            logger.error(f"视觉控制子系统启动异常: {e}")
            return False

    def stop(self) -> bool:
        if not self.is_running() and self._state != SubsystemState.ERROR:
            return True

        logger.info("正在停止视觉控制子系统...")
        self._state = SubsystemState.STOPPED
        self._message = "已停止"
        self.config_mgr.set("visual_auto", "enabled", False)
        logger.info("视觉控制子系统已停止")
        return True

    def is_running(self) -> bool:
        return self._state == SubsystemState.RUNNING

    def get_status(self) -> SubsystemStatus:
        return SubsystemStatus(
            name=self.name,
            state=self._state,
            message=self._message,
            details={
                "mcp_port": self.config_mgr.get("visual_auto", "mcp_port", 16280),
                "sensor_enabled": self.config_mgr.get("visual_auto", "sensor_enabled", True),
            }
        )
