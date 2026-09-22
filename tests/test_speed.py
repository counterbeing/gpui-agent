"""Offline performance-path guards: fake API/transport only, no app or network."""
import copy
import json
from unittest import TestCase
from unittest.mock import Mock, patch

from test_runner import FakeDriver, TASK, answer, response, snapshot
from gpui_agent.jev import JevPolicy, PolicyError, action_question
from gpui_agent.runner import run


def action_response(body, key="a0"):
    return {"model": "fixture", "answers": {"action": answer(key, body["questions"]["action"]["criteria"])},
            "usage": {"input_tokens": 10, "output_tokens": 2}}


class ActionTableTests(TestCase):
    def test_joint_choice_maps_exact_operation_target_and_banked_text(self):
        body, decisions = action_question(snapshot(), "Search", ["Synthetic", ""], [])
        key = next(k for k, d in decisions.items() if d.get("text") == "Synthetic")
        policy = JevPolicy("fake", decision_mode="actions", request=lambda body: action_response(body, key))
        self.assertEqual(policy.choose(snapshot(), "Search", ["Synthetic", ""], []),
                         {"operation": "type_text", "target": "search", "text": "Synthetic"})
        self.assertEqual(policy.requests, 1)
        self.assertEqual(list(body["questions"]), ["action"])
        self.assertNotIn("controls", body["state"]["ui"])
        self.assertNotIn("bounds", json.dumps(body))

    def test_disabled_targets_and_unbanked_text_not_offered(self):
        snap = snapshot()
        snap["surface"]["controls"][0]["enabled"] = False
        body, choices = action_question(snap, "goal", [], [])
        self.assertEqual(set(choices), {"done", "wait", "blocked"})
        self.assertEqual(body["state"]["unavailable_controls"][0]["id"], "review")

    def test_arbitrary_choice_refused_without_execution(self):
        policy = JevPolicy("fake", decision_mode="actions", request=lambda body: action_response(body, "delete-everything"))
        driver = FakeDriver()
        report = run(driver, policy, TASK, settle_ms=0)
        self.assertFalse(report["passed"])
        self.assertEqual(driver.actions, 0)
        self.assertEqual(report["model_requests"], 1)

    def test_oversized_joint_space_refuses_before_paid_request(self):
        snap = snapshot()
        node = snap["surface"]["controls"][0]
        snap["surface"]["controls"] = [{**copy.deepcopy(node), "id": str(i)} for i in range(126)]
        call = Mock()
        policy = JevPolicy("fake", decision_mode="actions", request=call)
        with self.assertRaises(PolicyError):
            policy.choose(snap, "goal", [], [])
        call.assert_not_called()
        self.assertEqual(policy.requests, 0)

    def test_zero_settle_preserves_stale_and_request_guards_and_timings(self):
        driver = FakeDriver(stale=True)
        policy = JevPolicy("fake", request=response)
        report = run(driver, policy, TASK, settle_ms=0, max_requests=2)
        self.assertEqual(driver.actions, 0)
        self.assertEqual(report["status"], "budget_exceeded")
        self.assertEqual(report["model_requests"], 2)
        self.assertEqual(set(report["timings_ms"]), {"observe", "verify", "decide", "act", "sleep"})
        self.assertTrue(all(value >= 0 for value in report["timings_ms"].values()))


class PersistentTransportTests(TestCase):
    def fake_connection(self, status=200):
        connection = Mock()
        connection.sock = None
        connection.connect.side_effect = lambda: setattr(connection, "sock", Mock())
        body = {}
        def request(method, path, **kwargs):
            self.assertEqual((method, path), ("POST", "/v1/systemone"))
            body.update(json.loads(kwargs["body"]))
        connection.request.side_effect = request
        reply = Mock(status=status)
        reply.read.side_effect = lambda limit: json.dumps(response(body)).encode()
        connection.getresponse.return_value = reply
        return connection

    @patch("gpui_agent.jev.urllib.request.getproxies", return_value={})
    @patch("gpui_agent.jev.http.client.HTTPSConnection")
    def test_two_decisions_reuse_one_verified_https_connection(self, factory, _proxies):
        connection = self.fake_connection()
        factory.return_value = connection
        policy = JevPolicy("fake", keepalive=True)
        for _ in range(2):
            policy.choose(snapshot(), "goal", [], [])
        factory.assert_called_once_with("api.typesafe.ai", timeout=15)
        connection.connect.assert_called_once()
        self.assertEqual(connection.request.call_count, 2)
        self.assertTrue(policy.last_evidence["transport"]["reused_connection"])
        policy.close()
        connection.close.assert_called_once()
        self.assertIsNone(policy.connection)

    @patch("gpui_agent.jev.urllib.request.getproxies", return_value={})
    @patch("gpui_agent.jev.http.client.HTTPSConnection")
    def test_redirect_refused_connection_closed_and_no_retry(self, factory, _proxies):
        connection = self.fake_connection(status=302)
        factory.return_value = connection
        policy = JevPolicy("fake", keepalive=True)
        with self.assertRaisesRegex(PolicyError, "HTTP 302"):
            policy.choose(snapshot(), "goal", [], [])
        self.assertEqual(policy.requests, 1)
        self.assertEqual(connection.request.call_count, 1)
        connection.close.assert_called_once()

    @patch("gpui_agent.jev.urllib.request.getproxies", return_value={})
    @patch("gpui_agent.jev.http.client.HTTPSConnection")
    def test_disconnected_socket_does_not_retry_or_fallback(self, factory, _proxies):
        connection = self.fake_connection()
        connection.getresponse.side_effect = OSError("fake disconnect")
        factory.return_value = connection
        policy = JevPolicy("fake", keepalive=True)
        with self.assertRaisesRegex(PolicyError, "no automatic retry"):
            policy.choose(snapshot(), "goal", [], [])
        self.assertEqual(policy.requests, 1)
        self.assertEqual(connection.request.call_count, 1)
        self.assertIsNone(policy.connection)

    @patch("gpui_agent.jev.urllib.request.proxy_bypass", return_value=False)
    @patch("gpui_agent.jev.urllib.request.getproxies", return_value={"https": "http://fixture.invalid:8080"})
    @patch("gpui_agent.jev.http.client.HTTPSConnection")
    def test_proxy_not_silently_bypassed(self, factory, _proxies, _bypass):
        policy = JevPolicy("fake", keepalive=True)
        with self.assertRaisesRegex(PolicyError, "HTTPS proxy"):
            policy.choose(snapshot(), "goal", [], [])
        factory.assert_not_called()
