import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig, Refusal } from '../src/config.ts';
import { snapshot, validateDecision } from '../src/driver.ts';
import { actionQuestion, selected, JevPolicy } from '../src/policy.ts';
import { runTask, summary } from '../src/task.ts';
import {
	answer,
	config,
	fixture,
	FakeDriver,
	ScriptPolicy,
	session,
	setup,
	withKey
} from './helpers.ts';

for (const [label, change] of [
	[
		'implicit fixture authority',
		(c: any) => {
			c.fixtureOnly = false;
		}
	],
	[
		'shell string',
		(c: any) => {
			c.tasks.counter.application = 'echo hi';
		}
	],
	[
		'missing token',
		(c: any) => {
			c.tasks.counter.application = ['app', '--agent'];
		}
	],
	[
		'multiple tokens',
		(c: any) => {
			c.tasks.counter.application.push('{session}');
		}
	],
	[
		'interpolated token',
		(c: any) => {
			c.tasks.counter.application = ['app', '--session={session}'];
		}
	],
	[
		'spending in config',
		(c: any) => {
			c.allowCloud = true;
		}
	],
	[
		'unbounded requests',
		(c: any) => {
			c.tasks.counter.maxRequests = 1000;
		}
	]
] as const)
	test(`config refuses ${label}`, () => {
		const c = config();
		change(c);
		assert.throws(() => parseConfig(JSON.stringify(c), '/fixture'), Refusal);
	});

test('missing API key fails clearly before native launch', async () => {
	const { project } = await setup();
	let launched = false;
	await withKey(undefined, () =>
		assert.rejects(
			runTask(project, 'counter', {
				driverFactory: () => {
					launched = true;
					return new FakeDriver();
				}
			}),
			/Set TYPESAFE_API_KEY/
		)
	);
	assert.equal(launched, false);
});

test('snapshot refuses wrong sessions, duplicate IDs and invalid geometry', () => {
	assert.throws(() => snapshot(fixture(), 'different'), /identity/);
	const duplicate = fixture();
	duplicate.surface.controls.push(duplicate.surface.controls[0]);
	assert.throws(() => snapshot(duplicate, session), /control/);
	const badBounds = fixture();
	badBounds.surface.controls[0].bounds.width = 0;
	assert.throws(() => snapshot(badBounds, session), /control/);
});

test('complete choices only include offered enabled targets and explicit text values', () => {
	const s = fixture();
	s.surface.controls.push({ ...s.surface.controls[0], id: 'text', actions: ['type_text'] });
	s.surface.controls.push({ ...s.surface.controls[0], id: 'hidden', enabled: false });
	const task = { goal: 'goal', check: 'check', textValues: ['exact text'] };
	const { decisions, request } = actionQuestion(s, task, []);
	assert.equal(Object.keys(decisions).length, 5);
	assert.equal(Object.values(decisions).filter((d) => d.target === 'hidden').length, 0);
	assert.deepEqual(decisions.a1, { operation: 'type_text', target: 'text', text: 'exact text' });
	assert.ok(!JSON.stringify(request).includes('"bounds"'));
	assert.throws(
		() =>
			validateDecision(
				s,
				{ operation: 'type_text', target: 'text', text: 'invented' },
				task.textValues
			),
		/offered/
	);
});

test('action explosion refuses before transport', async () => {
	const s = fixture();
	s.surface.controls = Array.from({ length: 126 }, (_, i) => ({
		...s.surface.controls[0],
		id: `n${i}`
	}));
	const policy = new JevPolicy('fake-key', async () => {
		throw new Error('must not fetch');
	});
	await assert.rejects(
		policy.choose(s, { goal: 'g', check: 'c', textValues: [] }, [], new AbortController().signal),
		/too large/
	);
	assert.equal(policy.requests, 0);
});

test('Choice rejects invented, non-maximal, uncertain and malformed distributions', () => {
	const { decisions, request } = actionQuestion(
		fixture(),
		{ goal: 'g', check: 'c', textValues: [] },
		[]
	);
	const value = answer(request.questions.action.criteria).answers.action;
	assert.equal(selected(value, decisions).target, 'increment');
	for (const bad of [
		{ ...value, choice: 'invented' },
		{ ...value, confidence: 0.1 },
		{ ...value, probabilities: { a0: true } },
		{ ...value, choice: 'done' }
	])
		assert.throws(() => selected(bad, decisions), Refusal);
});

