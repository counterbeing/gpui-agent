import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig, resolveGoal, Refusal, type GoalInput } from '../src/config.ts';
import { runTask, summary } from '../src/task.ts';
import { harness } from './extension-harness.ts';
import {
	FakeDriver,
	ScriptPolicy,
	setup,
	withKey,
	withTransport,
	answer,
	fixture
} from './helpers.ts';
import type { Driver } from '../src/driver.ts';

function config() {
	return {
		version: 2,
		fixtureOnly: true,
		apps: {
			counter: {
				description: 'Generated Counter',
				application: ['fixture-only', '{session}'],
				maxRequests: 8,
				maxSeconds: 5
			}
		}
	};
}
async function project() {
	const { root } = await setup();
	await writeFile(join(root, '.gpui-agent.json'), JSON.stringify(config()));
	return parseConfig(JSON.stringify(config()), root);
}
const goal: GoalInput = { app: 'counter', goal: 'Increment twice' };
function uncheckedDriver() {
	const driver = new FakeDriver();
	driver.verify = async () => {
		throw new Error('Unrequested verifier must not run');
	};
	return driver;
}

test('version 2 needs only app launch settings; arbitrary goals do not mutate configuration', async () => {
	const p = await project(),
		original = JSON.stringify(p);
	assert.deepEqual(Object.keys(p.tasks), []);
	for (const text of ['Click once', 'Click seven times', 'Inspect the initial count']) {
		assert.equal(resolveGoal(p, { app: 'counter', goal: text }).profile.goal, text);
	}
	assert.equal(JSON.stringify(p), original);
	const c = config();
	assert.throws(() => parseConfig(JSON.stringify({ ...c, tasks: {} }), '/fixture'), Refusal);
	assert.throws(
		() => parseConfig(JSON.stringify({ ...c, fixtureOnly: false }), '/fixture'),
		Refusal
	);
	assert.throws(
		() =>
			parseConfig(
				JSON.stringify({ ...c, apps: { counter: { ...c.apps.counter, goal: 'preset' } } }),
				'/fixture'
			),
		Refusal
	);
});

test('quoted goal literals or explicit call inputs supply text, never project or UI extraction', async () => {
	const p = await project();
	const request = { app: 'counter', goal: 'Search for "未来" then “one” then `two`; "未来" again' };
	assert.deepEqual(resolveGoal(p, request).profile.textValues, ['未来', 'one', 'two']);
	assert.deepEqual(
		resolveGoal(p, { ...request, textValues: ['', 'explicit'] }).profile.textValues,
		['', 'explicit']
	);
	assert.deepEqual(resolveGoal(p, { ...request, textValues: [] }).profile.textValues, []);
	assert.deepEqual(resolveGoal(p, goal).profile.textValues, []);
});

for (const [name, input] of Object.entries({
	'missing goal': { app: 'counter' },
	'missing app': { goal: 'Click' },
	'empty goal': { ...goal, goal: ' ' },
	'unknown app': { ...goal, app: 'toString' },
	'long goal': { ...goal, goal: 'x'.repeat(4097) },
	'null check': { ...goal, check: null },
	'malformed check': { ...goal, check: '\ud800' },
	'null inputs': { ...goal, textValues: null },
	'empty check': { ...goal, check: '' },
	'caller executable': { ...goal, application: ['evil', '{session}'] },
	'caller limits': { ...goal, maxRequests: 999 },
	'caller credentials': { ...goal, envFile: '.env' },
	'too many inputs': { ...goal, textValues: Array(33).fill('a') },
	'UTF-8 overflow': { ...goal, textValues: ['界'.repeat(342)] },
	'control character': { ...goal, textValues: ['bad\n'] },
	'lone surrogate': { ...goal, textValues: ['\ud800'] },
	'quoted overflow': { ...goal, goal: `Type "${'a'.repeat(1025)}"` }
}))
	test(`free-form input refuses ${name} before credentials, policy or launch`, async () => {
		const p = await project();
		p.envFile = '/never-read-this';
		let started = false;
		await assert.rejects(
			runTask(p, input as GoalInput, {
				driverFactory: () => {
					started = true;
					return new FakeDriver();
				},
				policyFactory: () => {
					started = true;
					return new ScriptPolicy();
				}
			}),
			Refusal
		);
		assert.equal(started, false);
	});

