import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { harness } from './extension-harness.ts';
import {
	answer,
	config,
	FakeDriver,
	ScriptPolicy,
	setup,
	withKey,
	withTransport
} from './helpers.ts';
import { runTask } from '../src/task.ts';

async function projectRoot() {
	const { root } = await setup();
	await writeFile(join(root, '.gpui-agent.json'), JSON.stringify(config()));
	return root;
}

test('one registered invocation performs the entire goal and emits compact progress/result', async () => {
	const root = await projectRoot();
	let runs = 0;
	const driver = new FakeDriver();
	const h = harness(root, (project, id, options) => {
		runs++;
		return runTask(project, id, {
			...options,
			driverFactory: () => driver,
			policyFactory: () => new ScriptPolicy()
		});
	});
	await h.events.get('session_start')!({}, h.ctx);
	assert.match(h.tool().description, /counter/);
	const result = await h.call('counter');
	const report = JSON.parse(result.content[0].text);
	assert.equal(report.passed, true);
	assert.equal(runs, 1);
	assert.equal(driver.actions, 2);
	assert.equal(h.updates.length, 3);
	assert.equal(h.entries.length, 1);
	assert.equal(report.visual_verification, 'unavailable');
	assert.equal(driver.closed, true);
	assert.ok(!JSON.stringify(result).includes('"surface"'));
});

test('configured key alone reaches SDK transport through the tool; no grants or approval UI', async () => {
	const root = await projectRoot();
	let calls = 0;
	const drivers: FakeDriver[] = [];
	const h = harness(root, (project, id, options) => {
		const driver = new FakeDriver();
		drivers.push(driver);
		return runTask(project, id, { ...options, driverFactory: () => driver });
	});
	assert.equal(h.commands.size, 0);
	assert.equal(h.ctx.hasUI, false);
	await withKey('fake-extension-secret', () =>
		withTransport(
			async (_url, init) => {
				calls++;
				const body = JSON.parse(String(init?.body));
				return Response.json(answer(body.questions.action.criteria));
			},
			async () => {
				for (let run = 0; run < 2; run++) {
					const result = await h.call('counter');
					const report = JSON.parse(result.content[0].text);
					assert.equal(report.passed, true);
					assert.equal(report.mode, 'jev');
					assert.equal(report.requests, 2);
					for (const file of [report.report, report.trace])
						assert.ok(!(await readFile(file, 'utf8')).includes('fake-extension-secret'));
				}
			}
		)
	);
	assert.equal(calls, 4);
	assert.ok(drivers.every((driver) => driver.closed));
	assert.ok(h.entries.every((entry) => entry.type === 'gpui-task'));
	assert.deepEqual(await readdir(root), ['.gpui-agent.json']);
});

test('discovery needs neither credentials nor a ledger and never launches or bills', async () => {
	const root = await projectRoot();
	const h = harness(root, async () => {
		throw new Error('Must not launch');
	});
	await withKey(undefined, () =>
		withTransport(
			async () => {
				throw new Error('Must not fetch');
			},
			async () => {
				const listing = JSON.parse((await h.call()).content[0].text);
				assert.deepEqual(Object.keys(listing), ['apps', 'tasks']);
				assert.equal(listing.tasks[0].id, 'counter');
			}
		)
	);
	assert.deepEqual(await readdir(root), ['.gpui-agent.json']);
});

test('untrusted project cannot discover or execute even with a configured key', async () => {
	const h = harness(await projectRoot());
	h.ctx.isProjectTrusted = () => false;
	await withKey('fake', async () => {
		await assert.rejects(h.call(), /Trust/);
		await assert.rejects(h.call('counter'), /Trust/);
	});
});

test('shutdown during configuration loading cannot start late work', async () => {
	const root = await projectRoot();
	let ran = false;
	const h = harness(root, async (...args) => {
		ran = true;
		return runTask(...args);
	});
	const refused = assert.rejects(h.call('counter'), /shut down/);
	await h.events.get('session_shutdown')!({ reason: 'reload' });
	await refused;
	assert.equal(ran, false);
});

test('session shutdown aborts and awaits owned work; duplicate invocation is refused', async () => {
	const root = await projectRoot();
	const driver = new FakeDriver();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const policy = new ScriptPolicy();
	const h = harness(root, (project, id, options) => {
		policy.choose = async () => {
			started();
			await delay(10000, undefined, { signal: options?.signal });
			return { operation: 'done' };
		};
		return runTask(project, id, {
			...options,
			driverFactory: () => driver,
			policyFactory: () => policy
		});
	});
	const pending = h.call('counter');
	await ready;
	await assert.rejects(h.call('counter'), /already running/);
	await h.events.get('session_shutdown')!({ reason: 'reload' });
	assert.equal(JSON.parse((await pending).content[0].text).status, 'cancelled');
	assert.equal(driver.closed, true);
	assert.equal(driver.actions, 0);
});