test('official SDK uses fixed origin, no redirects/retries, and counts failed attempts', async () => {
	let calls = 0;
	const policy: JevPolicy = new JevPolicy('test-secret-not-real', async (url, init) => {
		calls++;
		assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
		assert.equal(init?.redirect, 'error');
		assert.equal(policy.requests, calls);
		if (calls === 2) return new Response('private error should not be logged', { status: 503 });
		const body = JSON.parse(String(init?.body));
		return Response.json(answer(body.questions.action.criteria));
	});
	const task = { goal: 'g', check: 'c', textValues: [] },
		signal = new AbortController().signal;
	assert.equal((await policy.choose(fixture(), task, [], signal)).operation, 'click');
	assert.equal(policy.usage.input_tokens, 10);
	await assert.rejects(policy.choose(fixture(), task, [], signal), /no automatic retry/);
	assert.equal(calls, 2);
	assert.equal(policy.requests, 2);
});

test('invalid model output counts the attempt but is never dispatched', async () => {
	const policy = new JevPolicy('fake', async () => Response.json({ answers: 'bad' }));
	await assert.rejects(
		policy.choose(
			fixture(),
			{ goal: 'g', check: 'c', textValues: [] },
			[],
			new AbortController().signal
		),
		/Invalid/
	);
	assert.equal(policy.requests, 1);
});

test('entire goal runs, independently verifies, closes and returns only compact evidence', async () => {
	const { project } = await setup();
	const driver = new FakeDriver();
	const report = await runTask(project, 'counter', {
		driverFactory: () => driver,
		policyFactory: () => new ScriptPolicy()
	});
	assert.equal(report.passed, true);
	assert.equal(report.decisions, 2);
	assert.equal(driver.closed, true);
	assert.equal(report.model_requests, 0);
	assert.equal(report.visual_verification, 'unavailable');
	assert.ok(summary(report).length < 4096);
	assert.ok(!summary(report).includes('"surface"'));
	const trace = await readFile(join(report.artifacts, 'trace.jsonl'), 'utf8');
	assert.ok(trace.includes('observation'));
	assert.ok(trace.includes('executed'));
});

test('model DONE never overrides a failing host check', async () => {
	const { project } = await setup();
	const report = await runTask(project, 'counter', {
		driverFactory: () => new FakeDriver(),
		policyFactory: () => new ScriptPolicy([{ operation: 'done' }])
	});
	assert.equal(report.passed, false);
	assert.equal(report.status, 'verification_failed');
});

test('stale rejection re-observes and re-decides instead of replaying input', async () => {
	const { project } = await setup();
	const driver = new FakeDriver();
	let attempts = 0;
	driver.act = async () => {
		if (++attempts === 1) throw new Refusal('stale_observation');
		driver.count++;
	};
	const report = await runTask(project, 'counter', {
		driverFactory: () => driver,
		policyFactory: () =>
			new ScriptPolicy(
				Array.from({ length: 3 }, () => ({ operation: 'click', target: 'increment' }))
			)
	});
	assert.equal(report.passed, true);
	assert.equal(report.decisions, 3);
	assert.equal(driver.observations, 4);
});

test('cancellation during a decision never applies its late answer', async () => {
	const { project } = await setup();
	const driver = new FakeDriver(),
		abort = new AbortController();
	const policy = new ScriptPolicy();
	policy.choose = async () => {
		abort.abort();
		return { operation: 'click', target: 'increment' };
	};
	const report = await runTask(project, 'counter', {
		signal: abort.signal,
		driverFactory: () => driver,
		policyFactory: () => policy
	});
	assert.equal(report.status, 'cancelled');
	assert.equal(driver.actions, 0);
	assert.equal(driver.closed, true);
});

test('unsupported targets, transport uncertainty and missing progress stop with retained evidence', async () => {
	for (const mode of ['target', 'transport', 'progress']) {
		const { project } = await setup();
		const driver = new FakeDriver();
		if (mode === 'transport')
			driver.act = async () => {
				throw new Refusal('Native execution not confirmed; no replay');
			};
		if (mode === 'progress') driver.act = async () => {};
		const policy = new ScriptPolicy(
			Array.from({ length: 6 }, () => ({
				operation: 'click',
				target: mode === 'target' ? 'invented' : 'increment'
			}))
		);
		const report = await runTask(project, 'counter', {
			driverFactory: () => driver,
			policyFactory: () => policy
		});
		assert.equal(report.passed, false);
		assert.equal(report.status, 'blocked');
		assert.equal(driver.closed, true);
		if (mode === 'progress') assert.match(report.error!, /progress/);
	}
});
