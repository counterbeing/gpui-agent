import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JevPolicy } from '../src/policy.ts';
import { runTask } from '../src/task.ts';
import { fixture, setup, ScriptPolicy, FakeDriver } from './helpers.ts';
const task = { goal: 'g', check: 'c', textValues: [] };

test('SDK cancellation counts its attempt and returns no decision', async () => {
	let called!: () => void;
	const started = new Promise<void>((resolve) => {
		called = resolve;
	});
	const controller = new AbortController();
	const policy = new JevPolicy('fake', async (_url, init) => {
		called();
		await delay(10000, undefined, { signal: init?.signal ?? undefined });
		return Response.json({});
	});
	const pending = policy.choose(fixture(), task, [], controller.signal);
	await started;
	controller.abort();
	await assert.rejects(pending);
	assert.equal(policy.requests, 1);
});

test('model response size is bounded and oversized attempts are not retried', async () => {
	let calls = 0;
	const policy = new JevPolicy('fake', async () => {
		calls++;
		return new Response('x'.repeat(1048577));
	});
	await assert.rejects(
		policy.choose(fixture(), task, [], new AbortController().signal),
		/too large/
	);
	assert.equal(calls, 1);
	assert.equal(policy.requests, 1);
});

test('cancelled calls refuse before transport', async () => {
	let called = false;
	const policy = new JevPolicy('fake', async () => {
		called = true;
		return Response.json({});
	});
	await assert.rejects(policy.choose(fixture(), task, [], AbortSignal.abort()));
	assert.equal(called, false);
	assert.equal(policy.requests, 0);
});

test('per-run request limit stops before the next policy call', async () => {
	const { project } = await setup();
	project.tasks.counter.maxRequests = 1;
	const policy = new ScriptPolicy(),
		driver = new FakeDriver();
	policy.choose = async () => {
		policy.requests++;
		return { operation: 'click', target: 'increment' };
	};
	const report = await runTask(project, 'counter', {
		policyFactory: () => policy,
		driverFactory: () => driver
	});
	assert.equal(report.status, 'limit_exceeded');
	assert.equal(report.model_requests, 1);
	assert.equal(driver.actions, 1);
	assert.equal(driver.closed, true);
});

test('wall deadline rejects late decisions and always closes the owned driver', async () => {
	const { project } = await setup();
	project.tasks.counter.maxSeconds = 1;
	const policy = new ScriptPolicy(),
		driver = new FakeDriver();
	policy.choose = async () => {
		await delay(1050);
		return { operation: 'click', target: 'increment' };
	};
	const report = await runTask(project, 'counter', {
		policyFactory: () => policy,
		driverFactory: () => driver
	});
	assert.equal(report.status, 'timed_out');
	assert.equal(driver.actions, 0);
	assert.equal(driver.closed, true);
});
