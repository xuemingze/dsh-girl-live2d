"""
visual_mcp/server.py - 工业标准 MCP (Model Context Protocol) 视觉专精双手服务
严格贯彻铁律一：
1. 100% 走标准 MCP 协议 (stdio 通信)，作为独立外部子进程供 nanoMuse 调度；
2. 反向剪枝：剔除一切与 nanoMuse 重叠的文件、命令执行、大模型记忆功能；
3. 专精特化：聚焦屏幕模板匹配点击、桌面双击、坐标点击与视觉工作流；
4. 物理隔离：即便视觉匹配异常，仅返回 Tool Error，绝不影响 nanoMuse 主脑稳定。
"""
import sys
import os
import json
import logging
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

try:
    from visual_hands.executor import VisualExecutor
except ImportError:
    from executor import VisualExecutor

# 配置日志输出到 stderr，绝不污染 stdout (stdio 协议通道)
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[%(asctime)s] [VisualMCP] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("visual_mcp")

PROTOCOL_VERSION = "2024-11-05"
executor = VisualExecutor()


TOOLS_CATALOG = [
    {
        "name": "visual_click",
        "description": "在屏幕上使用高精度模板匹配搜索指定的按钮或图标并执行点击操作",
        "inputSchema": {
            "type": "object",
            "properties": {
                "template_name": {
                    "type": "string",
                    "description": "模板图片文件名或路径（如 'AiPyPro_1.png'、'MiniMax_0.png'）"
                },
                "confidence": {
                    "type": "number",
                    "description": "匹配阈值 (0.5~0.95，默认 0.7)"
                },
                "clicks": {
                    "type": "integer",
                    "description": "点击次数 (默认 1，双击设为 2)"
                }
            },
            "required": ["template_name"]
        }
    },
    {
        "name": "click_coordinate",
        "description": "移动鼠标并点击指定的物理屏幕坐标 (x, y)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer", "description": "屏幕物理像素 X 坐标"},
                "y": {"type": "integer", "description": "屏幕物理像素 Y 坐标"},
                "button": {
                    "type": "string",
                    "enum": ["left", "right", "middle"],
                    "description": "鼠标按键 (默认 left)"
                },
                "clicks": {"type": "integer", "description": "点击次数 (默认 1)"}
            },
            "required": ["x", "y"]
        }
    },
    {
        "name": "double_click_shortcut",
        "description": "根据名称在桌面搜索并启动或双击快捷方式/程序图标",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "桌面软件或快捷方式名称（如 'MiniMax Code'）"}
            },
            "required": ["name"]
        }
    },
    {
        "name": "run_visual_workflow",
        "description": "按名称执行预先在控制电脑工作台编排好的自动化工作流",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workflow_name": {"type": "string", "description": "工作流名称（如 'zzz日常'）"}
            },
            "required": ["workflow_name"]
        }
    },
    {
        "name": "list_visual_workflows",
        "description": "列出当前系统中所有已编排就绪的自动化视觉工作流",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "capture_desktop_screenshot",
        "description": "获取当前桌面完整屏幕截图并保存到本地",
        "inputSchema": {
            "type": "object",
            "properties": {
                "save_path": {"type": "string", "description": "可选的保存文件路径"}
            }
        }
    }
]


def handle_tool_call(name: str, args: dict) -> dict:
    """分发工具调用至执行引擎"""
    logger.info(f"调度执行视觉工具: {name}, 参数: {args}")
    try:
        if name == "visual_click":
            tname = args.get("template_name", "")
            conf = float(args.get("confidence", 0.7))
            clicks = int(args.get("clicks", 1))
            res = executor.click_template(tname, confidence=conf, clicks=clicks)
        elif name == "click_coordinate":
            x = int(args.get("x", 0))
            y = int(args.get("y", 0))
            btn = args.get("button", "left")
            clicks = int(args.get("clicks", 1))
            res = executor.click_coords(x, y, button=btn, clicks=clicks)
        elif name == "double_click_shortcut":
            sname = args.get("name", "")
            res = executor.launch_shortcut(sname)
        elif name == "run_visual_workflow":
            wfname = args.get("workflow_name", "")
            res = executor.run_workflow(wfname)
        elif name == "list_visual_workflows":
            res = {"success": True, "workflows": executor.list_workflows()}
        elif name == "capture_desktop_screenshot":
            spath = args.get("save_path")
            res = executor.capture_screenshot(spath)
        else:
            res = {"success": False, "message": f"未知工具: {name}"}

        is_error = not res.get("success", False)
        return {
            "content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}],
            "isError": is_error
        }
    except Exception as e:
        logger.exception(f"执行工具 [{name}] 异常: {e}")
        return {
            "content": [{"type": "text", "text": f"Tool Execution Error: {e}"}],
            "isError": True
        }


def run_stdio_server():
    """标准 MCP stdio 消息循环 (纯 JSON-RPC 2.0)"""
    logger.info("视觉 MCP 服务已就绪，等待 nanoMuse 连接...")

    # 确保 stdin/stdout 使用 utf-8
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except Exception:
            continue

        msg_id = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params", {})

        # 1. 协议握手
        if method == "initialize":
            resp = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "visual-hands-mcp",
                        "version": "1.0.0"
                    }
                }
            }
        elif method == "notifications/initialized":
            continue
        elif method == "ping":
            resp = {"jsonrpc": "2.0", "id": msg_id, "result": {}}

        # 2. 工具列表查询
        elif method == "tools/list":
            resp = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"tools": TOOLS_CATALOG}
            }

        # 3. 工具执行
        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            call_result = handle_tool_call(tool_name, tool_args)
            resp = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": call_result
            }
        else:
            resp = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}
            }

        out_str = json.dumps(resp, ensure_ascii=False)
        sys.stdout.write(out_str + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    run_stdio_server()
