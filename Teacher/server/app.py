"""机房教师端后端：标准库实现，无第三方依赖。

职责：
  - 托管 Teacher/web-console 的静态页面，并让页面里的 ../icon 相对路径可用
  - 提供机房状态 API（机器、投屏、策略、设置、操作日志）
  - 通过 SSE 把状态变化实时推给前端
  - --simulate 时用后台线程模拟设备状态变化，方便演示

用法：
  python app.py                 # http://127.0.0.1:8800/web-console/index.html
  python app.py --port 9000 --simulate
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import queue
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TEACHER_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = TEACHER_ROOT / "web-console"
ICON_ROOT = TEACHER_ROOT / "icon"

MACHINE_TEMPLATE = [
    {"id": "PC-01", "ip": "192.168.10.11", "row": "A", "state": "online", "task": "第二套 · 循环结构", "submitted": False},
    {"id": "PC-02", "ip": "192.168.10.12", "row": "A", "state": "submitted", "task": "第二套 · 循环结构", "submitted": True},
    {"id": "PC-03", "ip": "192.168.10.13", "row": "A", "state": "locked"},
    {"id": "PC-04", "ip": "192.168.10.14", "row": "A", "state": "alert", "alert": "检测到非教学程序：game.exe"},
    {"id": "PC-05", "ip": "192.168.10.15", "row": "A", "state": "online"},
    {"id": "PC-06", "ip": "192.168.10.16", "row": "A", "state": "offline"},
    {"id": "PC-07", "ip": "192.168.10.17", "row": "B", "state": "online", "task": "第二套 · 循环结构", "submitted": False},
    {"id": "PC-08", "ip": "192.168.10.18", "row": "B", "state": "online"},
    {"id": "PC-09", "ip": "192.168.10.19", "row": "B", "state": "submitted", "task": "第二套 · 循环结构", "submitted": True},
    {"id": "PC-10", "ip": "192.168.10.20", "row": "B", "state": "alert", "alert": "检测到非教学程序：minigame.exe"},
    {"id": "PC-11", "ip": "192.168.10.21", "row": "B", "state": "online"},
    {"id": "PC-12", "ip": "192.168.10.22", "row": "B", "state": "offline"},
]

VALID_STATES = {"online", "locked", "alert", "submitted", "offline"}
MAX_LOG = 80


class Lab:
    """机房状态与命令处理，所有读写都在锁内完成。"""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        # 机房只认编号：机号 + IP + 排 + 状态
        self.machines = [
            {"id": "PC-01", "ip": "192.168.10.11", "row": "A", "state": "online", "task": "第二套 · 循环结构", "submitted": False},
            {"id": "PC-02", "ip": "192.168.10.12", "row": "A", "state": "submitted", "task": "第二套 · 循环结构", "submitted": True},
            {"id": "PC-03", "ip": "192.168.10.13", "row": "A", "state": "locked"},
            {"id": "PC-04", "ip": "192.168.10.14", "row": "A", "state": "alert", "alert": "检测到非教学程序：game.exe"},
            {"id": "PC-05", "ip": "192.168.10.15", "row": "A", "state": "online"},
            {"id": "PC-06", "ip": "192.168.10.16", "row": "A", "state": "offline"},
            {"id": "PC-07", "ip": "192.168.10.17", "row": "B", "state": "online", "task": "第二套 · 循环结构", "submitted": False},
            {"id": "PC-08", "ip": "192.168.10.18", "row": "B", "state": "online"},
            {"id": "PC-09", "ip": "192.168.10.19", "row": "B", "state": "submitted", "task": "第二套 · 循环结构", "submitted": True},
            {"id": "PC-10", "ip": "192.168.10.20", "row": "B", "state": "alert", "alert": "检测到非教学程序：minigame.exe"},
            {"id": "PC-11", "ip": "192.168.10.21", "row": "B", "state": "online"},
            {"id": "PC-12", "ip": "192.168.10.22", "row": "B", "state": "offline"},
        ]

        self.casting = {"on": False, "source": "teacher", "scope": "all"}
        self.policy = {
            "usb": False,
            "input": False,
            "blockNet": False,
            "block": True,
            "mode": "whitelist",   # whitelist | blacklist | blockall，只能启用一种
            "preset": "教学白名单",
            "log": False,
            "sites": ["edu.cn", "python.org", "code.org", "khanacademy.org"],
            "procs": {"mode": "block", "list": ["game.exe"]},
            "presets": [
                {"name": "教学白名单", "mode": "whitelist",
                 "sites": ["edu.cn", "python.org", "code.org", "khanacademy.org"]},
                {"name": "课间黑名单", "mode": "blacklist",
                 "sites": ["game.example.com", "tiktok.com"]},
            ],
        }
        self.groups = ["A", "B"]
        self.screen_lock = {"on": False, "message": "上课中，请勿操作"}
        self.whiteboard = {"strokes": []}
        self.settings = {"defaultSource": "整个屏幕", "columns": "自动"}
        self.log: list[dict] = []
        self.clients: set[queue.Queue] = set()
        self._log("控制台就绪", f"{len(self.machines)} 个座位")

    # ---------- 日志 ----------
    def _log(self, action: str, detail: str = "") -> None:
        self.log.insert(0, {"time": time.strftime("%H:%M:%S"), "action": action, "detail": detail})
        del self.log[MAX_LOG:]

    # ---------- 快照 ----------
    def snapshot(self) -> dict:
        with self.lock:
            return {
                "room": "第三机房 · A 区",
                "teacher": {"host": "TEACHER-01", "ip": "192.168.10.2"},
                "machines": [dict(m) for m in self.machines],
                "casting": dict(self.casting),
                "groups": list(self.groups),
                "policy": {
                    **self.policy,
                    "sites": list(self.policy["sites"]),
                    "procs": {
                        "mode": self.policy["procs"]["mode"],
                        "list": list(self.policy["procs"]["list"]),
                    },
                    "presets": [
                        {**preset, "sites": list(preset["sites"])} for preset in self.policy["presets"]
                    ],
                },
                "screen_lock": dict(self.screen_lock),
                "whiteboard": {"strokes": [dict(stroke) for stroke in self.whiteboard["strokes"]]},
                "settings": dict(self.settings),
                "log": [dict(e) for e in self.log[:40]],
            }

    # ---------- 订阅 ----------
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=64)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(q)

    def _broadcast(self) -> None:
        payload = {"type": "state", "data": self.snapshot()}
        with self.lock:
            targets = list(self.clients)
        for q in targets:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    # ---------- 命令 ----------
    def command(self, action: str, machine_ids: list[str], payload: dict) -> dict:
        ids = set(machine_ids or [])
        # 不指定机器时：开机针对离线机器，其余动作针对全部在线机器
        power_on = action == "power" and payload.get("mode") == "on"
        targets = [
            m for m in self.machines
            if (m["id"] in ids)
            or (not ids and (m["state"] == "offline" if power_on else m["state"] != "offline"))
        ]

        with self.lock:
            if action == "cast":
                source = str(payload.get("source", self.casting["source"]))
                known = {"teacher"} | {m["id"] for m in self.machines}
                if source not in known:
                    raise ValueError(f"unknown cast source: {source}")

                previous = dict(self.casting)
                self.casting = {
                    "on": bool(payload.get("on", True)),
                    "source": source,
                    "scope": payload.get("scope", self.casting["scope"]),
                }
                src = "教师机" if source == "teacher" else f"学生机 {source}"
                if self.casting["on"] != previous["on"]:
                    if self.casting["on"]:
                        # 全屏投送：学生端锁输入、只能观看
                        self._log("屏幕共享开始", f"{src} 全屏 · {len(targets)} 台")
                    else:
                        self._log("屏幕共享停止", "")


            elif action == "power":
                mode = payload.get("mode", "off")
                state = {"on": "online", "off": "offline", "restart": "online"}.get(mode, "offline")
                for m in targets:
                    m["state"] = state
                    if state == "offline":
                        m["blank"] = False
                self._log(
                    {"on": "开机", "off": "关机", "restart": "重启"}[mode],
                    f"→ {len(targets)} 台",
                )

            elif action in ("lock", "unlock"):
                on = action == "lock"
                message = str(payload.get("message", self.screen_lock["message"]))
                self.screen_lock = {"on": on, "message": message}
                for m in targets:
                    if on:
                        # 记住锁定前的状态，解锁时还原（异常不会被抹成在线）
                        if m["state"] not in ("locked", "offline"):
                            m["prev_state"] = m["state"]
                        m["state"] = "locked"
                    else:
                        m["state"] = m.pop("prev_state", "online")
                if on:
                    self._log("一键锁屏", f"{message} · {len(targets)} 台")
                else:
                    self._log("解除锁屏", f"→ {len(targets)} 台")

            elif action == "blank":
                on = bool(payload.get("on", True))
                for m in targets:
                    m["blank"] = on
                self._log("黑屏肃静 开启" if on else "黑屏肃静 关闭", f"→ {len(targets)} 台")

            elif action == "group":
                group = str(payload.get("group", "")).strip().upper()[:8]
                for m in targets:
                    m["row"] = group
                self._log("修改分组", f"→ {group or '未分组'} · {len(targets)} 台")

            elif action == "group-add":
                name = str(payload.get("name", "")).strip().upper()[:8]
                if not name:
                    raise ValueError("empty group name")
                if name in self.groups:
                    raise ValueError("group exists")
                self.groups.append(name)
                self._log("新建分组", f"{name} 组")

            elif action == "group-remove":
                name = str(payload.get("name", "")).strip().upper()[:8]
                if name not in self.groups:
                    raise ValueError("group not found")
                self.groups.remove(name)
                moved = 0
                for m in self.machines:
                    if m["row"] == name:
                        m["row"] = ""
                        moved += 1
                self._log("删除分组", f"{name} 组 · {moved} 台转入未分组")

            elif action == "label":
                on = bool(payload.get("on", True))
                for m in targets:
                    m["label"] = on
                self._log("显示机号" if on else "隐藏机号", f"{len(targets)} 台")

            elif action == "notice":
                text = str(payload.get("text", "")).strip()[:500]
                if not text:
                    raise ValueError("empty notice")
                self._log("发送通知", f"{text} · {len(targets)} 台")

            elif action == "proc":
                process = str(payload.get("process", "")).strip()[:64]
                rule = self.policy.get("procs") or {}
                watch = rule.get("list") or []
                if process and process in watch:
                    for m in targets:
                        m["state"] = "alert"
                        m["alert"] = f"检测到 {process}"
                        m["blocked"] = rule.get("mode") == "block"
                    if rule.get("mode") == "block":
                        self._log("拦截程序", f"{process} · {len(targets)} 台")
                    else:
                        self._log("待处理程序", f"{process} · {len(targets)} 台")
                else:
                    self._log("程序上报", f"{process or '未知'} · 未命中策略")

            elif action == "rename":
                old_id = str(payload.get("from", "")).strip()
                new_id = str(payload.get("to", "")).strip()
                if not new_id or len(new_id) > 16:
                    raise ValueError("invalid machine id")
                target = next((m for m in self.machines if m["id"] == old_id), None)
                if target is None:
                    raise ValueError(f"machine not found: {old_id}")
                if any(m["id"] == new_id for m in self.machines):
                    raise ValueError(f"machine id already exists: {new_id}")
                target["id"] = new_id
                self._log("重命名", f"{old_id} → {new_id}")

            elif action == "board-draw":
                stroke = payload.get("stroke") or {}
                points = [
                    [round(float(pt[0]), 1), round(float(pt[1]), 1)]
                    for pt in (stroke.get("points") or [])
                    if isinstance(pt, (list, tuple)) and len(pt) == 2
                ][:600]
                if not points:
                    raise ValueError("stroke without points")

                self.whiteboard["strokes"].append({
                    "color": str(stroke.get("color", "#0f172a"))[:16],
                    "width": max(1.0, min(40.0, float(stroke.get("width", 3)))),
                    "points": points,
                })
                del self.whiteboard["strokes"][:-120]
                self._log("白板笔迹", f"{len(self.whiteboard['strokes'])} 笔")

            elif action == "board-sync":
                # 开始共享时把本地已有的画稿整块推给服务端
                strokes = []
                for stroke in (payload.get("strokes") or [])[:120]:
                    if not isinstance(stroke, dict):
                        continue
                    points = [
                        [round(float(pt[0]), 1), round(float(pt[1]), 1)]
                        for pt in (stroke.get("points") or [])
                        if isinstance(pt, (list, tuple)) and len(pt) == 2
                    ][:600]
                    if not points:
                        continue
                    strokes.append({
                        "color": str(stroke.get("color", "#0f172a"))[:16],
                        "width": max(1.0, min(40.0, float(stroke.get("width", 3)))),
                        "points": points,
                    })
                self.whiteboard["strokes"] = strokes
                self._log("白板同步", f"{len(strokes)} 笔")

            elif action == "board-clear":
                self.whiteboard["strokes"] = []
                self._log("白板清空", "")

            elif action in ("remote", "demo"):
                name = "远程控制" if action == "remote" else "学生演示"
                # 只有一台时直接记机号，多台才记数量
                target_text = targets[0]["id"] if len(targets) == 1 else f"{len(targets)} 台"
                self._log(name, f"→ {target_text}")

            elif action in ("media", "board", "quiz"):
                name = {"media": "媒体共享", "board": "白板共享", "quiz": "在线答题"}[action]
                if action == "quiz":
                    self._log(name, f"→ {len(targets)} 台")
                elif action == "media" and payload.get("on", True):
                    media = str(payload.get("file", "")).strip()
                    detail = f"{media} → {len(targets)} 台" if media else f"→ {len(targets)} 台"
                    self._log("媒体共享 开始", detail)
                else:
                    state_text = "开启" if payload.get("on", True) else "关闭"
                    self._log(f"{name} {state_text}", f"→ {len(targets)} 台")

            elif action == "task":
                self._log(payload.get("title", "下发任务"), payload.get("detail", ""))

            elif action == "policy":
                mode = payload.get("mode")
                if mode not in ("whitelist", "blacklist", "blockall"):
                    mode = "whitelist"

                presets = []
                for preset in payload.get("presets", []) or []:
                    if not isinstance(preset, dict):
                        continue
                    name = str(preset.get("name", "")).strip()[:20]
                    if not name:
                        continue
                    presets.append({
                        "name": name,
                        "mode": "blacklist" if preset.get("mode") == "blacklist" else "whitelist",
                        "sites": [str(site) for site in preset.get("sites", [])][:200],
                    })

                self.policy = {
                    "usb": bool(payload.get("usb", False)),
                    "input": bool(payload.get("input", False)),
                    "blockNet": bool(payload.get("blockNet", False)),
                    "block": bool(payload.get("block", True)),
                    "mode": mode,
                    "preset": str(payload.get("preset", ""))[:20],
                    "log": bool(payload.get("log", False)),
                    "sites": [str(site) for site in payload.get("sites", [])][:200],
                    "presets": presets,
                    "procs": {
                        "mode": "report" if (payload.get("procs") or {}).get("mode") == "report" else "block",
                        "list": [str(n)[:64] for n in ((payload.get("procs") or {}).get("list") or [])][:200],
                    },
                }

                flags = []
                if self.policy["usb"]:
                    flags.append("禁止USB")
                if self.policy["blockNet"]:
                    flags.append("禁止联网")
                if self.policy["block"]:
                    flags.append("上网限制")
                if self.policy["input"]:
                    flags.append("锁定键鼠")
                summary = "、".join(flags) if flags else "无限制"

                if mode == "blockall":
                    detail = f"{summary} · 完全禁止"
                else:
                    mode_text = "白名单" if mode == "whitelist" else "黑名单"
                    preset_text = f"（{self.policy['preset']}）" if self.policy["preset"] else ""
                    detail = f"{summary} · {mode_text} {len(self.policy['sites'])} 个{preset_text}"
                self._log("策略更新", detail)

            elif action == "settings":
                self.settings = {
                    "defaultSource": payload.get("defaultSource", self.settings["defaultSource"]),
                    "columns": payload.get("columns", self.settings["columns"]),
                }
                self._log(
                    "控制台设置保存",
                    f"{self.settings['defaultSource']} · {self.settings['columns']}",
                )

            else:
                raise ValueError(f"unknown action: {action}")

            self._broadcast()
            return self.snapshot()

    # ---------- 模拟器 ----------
    def simulate_tick(self) -> None:
        """随机制造一点机房动静：学生打开非教学程序、离线机器上线等。"""
        with self.lock:
            online = [m for m in self.machines if m["state"] != "offline"]
            offline = [m for m in self.machines if m["state"] == "offline"]
            roll = random.random()
            if roll < 0.4 and online:
                m = random.choice(online)
                if m["state"] == "alert":
                    m["state"] = "online"
                    self._log("恢复", f"{m['id']} 关闭了非教学程序")
                else:
                    m["state"] = "alert"
                    self._log("异常", f"{m['id']} 检测到非教学程序")
            elif roll < 0.55 and offline:
                m = random.choice(offline)
                m["state"] = "online"
                self._log("上线", m["id"])
            else:
                return
            self._broadcast()


class Handler(BaseHTTPRequestHandler):
    server_version = "OEC/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def lab(self) -> Lab:
        return self.server.lab  # type: ignore[attr-defined]

    # ---------- 基础响应 ----------
    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data: dict) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _error(self, code: int, message: str) -> None:
        self._json(code, {"ok": False, "error": message})

    # ---------- 路由 ----------
    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/web-console/index.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path == "/api/state":
            self._json(200, {"ok": True, "state": self.lab.snapshot()})
            return

        if path == "/api/health":
            self._json(200, {"ok": True, "machines": len(self.lab.machines)})
            return

        if path == "/api/events":
            self._events()
            return

        if path.startswith("/web-console/"):
            self._static(WEB_ROOT / path[len("/web-console/"):])
            return

        if path.startswith("/icon/"):
            self._static(ICON_ROOT / path[len("/icon/"):])
            return

        self._error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/api/command":
            self._error(404, "not found")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1_000_000:
            self._error(400, "empty or oversized body")
            return

        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "invalid JSON")
            return

        action = body.get("action")
        if not isinstance(action, str):
            self._error(400, "missing action")
            return

        ids = body.get("machines") or []
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
            self._error(400, "machines must be a list of ids")
            return

        payload = body.get("payload") or {}
        if not isinstance(payload, dict):
            self._error(400, "payload must be an object")
            return

        try:
            snapshot = self.lab.command(action, ids, payload)
        except ValueError as exc:
            self._error(400, str(exc))
            return

        self._json(200, {"ok": True, "state": snapshot})

    # ---------- SSE ----------
    def _events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        client = self.lab.subscribe()
        try:
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.write(
                f"data: {json.dumps({'type': 'state', 'data': self.lab.snapshot()}, ensure_ascii=False)}\n\n".encode()
            )
            self.wfile.flush()
            while not self.server.stopping:  # type: ignore[attr-defined]
                try:
                    message = client.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(f"data: {json.dumps(message, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.lab.unsubscribe(client)
            self.close_connection = True

    # ---------- 静态文件 ----------
    def _static(self, path: Path) -> None:
        try:
            resolved = path.resolve()
            resolved.relative_to(TEACHER_ROOT)
        except (ValueError, OSError):
            self._error(403, "forbidden")
            return

        if not resolved.is_file():
            self._error(404, "not found")
            return

        ctype = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        body = resolved.read_bytes()
        self._send(200, body, ctype)

    def log_message(self, fmt: str, *args) -> None:  # 安静一点
        if "/api/events" in self.path:
            return
        super().log_message(fmt, *args)


def build_server(host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.lab = Lab()  # type: ignore[attr-defined]
    server.stopping = False  # type: ignore[attr-defined]
    return server


def run_simulator(server: ThreadingHTTPServer, interval: float) -> None:
    lab: Lab = server.lab  # type: ignore[attr-defined]
    while not server.stopping:  # type: ignore[attr-defined]
        time.sleep(interval)
        if server.stopping:  # type: ignore[attr-defined]
            break
        lab.simulate_tick()


def main() -> None:
    parser = argparse.ArgumentParser(description="Open Electronic Classroom 教师端后端")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认本机）")
    parser.add_argument("--port", type=int, default=8800, help="监听端口（默认 8800）")
    parser.add_argument("--simulate", action="store_true", help="开启设备状态模拟器")
    parser.add_argument("--simulate-interval", type=float, default=6.0, help="模拟间隔秒数")
    args = parser.parse_args()

    server = build_server(args.host, args.port)
    if args.simulate:
        threading.Thread(target=run_simulator, args=(server, args.simulate_interval), daemon=True).start()

    print(f"教师端后端已启动: http://{args.host}:{args.port}/web-console/index.html")
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.stopping = True  # type: ignore[attr-defined]
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
