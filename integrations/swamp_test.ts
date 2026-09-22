import { createGpuiModel, Report, runnerArgs } from "./swamp.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("argv preserves spaces and shell-looking text as literal arguments", () => {
  const args = runnerArgs({
    runnerPath: "/fixture dir/run.py",
    taskPath: "/fixture/goal.json",
    application: ["/fixture/app", "--agent", "{session}", "$(not-a-command)"],
    allowCloud: true,
    maxRequests: 3,
  });
  assert(args[0] === "/fixture dir/run.py");
  assert(args.at(-1) === "$(not-a-command)");
  assert(args.includes("3"));
});

Deno.test("cloud access and a session placeholder are explicit", () => {
  for (
    const config of [
      { allowCloud: false, application: ["app", "{session}"] },
      { allowCloud: true, application: ["app"] },
    ]
  ) {
    let refused = false;
    try {
      runnerArgs({
        runnerPath: "run.py",
        taskPath: "task.json",
        maxRequests: 3,
        ...config,
      });
    } catch {
      refused = true;
    }
    assert(refused);
  }
});

Deno.test("report cannot replace boolean success with a model's string claim", () => {
  assert(
    !Report.safeParse({ protocol: 1, status: "passed", passed: "yes" }).success,
  );
  assert(
    !Report.safeParse({ protocol: 2, status: "passed", passed: true }).success,
  );
  assert(
    !Report.safeParse({
      protocol: 1,
      status: "passed",
      passed: true,
      secret: "no",
    }).success,
  );
  assert(
    Report.parse({ protocol: 1, status: "blocked", passed: false }).passed ===
      false,
  );
});

Deno.test("performance options remain literal and zero settle is preserved", () => {
  const args = runnerArgs({
    runnerPath: "run.py",
    taskPath: "task.json",
    application: ["fixture", "{session}"],
    allowCloud: true,
    maxRequests: 6,
    decisionMode: "actions",
    keepalive: true,
    settleMs: 0,
  });
  assert(args[args.indexOf("--decision-mode") + 1] === "actions");
  assert(args.includes("--keepalive"));
  assert(args[args.indexOf("--settle-ms") + 1] === "0");
});

Deno.test("profiled reports retain timing and policy configuration", () => {
  const report = Report.parse({
    protocol: 1,
    status: "passed",
    passed: true,
    timings_ms: { observe: 20, verify: 20, decide: 150, act: 20, sleep: 0 },
    policy: { decision_mode: "actions", keepalive: true },
    limits: { requests: 6, steps: 80, seconds: 120, settle_ms: 0 },
  });
  assert(report.timings_ms?.decide === 150);
  assert(report.policy?.keepalive === true);
});

Deno.test("factory creates one typed method without starting anything", () => {
  const model = createGpuiModel("@example/gpui-agent");
  assert(model.type === "@example/gpui-agent");
  assert(Object.keys(model.methods).join() === "run");
  assert(model.resources.result.schema === Report);
});
