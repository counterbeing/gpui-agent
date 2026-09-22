"""Offline tests. Never launch File-Bro, read a catalog, or make model requests."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from gpui_agent.cli import read_key, task_file
from gpui_agent.jev import JevPolicy, PolicyError, questions_for
from gpui_agent.protocol import DriverError, StdioDriver, validate_snapshot
from gpui_agent.runner import ScriptPolicy, run


def snapshot():
    return {"protocol": 1, "session": "fixture", "revision": 1, "surface": {
        "title": "Test", "ready": True, "facts": {}, "controls": [
            {"id": "review", "label": "Review", "role": "button", "value": "", "selected": False,
             "enabled": True, "actions": ["click"], "bounds": {"x": 10, "y": 20, "width": 80, "height": 26}},
            {"id": "search", "label": "Search", "role": "textbox", "value": "", "selected": False,
             "enabled": True, "actions": ["type_text"], "bounds": {"x": 90, "y": 20, "width": 100, "height": 26}},
        ]}}


def answer(choice, options, confidence=1):
    return {"type": "choice", "choice": choice, "confidence": confidence,
            "probabilities": {key: int(key == choice) for key in options}}


def response(body, operation="click"):
    answers = {}
    for key, question in body["questions"].items():
        pick = operation if key == "operation" else next(iter(question["criteria"]))
        answers[key] = answer(pick, question["criteria"])
    return {"model": "fixture", "answers": answers, "usage": {"input_tokens": 10, "output_tokens": 2}}


class FakeDriver:
    timeout = 10
    def __init__(self, *, pass_after=1, stale=False):
        self.actions = 0
        self.pass_after = pass_after
        self.stale = stale
    def observe(self):
        return snapshot()
    def verify(self, _check):
        return {"passed": self.actions >= self.pass_after}
    def act(self, _snapshot, _decision):
        if self.stale:
            raise DriverError("stale_observation")
        self.actions += 1


TASK = {"goal": "Open Review", "check": "independent", "text_values": ["Synthetic"]}


class PolicyTests(unittest.TestCase):
    def test_fanout_contains_only_compatible_targets_and_no_geometry(self):
        body = questions_for(snapshot(), "Review", ["Synthetic"], [])
        self.assertEqual(set(body["questions"]["target_click"]["criteria"]), {"review"})
        self.assertEqual(set(body["questions"]["target_type_text"]["criteria"]), {"search"})
        self.assertNotIn("bounds", body["state"]["ui"]["controls"][0])

    def test_disabled_controls_and_missing_text_are_not_offered(self):
        snap = snapshot()
        snap["surface"]["controls"][0]["enabled"] = False
        body = questions_for(snap, "goal", [], [])
        self.assertNotIn("click", body["questions"]["operation"]["criteria"])
        self.assertNotIn("type_text", body["questions"]["operation"]["criteria"])

    def test_operation_and_text_are_chosen_in_one_request(self):
        calls = []
        def request(body):
            calls.append(body)
            return response(body, "type_text")
        policy = JevPolicy("fake-test-key", request=request)
        decision = policy.choose(snapshot(), "Find Synthetic", ["Synthetic"], [])
        self.assertEqual(decision, {"operation": "type_text", "target": "search", "text": "Synthetic"})
        self.assertEqual(len(calls), 1)
        self.assertEqual(policy.usage, {"input_tokens": 10, "output_tokens": 2})

    def test_unused_speculative_answers_do_not_block_execution(self):
        def request(body):
            result = response(body)
            del result["answers"]["text_value"]
            result["answers"]["target_type_text"] = {"confidence": 0}
            return result
        policy = JevPolicy("fake", request=request)
        self.assertEqual(policy.choose(snapshot(), "goal", ["x"], [])["target"], "review")

    def test_hallucinated_target_and_nonfinite_confidence_refuse(self):
        for mutation in ["target", "nan", "uncertain"]:
            def request(body):
                result = response(body)
                if mutation == "target":
                    result["answers"]["target_click"]["choice"] = "delete"
                else:
                    result["answers"]["operation"]["confidence"] = float("nan") if mutation == "nan" else 0.01
                return result
            with self.assertRaises(PolicyError):
                JevPolicy("fake", request=request).choose(snapshot(), "goal", [], [])

    def test_request_failures_count_and_never_retry_implicitly(self):
        def fail(_body):
            raise PolicyError("fixture failure")
        policy = JevPolicy("fake", request=fail)
        with self.assertRaises(PolicyError):
            policy.choose(snapshot(), "goal", [], [])
        self.assertEqual(policy.requests, 1)


class RunnerTests(unittest.TestCase):
    def test_independent_verification_not_model_claim_passes(self):
        report = run(FakeDriver(), JevPolicy("fake", request=response), TASK)
        self.assertTrue(report["passed"])
        self.assertEqual(report["model_requests"], 1)

    def test_done_without_independent_success_fails(self):
        policy = JevPolicy("fake", request=lambda body: response(body, "done"))
        report = run(FakeDriver(pass_after=100), policy, TASK)
        self.assertEqual(report["status"], "verification_failed")
        self.assertFalse(report["passed"])

    def test_request_budget_is_hard_and_stale_action_is_not_replayed(self):
        driver = FakeDriver(stale=True)
        policy = JevPolicy("fake", request=response)
        events = []
        report = run(driver, policy, TASK, max_requests=2, emit=events.append)
        self.assertEqual(report["model_requests"], 2)
        self.assertEqual(driver.actions, 0)
        self.assertEqual(report["status"], "budget_exceeded")
        self.assertEqual(sum(e.get("result") == "stale_rejected" for e in events), 2)

    def test_unavailable_model_never_falls_back_or_executes(self):
        def fail(_):
            raise PolicyError("service unavailable")
        driver = FakeDriver()
        report = run(driver, JevPolicy("fake", request=fail), TASK)
        self.assertEqual(driver.actions, 0)
        self.assertEqual(report["status"], "blocked")

    def test_script_requires_unambiguous_observed_target(self):
        snap = snapshot()
        snap["surface"]["controls"].append(copy.deepcopy(snap["surface"]["controls"][0]))
        with self.assertRaises(PolicyError):
            ScriptPolicy([{"operation": "click", "label": "Review"}]).choose(snap, "", [], [])


class ConfigurationTests(unittest.TestCase):
    def test_only_explicit_key_is_read_without_evaluation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "fixture.env"
            path.write_text('UNRELATED_SECRET=nope\nTYPESAFE_API_KEY="fixture-only"\n')
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(read_key(path), "fixture-only")
                self.assertNotIn("UNRELATED_SECRET", os.environ)

    def test_malformed_native_snapshot_refuses_before_model_use(self):
        for value in [{}, {**snapshot(), "revision": -1}]:
            with self.assertRaises(DriverError):
                validate_snapshot(value)
        value = snapshot()
        value["surface"]["controls"][0]["bounds"]["x"] = float("nan")
        with self.assertRaises(DriverError):
            validate_snapshot(value)

    def test_task_rejects_unknown_fields_and_oversized_inputs(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "task.json"
            for task in [{**TASK, "shell": "no"}, {**TASK, "text_values": ["x" * 1025]}]:
                path.write_text(json.dumps(task))
                with self.assertRaises(ValueError):
                    task_file(path)

    def test_owned_stdio_child_does_not_inherit_credentials(self):
        code = '''import sys,json,os
for line in sys.stdin:
 r=json.loads(line)
 result={"protocol":1,"session":r["session"],"revision":1,"secret_present":"TYPESAFE_API_KEY" in os.environ,"surface":{"title":"Test","ready":True,"controls":[],"facts":{}}}
 print(json.dumps({"protocol":1,"id":r["id"],"ok":True,"result":result,"error":None}),flush=True)
 if r["command"]["method"]=="close": break
'''
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "fake-not-for-child"}):
            with StdioDriver([sys.executable, "-c", code], "fixture") as driver:
                self.assertFalse(driver.observe()["secret_present"])
            self.assertIsNotNone(driver.process.poll())


if __name__ == "__main__":
    unittest.main()
