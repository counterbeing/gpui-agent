"""Policy-independent observe/act/verify loop with hard request/step/time bounds."""
import time
from .jev import PolicyError
from .protocol import DriverError


def run(driver, policy, task, *, max_steps=40, max_requests=20, max_seconds=120, settle_ms=80, emit=None):
    if not 0 <= settle_ms <= 1000:
        raise ValueError("invalid settle time")
    started = time.monotonic()
    timings = {name: 0.0 for name in ("observe", "verify", "decide", "act", "sleep")}

    def measured(name, call, *args):
        before = time.monotonic()
        try:
            return call(*args)
        finally:
            timings[name] += (time.monotonic() - before) * 1000

    def pause(seconds):
        measured("sleep", time.sleep, min(seconds, max(0, max_seconds - (time.monotonic() - started))))

    history = []
    report = {"protocol": 1, "status": "budget_exceeded", "passed": False, "steps": 0,
              "model_requests": 0, "verification": None, "error": None}
    sink = emit or (lambda _event: None)

    def emit(event):
        sink({**event, "elapsed_ms": round((time.monotonic() - started) * 1000, 2)})

    try:
        for step in range(max_steps):
            remaining = max_seconds - (time.monotonic() - started)
            if remaining <= 0:
                break
            driver.timeout = min(10, remaining)
            snapshot = measured("observe", driver.observe)
            remaining = max_seconds - (time.monotonic() - started)
            if remaining <= 0:
                break
            driver.timeout = min(10, remaining)
            verification = measured("verify", driver.verify, task["check"])
            report["verification"] = verification
            emit({"event": "observation", "step": step, "snapshot": snapshot, "verification": verification})
            if verification.get("passed") is True:
                report.update(status="passed", passed=True)
                break
            if not snapshot["surface"]["ready"]:
                pause(0.1)
                continue
            if policy.requests >= max_requests or time.monotonic() - started >= max_seconds:
                break
            policy.timeout = min(15, max_seconds - (time.monotonic() - started))
            decision = measured("decide", policy.choose, snapshot, task["goal"], task.get("text_values", []), history)
            if time.monotonic() - started >= max_seconds:
                break  # Never apply a decision that completed after the time budget.
            event = {"event": "decision", "step": step, "decision": decision,
                     "policy": getattr(policy, "last_evidence", {})}
            report["steps"] += 1
            if decision["operation"] in {"done", "blocked"}:
                # DONE is not a passing assertion. Verification above remains the independent oracle.
                report["status"] = "blocked" if decision["operation"] == "blocked" else "verification_failed"
                emit(event)
                break
            if decision["operation"] == "wait":
                pause(0.1)
                event["result"] = "waited"
            else:
                try:
                    driver.timeout = min(10, max(0.01, max_seconds - (time.monotonic() - started)))
                    measured("act", driver.act, snapshot, decision)
                    event["result"] = "executed"
                except DriverError as error:
                    if str(error) != "stale_observation":
                        raise
                    event["result"] = "stale_rejected"  # Re-observe; never blindly replay input.
                pause(settle_ms / 1000)
            history.append({**decision, "result": event["result"]})
            emit(event)
        else:
            report["error"] = "step_budget_exhausted"
    except (DriverError, PolicyError) as error:
        report.update(status="blocked", error=str(error))
    report.update(elapsed_ms=round((time.monotonic() - started) * 1000, 2),
                  model_requests=policy.requests, usage=getattr(policy, "usage", {}),
                  resolved_models=sorted(getattr(policy, "resolved_models", [])),
                  model_ms=round(getattr(policy, "model_ms", 0), 2),
                  timings_ms={name: round(value, 2) for name, value in timings.items()})
    return report


class ScriptPolicy:
    """Offline native-driver smoke tests only. Never represented as Jev performance evidence."""
    requests = 0
    timeout = 15

    def __init__(self, steps):
        self.steps = list(steps)
        self.index = 0

    def choose(self, snapshot, _goal, _text_values, _history):
        if self.index >= len(self.steps):
            return {"operation": "done"}
        step = self.steps[self.index]
        if step["operation"] in {"wait", "done", "blocked"}:
            self.index += 1
            return step
        nodes = [n for n in snapshot["surface"]["controls"]
                 if ("id" not in step or n["id"] == step["id"])
                 and ("label" not in step or n["label"] == step["label"])
                 and step["operation"] in n["actions"] and n["enabled"]]
        if not nodes and step.get("waitFor") is True:
            return {"operation": "wait"}
        if len(nodes) != 1:
            raise PolicyError("script target missing or ambiguous")
        self.index += 1
        result = {"operation": step["operation"], "target": nodes[0]["id"]}
        if "text" in step:
            result["text"] = step["text"]
        return result
