import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readKey } from '../src/config.ts';
import { setup, withKey } from './helpers.ts';

test('pi environment wins without opening the configured env file', async () => {
	const { root, project } = await setup();
	project.envFile = join(root, 'does-not-exist.env');
	await withKey('fake-environment-key', async () =>
		assert.equal(await readKey(project), 'fake-environment-key')
	);
});

test('project envFile fallback is read literally, without loading unrelated variables', async () => {
	const { root, project } = await setup();
	project.envFile = join(root, '.env');
	await writeFile(
		join(root, '.env'),
		'# fixture\nGPUI_TEST_UNRELATED=should-not-load\nexport TYPESAFE_API_KEY="fake-project-key"\n'
	);
	const before = process.env.GPUI_TEST_UNRELATED;
	await withKey(undefined, async () => assert.equal(await readKey(project), 'fake-project-key'));
	assert.equal(process.env.GPUI_TEST_UNRELATED, before);
});

test('envFile is explicit: an unconfigured .env is not read automatically', async () => {
	const { root, project } = await setup();
	await writeFile(join(root, '.env'), 'TYPESAFE_API_KEY=fake-ignored-key\n');
	await withKey(undefined, () => assert.rejects(readKey(project), /Set TYPESAFE_API_KEY/));
});

test('empty or missing configured credentials give key setup guidance', async () => {
	const { root, project } = await setup();
	project.envFile = join(root, '.env');
	await writeFile(join(root, '.env'), 'TYPESAFE_API_KEY=""\n');
	await withKey(undefined, () => assert.rejects(readKey(project), /Set TYPESAFE_API_KEY/));
});
