import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StdioDriver } from '../src/driver.ts';
import { session } from './helpers.ts';
const script = fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url));
const signal = () => AbortSignal.timeout(3000);
function driver(mode = 'normal') {
	return new StdioDriver(
		[process.execPath, script, mode, session],
		session,
		process.cwd(),
		() => {}
	);
}

test('real owned pipes drive complete protocol without inherited credentials', async () => {
	const prior = process.env.TYPESAFE_API_KEY;
	const unrelated = process.env.UNRELATED_TEST_SECRET;
	process.env.TYPESAFE_API_KEY = 'fixture-canary';
	process.env.UNRELATED_TEST_SECRET = 'other-canary';
	const d = driver();
	try {
		for (let n = 0; n < 2; n++)
			await d.act(await d.observe(signal()), { operation: 'click', target: 'increment' }, signal());
		const result = await d.verify('count-two', signal());
		assert.equal(result.passed, true);
		assert.equal(result.credentialPresent, false);
	} finally {
		await d.close();
		if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = prior;
		if (unrelated === undefined) delete process.env.UNRELATED_TEST_SECRET;
		else process.env.UNRELATED_TEST_SECRET = unrelated;
	}
	assert.notEqual(d.child.exitCode, null);
});

for (const [mode, reason] of [
	['wrong-id', /identity/],
	['oversize', /limit/]
] as const) {
	test(`real pipes refuse ${mode} and close only their child`, async () => {
		const d = driver(mode);
		try {
			await assert.rejects(d.observe(signal()), reason);
		} finally {
			await d.close();
		}
		assert.ok(d.child.exitCode !== null || d.child.signalCode !== null);
	});
}

test('uncertain action acknowledgement refuses rather than silently succeeding', async () => {
	const d = driver('uncertain');
	try {
		await assert.rejects(
			d.act(await d.observe(signal()), { operation: 'click', target: 'increment' }, signal()),
			/not confirmed/
		);
	} finally {
		await d.close();
	}
});

test('abort interrupts a hung native reply and closes its child; sibling survives', async () => {
	const d = driver('hang'),
		sibling = driver();
	try {
		await assert.rejects(d.observe(AbortSignal.timeout(30)), /cancelled/);
		await d.close();
		assert.equal((await sibling.observe(signal())).surface.ready, true);
	} finally {
		await d.close();
		await sibling.close();
	}
});

test('missing executable is a bounded safe failure, not an unhandled stream error', async () => {
	const d = new StdioDriver(['/nonexistent/gpui-fixture'], session, process.cwd(), () => {});
	try {
		await assert.rejects(d.observe(signal()), /launch failed|pipe/);
	} finally {
		await d.close();
	}
});
