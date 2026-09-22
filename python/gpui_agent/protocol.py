"""Bounded JSONL client for one explicitly launched/owned fixture application."""
import json
import math
import os
import queue
import subprocess
import threading

VERSION = 1
MAX_RESPONSE = 1_048_576


class DriverError(Exception):
    pass


def validate_snapshot(snapshot):
    try:
        surface = snapshot["surface"]
        nodes = surface["controls"]
        if (type(snapshot["revision"]) is not int or snapshot["revision"] < 1
                or type(surface["ready"]) is not bool or not isinstance(surface["facts"], dict)
                or not isinstance(surface["title"], str) or not isinstance(nodes, list) or len(nodes) > 512):
            raise ValueError()
        seen = set()
        for node in nodes:
            if (any(not isinstance(node[k], str) for k in ("id", "label", "role", "value"))
                    or not node["id"] or node["id"] in seen
                    or type(node["enabled"]) is not bool or type(node["selected"]) is not bool
                    or not isinstance(node["actions"], list)
                    or any(op not in {"click", "double_click", "type_text", "scroll_up", "scroll_down"} for op in node["actions"])):
                raise ValueError()
            seen.add(node["id"])
            bounds = node["bounds"]
            if any(type(bounds[k]) not in (int, float) or not math.isfinite(bounds[k]) for k in ("x", "y", "width", "height")):
                raise ValueError()
            if bounds["width"] <= 0 or bounds["height"] <= 0:
                raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise DriverError("invalid native snapshot") from None


class StdioDriver:
    def __init__(self, command, session, *, timeout=10, stderr=None):
        if not command or any(not isinstance(arg, str) for arg in command):
            raise DriverError("application command must be an explicit argv array")
        self.session = session
        self.timeout = timeout
        self.sequence = 0
        self.responses = queue.Queue(maxsize=2)
        # No API credentials or unrelated secrets enter the native child environment.
        allowed = {"HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"}
        env = {key: value for key, value in os.environ.items() if key in allowed}
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=stderr or subprocess.DEVNULL, env=env)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_RESPONSE + 1)
                if not line or len(line) > MAX_RESPONSE or not line.endswith(b"\n"):
                    self.responses.put(DriverError("native pipe closed or response too large"))
                    return
                self.responses.put(json.loads(line))
        except (ValueError, OSError):
            self.responses.put(DriverError("invalid native response"))

    def request(self, method, **payload):
        self.sequence += 1
        data = {"protocol": VERSION, "session": self.session, "id": self.sequence,
                "command": {"method": method, **payload}}
        wire = (json.dumps(data, allow_nan=False) + "\n").encode()
        if len(wire) > 65_536:
            raise DriverError("request too large")
        try:
            self.process.stdin.write(wire)
            self.process.stdin.flush()
            reply = self.responses.get(timeout=self.timeout)
        except (OSError, queue.Empty) as error:
            raise DriverError("native request failed or timed out") from error
        if isinstance(reply, Exception):
            raise reply
        if not isinstance(reply, dict) or reply.get("protocol") != VERSION or reply.get("id") != self.sequence:
            raise DriverError("native response identity mismatch")
        if reply.get("ok") is not True:
            raise DriverError(reply.get("error", "native request refused"))
        return reply["result"]

    def observe(self):
        result = self.request("observe")
        if not isinstance(result, dict) or result.get("protocol") != VERSION or result.get("session") != self.session:
            raise DriverError("snapshot identity mismatch")
        validate_snapshot(result)
        return result

    def act(self, snapshot, decision):
        action = {"revision": snapshot["revision"], "operation": decision["operation"],
                  "target": decision["target"]}
        if "text" in decision:
            action["text"] = decision["text"]
        return self.request("act", action=action)

    def verify(self, check):
        result = self.request("verify", check=check)
        if not isinstance(result, dict) or type(result.get("passed")) is not bool:
            raise DriverError("invalid independent verification result")
        return result

    def close(self):
        # Only the child created by this object is closed. Never search/kill by app name.
        if self.process.poll() is None:
            try:
                self.request("close")
            except DriverError:
                pass
            try:
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
