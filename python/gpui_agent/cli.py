"""CLI contract: one JSON report on stdout; nonzero exit unless independently verified."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import uuid

from .jev import JevPolicy, PolicyError
from .protocol import DriverError, StdioDriver
from .runner import ScriptPolicy, run


def read_key(env_file=None):
    key = os.environ.get("TYPESAFE_API_KEY", "")
    if key or env_file is None:
        return key
    # Deliberately not a shell/dotenv evaluator. Ignore every other project secret.
    with Path(env_file).open() as source:
        for line in source:
            name, separator, value = line.strip().partition("=")
            if separator and name.strip() == "TYPESAFE_API_KEY":
                return value.strip().strip("\"'")
    return ""


def task_file(path):
    task = json.loads(Path(path).read_text())
    if (not isinstance(task, dict) or set(task) - {"goal", "check", "text_values"}
            or not isinstance(task.get("goal"), str) or not 0 < len(task["goal"]) <= 4096
            or not isinstance(task.get("check"), str) or not task["check"]):
        raise ValueError("task requires goal, check and optional text_values")
    values = task.get("text_values", [])
    if (not isinstance(values, list) or len(values) > 32
            or any(not isinstance(v, str) or len(v.encode()) > 1024 or any(ord(c) < 32 for c in v) for v in values)):
        raise ValueError("invalid bounded text_values")
    return task


def main(argv=None, *, metadata=None, checkpoint=None):
    parser = argparse.ArgumentParser(description="Drive an explicitly opted-in GPUI app using Jev.")
    parser.add_argument("--task", required=True, help="JSON goal/check/text_values; not a shell script")
    parser.add_argument("--env-file", help="Read only TYPESAFE_API_KEY from this file")
    parser.add_argument("--allow-cloud", action="store_true", help="Explicitly permit sending this fixture UI state to TypeSafe")
    parser.add_argument("--script", help="Offline driver verification only; JSON action list")
    parser.add_argument("--model", default="jev-latest")
    parser.add_argument("--max-requests", type=int, default=20)
    parser.add_argument("--max-steps", type=int, default=80)
    parser.add_argument("--max-seconds", type=float, default=120)
    parser.add_argument("--min-confidence", type=float, default=0.2)
    parser.add_argument("--decision-mode", choices=["fanout", "actions"], default="fanout")
    parser.add_argument("--keepalive", action="store_true", help="Reuse the fixed TypeSafe HTTPS connection; no retry or proxy bypass")
    parser.add_argument("--settle-ms", type=float, default=80, help="Bounded delay after input; native stale-state guards always apply")
    parser.add_argument("--output", help="Create a NEW artifact directory; never overwrite an old run")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- /path/to/app --automation {session}")
    args = parser.parse_args(argv)
    try:
        if not (1 <= args.max_requests <= 1000 and 1 <= args.max_steps <= 1000
                and 1 <= args.max_seconds <= 180 and 0 <= args.min_confidence <= 1
                and 0 <= args.settle_ms <= 1000):
            raise ValueError("invalid run bounds")
        task = task_file(args.task)
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command or not any("{session}" in arg for arg in command):
            raise ValueError("provide an explicit application argv including {session}")
        if args.script:
            policy = ScriptPolicy(json.loads(Path(args.script).read_text()))
        else:
            if not args.allow_cloud:
                raise ValueError("live Jev requires --allow-cloud for this fixture state")
            policy = JevPolicy(read_key(args.env_file), model=args.model, threshold=args.min_confidence,
                               decision_mode=args.decision_mode, keepalive=args.keepalive)
        session = uuid.uuid4().hex
        command = [arg.replace("{session}", session) for arg in command]
        if args.output:
            output = Path(args.output)
            output.mkdir(mode=0o700, parents=False, exist_ok=False)
        else:
            output = Path(tempfile.mkdtemp(prefix="gpui-agent-"))
        with (output / "trace.jsonl").open("x") as trace, (output / "native.stderr.log").open("x") as errors:
            def emit(event):
                trace.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
                trace.flush()
            try:
                with StdioDriver(command, session, stderr=errors) as driver:
                    report = run(driver, policy, task, max_steps=args.max_steps,
                                 max_requests=args.max_requests, max_seconds=args.max_seconds,
                                 settle_ms=args.settle_ms, emit=emit)
                    if checkpoint is not None:
                        report["checkpoint"] = checkpoint(driver, output)
            finally:
                if isinstance(policy, JevPolicy):
                    policy.close()
        report.update(metadata=metadata or {}, engine="script" if args.script else "jev", model=None if args.script else args.model,
                      session=session, artifacts=str(output), goal=task["goal"],
                      limits={"requests": args.max_requests, "steps": args.max_steps, "seconds": args.max_seconds,
                              "settle_ms": args.settle_ms},
                      policy={"decision_mode": args.decision_mode, "keepalive": args.keepalive})
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, allow_nan=False))
        return 0 if report["passed"] else 1
    except (ValueError, OSError, DriverError, PolicyError) as error:
        # Avoid arbitrary exception strings from external systems leaking secrets.
        message = str(error) if isinstance(error, (DriverError, PolicyError)) else "invalid configuration or artifact path"
        print(json.dumps({"protocol": 1, "status": "error", "passed": False, "error": message}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