test('no-check completion skips Verify, retains a fresh observation, and never claims passed', async () => {
	const p = await project(),
		driver = uncheckedDriver();
	const report = await runTask(p, goal, {
		driverFactory: () => driver,
		policyFactory: () => new ScriptPolicy()
	});
	assert.equal(report.status, 'completed_unverified');
	assert.equal(report.completed, true);
	assert.equal(report.passed, false);
	assert.equal(report.task, null);
	assert.equal(report.check, null);
	assert.equal(report.verification, null);
	assert.equal(report.decisions, 3);
	assert.equal(driver.count, 2);
	assert.equal(driver.closed, true);
	const final = JSON.parse(await readFile(report.final_observation!, 'utf8'));
	assert.equal(final.surface.facts.count, 2);
	assert.equal(final.revision, 4); // fresh terminal observation, not just the pre-model snapshot
	assert.ok(Buffer.byteLength(summary(report)) < 4096);
	assert.ok(!summary(report).includes('"surface"'));
});

test('optional independent check still passes without requesting model DONE', async () => {
	const report = await runTask(
		await project(),
		{ ...goal, check: 'count-two' },
		{
			driverFactory: () => new FakeDriver(),
			policyFactory: () => new ScriptPolicy()
		}
	);
	assert.equal(report.completed, true);
	assert.equal(report.passed, true);
	assert.equal(report.status, 'passed');
	assert.equal(report.decisions, 2);
});

test('a failing optional check cannot be bypassed with model DONE', async () => {
	const report = await runTask(
		await project(),
		{ ...goal, check: 'count-two' },
		{
			driverFactory: () => new FakeDriver(),
			policyFactory: () => new ScriptPolicy([{ operation: 'done' }])
		}
	);
	assert.equal(report.status, 'verification_failed');
	assert.equal(report.completed, false);
	assert.equal(report.passed, false);
});

test('terminal DONE is re-decided if the native surface changes during the model call', async () => {
	const driver = uncheckedDriver(),
		policy = new ScriptPolicy();
	let calls = 0;
	policy.choose = async () => {
		if (++calls === 1) driver.count++;
		return { operation: 'done' };
	};
	const report = await runTask(await project(), goal, {
		driverFactory: () => driver,
		policyFactory: () => policy
	});
	assert.equal(calls, 2);
	assert.equal(report.status, 'completed_unverified');
	assert.match(await readFile(join(report.artifacts, 'trace.jsonl'), 'utf8'), /stale_rejected/);
});

test('shutdown failure invalidates completion, even after a terminal model judgment', async () => {
	const driver = uncheckedDriver();
	driver.close = async () => {
		throw new Error('fixture shutdown failure');
	};
	const report = await runTask(await project(), goal, {
		driverFactory: () => driver,
		policyFactory: () => new ScriptPolicy([{ operation: 'done' }])
	});
	assert.equal(report.status, 'shutdown_failed');
	assert.equal(report.completed, false);
	assert.equal(report.passed, false);
});

test('no-check requests keep configured request limits and close their owned app', async () => {
	const p = await project();
	p.apps.counter.maxRequests = 1;
	const policy = new ScriptPolicy(),
		driver = uncheckedDriver();
	policy.choose = async () => {
		policy.requests++;
		return { operation: 'click', target: 'increment' };
	};
	const report = await runTask(p, goal, {
		driverFactory: () => driver,
		policyFactory: () => policy
	});
	assert.equal(report.status, 'limit_exceeded');
	assert.equal(report.completed, false);
	assert.equal(driver.count, 1);
	assert.equal(driver.closed, true);
});

