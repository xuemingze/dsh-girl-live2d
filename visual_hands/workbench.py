"""
visual_mcp/workbench.py - 桌面陪伴者·剪枝后的视觉操控手原生工作台 (PySide6)
贯彻方案二反向剪枝思想：
- 剔除控制电脑原有重复的 70% 冗余逻辑 (chat_memory, assistant_core, duplicate file tools)
- 专注纯视觉匹配、坐标点击、快捷方式启动与自动化工作流
- 深度对接 visual_mcp (matcher.py, executor.py, server.py)
"""
import os
import sys
import json
import logging
from pathlib import Path

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QTextEdit, QTableWidget, QTableWidgetItem,
    QHeaderView, QTabWidget, QGroupBox, QMessageBox, QLineEdit, QSplitter
)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont, QIcon, QColor

# 确保能 import 同级及上级项目模块
WORKBENCH_DIR = Path(__file__).resolve().parent
PROJECT_DIR = WORKBENCH_DIR.parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from visual_mcp.executor import VisualExecutor

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("visual_workbench")


class VisualWorkbenchWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.executor = VisualExecutor()
        self.setWindowTitle("桌面陪伴者 - 视觉操控手原生工作台 (Visual MCP)")
        self.resize(880, 620)
        self.setStyleSheet("""
            QMainWindow { background-color: #1e1e24; color: #f0f0f0; }
            QWidget { background-color: #1e1e24; color: #f0f0f0; font-family: 'Segoe UI', 'Microsoft YaHei'; }
            QTabWidget::pane { border: 1px solid #33333f; background: #252530; border-radius: 6px; }
            QTabBar::tab { background: #2b2b38; color: #aaa; padding: 8px 16px; margin-right: 2px; border-top-left-radius: 4px; border-top-right-radius: 4px; }
            QTabBar::tab:selected { background: #3b3b4f; color: #fff; font-weight: bold; }
            QPushButton { background-color: #3f51b5; color: white; border: none; padding: 7px 14px; border-radius: 4px; font-weight: 500; }
            QPushButton:hover { background-color: #5c6bc0; }
            QPushButton:pressed { background-color: #303f9f; }
            QPushButton#dangerBtn { background-color: #d32f2f; }
            QPushButton#dangerBtn:hover { background-color: #ef5350; }
            QPushButton#successBtn { background-color: #388e3c; }
            QPushButton#successBtn:hover { background-color: #4caf50; }
            QTableWidget { background-color: #2b2b38; gridline-color: #3a3a4d; border: 1px solid #3a3a4d; border-radius: 4px; }
            QHeaderView::section { background-color: #333344; color: #ddd; padding: 5px; border: none; font-weight: bold; }
            QTextEdit, QLineEdit { background-color: #18181f; border: 1px solid #3a3a4d; border-radius: 4px; padding: 6px; color: #00e676; font-family: 'Consolas', monospace; }
            QGroupBox { border: 1px solid #3a3a4d; border-radius: 6px; margin-top: 10px; padding-top: 15px; font-weight: bold; color: #90caf9; }
            QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 5px; }
        """)

        self._build_ui()
        self._refresh_shortcuts()
        self._refresh_workflows()

    def _build_ui(self):
        central_widget = QWidget()
        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(14, 14, 14, 14)

        # 头部标题与 MCP 状态条
        header_layout = QHBoxLayout()
        title_label = QLabel("✨ 纯视觉与 GUI 自动化操控专精手 (已剪枝 70% 冗余)")
        title_label.setFont(QFont("Segoe UI", 12, QFont.Bold))
        header_layout.addWidget(title_label)
        header_layout.addStretch()

        self.mcp_status_pill = QLabel("🟢 MCP 协议就绪 (stdio 隔离子进程)")
        self.mcp_status_pill.setStyleSheet("color: #4caf50; font-weight: bold; padding: 4px 8px; background: #1b3320; border-radius: 4px;")
        header_layout.addWidget(self.mcp_status_pill)
        main_layout.addLayout(header_layout)

        # Tab 面板
        tabs = QTabWidget()

        # Tab 1: 桌面快捷方式自动化
        shortcuts_tab = QWidget()
        s_layout = QVBoxLayout(shortcuts_tab)

        btn_row = QHBoxLayout()
        btn_refresh = QPushButton("🔄 刷新桌面快捷方式")
        btn_refresh.clicked.connect(self._refresh_shortcuts)
        btn_row.addWidget(btn_refresh)

        btn_screen = QPushButton("📸 截取桌面全屏")
        btn_screen.setObjectName("successBtn")
        btn_screen.clicked.connect(self._do_screenshot)
        btn_row.addWidget(btn_screen)

        btn_row.addStretch()
        s_layout.addLayout(btn_row)

        self.shortcuts_table = QTableWidget(0, 3)
        self.shortcuts_table.setHorizontalHeaderLabels(["应用名称", "目标路径", "快捷操作"])
        self.shortcuts_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.shortcuts_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.shortcuts_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        s_layout.addWidget(self.shortcuts_table)

        tabs.addTab(shortcuts_tab, "🖥️ 桌面快捷方式")

        # Tab 2: 视觉工作流中心
        workflows_tab = QWidget()
        w_layout = QVBoxLayout(workflows_tab)

        w_btn_row = QHBoxLayout()
        btn_w_refresh = QPushButton("🔄 刷新工作流")
        btn_w_refresh.clicked.connect(self._refresh_workflows)
        w_btn_row.addWidget(btn_w_refresh)
        w_btn_row.addStretch()
        w_layout.addLayout(w_btn_row)

        self.workflows_table = QTableWidget(0, 4)
        self.workflows_table.setHorizontalHeaderLabels(["工作流 ID", "名称", "步骤数", "操作"])
        self.workflows_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.workflows_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.workflows_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.workflows_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        w_layout.addWidget(self.workflows_table)

        tabs.addTab(workflows_tab, "⚡ 自动化工作流")

        # Tab 3: 坐标点击与视觉测试
        test_tab = QWidget()
        t_layout = QVBoxLayout(test_tab)

        coord_group = QGroupBox("坐标点击直接执行 (测试用)")
        coord_layout = QHBoxLayout(coord_group)
        coord_layout.addWidget(QLabel("X 坐标:"))
        self.input_x = QLineEdit("500")
        coord_layout.addWidget(self.input_x)
        coord_layout.addWidget(QLabel("Y 坐标:"))
        self.input_y = QLineEdit("500")
        coord_layout.addWidget(self.input_y)
        btn_click = QPushButton("🎯 执行坐标点击")
        btn_click.clicked.connect(self._do_coord_click)
        coord_layout.addWidget(btn_click)
        t_layout.addWidget(coord_group)

        mcp_group = QGroupBox("已暴露的标准 MCP 工具清单 (物理进程隔离)")
        mcp_layout = QVBoxLayout(mcp_group)
        tools_info = QLabel(
            "• visual_click: 纯向量化多尺度 NCC 模板匹配点击 (0 OpenCV 崩溃风险)\n"
            "• click_coordinate: 绝对像素坐标直接点击\n"
            "• double_click_shortcut: 桌面快捷方式智能双击唤醒\n"
            "• run_visual_workflow: 执行预置自动化视觉工作流\n"
            "• list_visual_workflows: 检索当前系统可用工作流列表\n"
            "• capture_desktop_screenshot: 截取屏幕用于视觉分析与模板制作"
        )
        tools_info.setStyleSheet("color: #b0bec5; line-height: 1.6;")
        mcp_layout.addWidget(tools_info)
        t_layout.addWidget(mcp_group)
        t_layout.addStretch()

        tabs.addTab(test_tab, "🛠️ MCP 诊断与测试")

        main_layout.addWidget(tabs, stretch=2)

        # 底部日志面板
        log_group = QGroupBox("📜 操作与诊断日志")
        log_layout = QVBoxLayout(log_group)
        self.log_view = QTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumHeight(160)
        log_layout.addWidget(self.log_view)
        main_layout.addWidget(log_group, stretch=1)

        self.setCentralWidget(central_widget)
        self._log("视觉操控手工作台已初始化完成。")

    def _log(self, text: str):
        self.log_view.append(text)
        logger.info(text)

    def _scan_desktop_shortcuts(self):
        shortcuts = []
        desktop_paths = [
            Path.home() / "Desktop",
            Path(os.environ.get("PUBLIC", r"C:\Users\Public")) / "Desktop"
        ]
        seen = set()
        for d in desktop_paths:
            if d.exists():
                for f in d.glob("*.*"):
                    if f.suffix.lower() in (".lnk", ".url", ".exe") and f.stem not in seen:
                        seen.add(f.stem)
                        shortcuts.append({"name": f.stem, "path": str(f)})
        return shortcuts

    def _refresh_shortcuts(self):
        shortcuts = self._scan_desktop_shortcuts()
        self.shortcuts_table.setRowCount(0)
        for row, s in enumerate(shortcuts):
            self.shortcuts_table.insertRow(row)
            self.shortcuts_table.setItem(row, 0, QTableWidgetItem(s.get("name", "")))
            self.shortcuts_table.setItem(row, 1, QTableWidgetItem(s.get("path", "")))

            btn = QPushButton("🚀 启动/双击")
            name = s.get("name", "")
            btn.clicked.connect(lambda _, n=name: self._launch_shortcut(n))
            self.shortcuts_table.setCellWidget(row, 2, btn)

        self._log(f"已扫描并加载 {len(shortcuts)} 个桌面快捷方式。")

    def _launch_shortcut(self, name: str):
        self._log(f"正在唤起快捷方式: {name}...")
        res = self.executor.launch_shortcut(name)
        if res.get("success"):
            self._log(f"✅ 启动成功: {res.get('message')}")
        else:
            self._log(f"❌ 启动失败: {res.get('message')}")

    def _refresh_workflows(self):
        wfs = self.executor.list_workflows()
        self.workflows_table.setRowCount(0)
        for row, item in enumerate(wfs):
            self.workflows_table.insertRow(row)
            self.workflows_table.setItem(row, 0, QTableWidgetItem(str(item.get("id", ""))))
            self.workflows_table.setItem(row, 1, QTableWidgetItem(str(item.get("name", ""))))
            self.workflows_table.setItem(row, 2, QTableWidgetItem(str(item.get("step_count", 0))))

            btn = QPushButton("▶️ 执行")
            btn.setObjectName("successBtn")
            wid = item.get("id", "")
            btn.clicked.connect(lambda _, w=wid: self._execute_workflow(w))
            self.workflows_table.setCellWidget(row, 3, btn)

        self._log(f"已加载 {len(wfs)} 个自动化视觉工作流。")

    def _execute_workflow(self, wid: str):
        self._log(f"正在执行工作流: {wid}...")
        res = self.executor.run_workflow(wid)
        if res.get("success"):
            self._log(f"✅ 工作流 {wid} 执行完毕: {res.get('message')}")
            for l in res.get("logs", []):
                self._log(f"   {l}")
        else:
            self._log(f"❌ 工作流 {wid} 失败: {res.get('message')}")

    def _do_coord_click(self):
        try:
            x = int(self.input_x.text().strip())
            y = int(self.input_y.text().strip())
            self._log(f"执行坐标点击: ({x}, {y})")
            res = self.executor.click_coords(x, y)
            self._log(f"点击结果: {res.get('message')}")
        except Exception as e:
            self._log(f"坐标输入错误: {e}")

    def _do_screenshot(self):
        res = self.executor.capture_screenshot()
        if res.get("success"):
            path = res.get("path", "")
            self._log(f"✅ 截图保存成功: {path}")
            QMessageBox.information(self, "截图成功", f"截图已保存至：\n{path}")
        else:
            self._log(f"❌ 截图失败: {res.get('message')}")


def main():
    app = QApplication(sys.argv)
    win = VisualWorkbenchWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