test('one registered free-form invocation uses the real SDK path, with no task/check catalog', async () => {
	const p = await project(),
		driver = uncheckedDriver();
	const h = harness(p.root, (project, input, options) =>
		runTask(project, input, { ...options, driverFactory: () => driver })
	);
	await h.events.get('session_start')!({}, h.ctx);
	assert.match(h.tool().description, /Configured apps: counter/);
	const listing = JSON.parse((await h.call()).content[0].text);
	assert.deepEqual(Object.keys(listing), ['apps']);
	let calls = 0;
	await withKey('fake-goal-secret', () =>
		withTransport(
			async (_url, init) => {
				calls++;
				const body = JSON.parse(String(init?.body));
				assert.equal(body.state.goal, goal.goal);
				if (driver.count > 0) {
					assert.equal(body.state.recent_actions.at(-1).target_label, 'Increment');
					assert.equal(body.state.recent_actions.at(-1).target_role, 'button');
				}
				return Response.json(
					answer(body.questions.action.criteria, driver.count === 2 ? 'done' : 'a0')
				);
			},
			async () => {
				const report = JSON.parse((await h.call(goal)).content[0].text);
				assert.equal(report.status, 'completed_unverified');
				assert.equal(report.completed, true);
				assert.equal(report.passed, false);
				assert.equal(report.requests, 3);
				assert.equal(calls, 3);
				for (const file of [report.report, report.trace, report.final_observation])
					assert.ok(!(await readFile(file, 'utf8')).includes('fake-goal-secret'));
			}
		)
	);
	assert.equal(h.entries.length, 1);
	assert.equal(driver.closed, true);
	assert.equal(h.commands.size, 0);
});

test('call-time Unicode text reaches real SDK choices and input without a configured text bank', async () => {
	const p = await project(),
		value = 'call-time 未来';
	let current = '',
		closed = false;
	const driver: Driver = {
		async observe() {
			const s = fixture();
			s.surface.controls = [
				{
					...s.surface.controls[0],
					id: 'query',
					label: 'Search',
					role: 'TextInput',
					value: current,
					actions: ['type_text']
				}
			];
			return s;
		},
		async verify() {
			throw new Error('No check requested');
		},
		async act(_snapshot, decision) {
			assert.equal(decision.operation, 'type_text');
			assert.equal(decision.text, value);
			current = decision.text!;
		},
		async close() {
			closed = true;
		}
	};
	await withKey('fake-text-key', () =>
		withTransport(
			async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				assert.ok(
					Object.values(body.questions.action.criteria).some((criterion) =>
						String(criterion).includes(value)
					)
				);
				return Response.json(answer(body.questions.action.criteria, current ? 'done' : 'a0'));
			},
			async () => {
				const report = await runTask(
					p,
					{ app: 'counter', goal: 'Search for the supplied phrase', textValues: [value] },
					{ driverFactory: () => driver }
				);
				assert.equal(report.status, 'completed_unverified');
				assert.equal(report.model_requests, 2);
				assert.equal(current, value);
				assert.equal(closed, true);
			}
		)
	);
});

test('free-form discovery requires neither key nor launch; incomplete calls are not discovery', async () => {
	const p = await project();
	await writeFile(
		join(p.root, '.gpui-agent.json'),
		JSON.stringify({ ...config(), envFile: 'does-not-exist' })
	);
	const h = harness(p.root);
	await withKey(undefined, async () => {
		assert.equal(JSON.parse((await h.call()).content[0].text).apps[0].id, 'counter');
		await assert.rejects(h.call({ app: 'counter' } as GoalInput), /nonempty goal/);
		await assert.rejects(h.call({ ...goal, task: 'counter' } as any), /cannot be combined/);
		h.ctx.isProjectTrusted = () => false;
		await assert.rejects(h.call(goal), /Trust/);
	});
});
