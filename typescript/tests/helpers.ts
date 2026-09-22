import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import type { Decision, Driver, Snapshot } from '../src/driver.ts';
import type { Policy } from '../src/policy.ts';

export const session = 'a'.repeat(32);
export const fixture = (): Snapshot => ({
	protocol: 1,
	session,
	revision: 1,
	surface: {
		ready: true,
		title: 'Fixture',
		facts: {},
		controls: [
			{
				id: 'increment',
				label: 'Increment',
				role: 'button',
				value: '',
				enabled: true,
				selected: false,
				actions: ['click'],
				bounds: { x: 0, y: 0, width: 10, height: 10 }
			}
		]
	}
});
export function config() {
	return {
		version: 1,
		fixtureOnly: true,
		tasks: {
			counter: {
				goal: 'Increment twice',
				check: 'count-two',
				textValues: [],
				application: ['fixture-only', '{session}'],
				maxRequests: 10,
				maxSeconds: 5
			}
		}
	};
}
export async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'gpui-pure-test-'));
	const project = parseConfig(JSON.stringify(config()), root);
	return { root, project };
}
export async function withKey<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.TYPESAFE_API_KEY;
	if (key === undefined) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = key;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previous;
	}
}

/** Real SDK, fake HTTP only. Never calls the saved network transport. */
export async function withTransport<T>(transport: typeof fetch, fn: () => Promise<T>): Promise<T> {
	const previous = globalThis.fetch;
	const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
	const proxies = names.map((name) => [name, process.env[name]] as const);
	for (const name of names) delete process.env[name];
	globalThis.fetch = transport;
	try {
		return await fn();
	} finally {
		globalThis.fetch = previous;
		for (const [name, value] of proxies) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

export class ScriptPolicy implements Policy {
	requests = 0;
	usage = { input_tokens: 0, output_tokens: 0 };
	models = new Set<string>();
	private decisions: Decision[];
	constructor(
		decisions: Decision[] = [
			{ operation: 'click', target: 'increment' },
			{ operation: 'click', target: 'increment' }
		]
	) {
		this.decisions = [...decisions];
	}
	async choose() {
		return this.decisions.shift() ?? { operation: 'done' as const };
	}
}
export class FakeDriver implements Driver {
	count = 0;
	closed = false;
	observations = 0;
	actions = 0;
	async observe() {
		this.observations++;
		const s = fixture();
		s.revision = this.observations;
		s.surface.facts = { count: this.count };
		return s;
	}
	async verify() {
		return { passed: this.count === 2, count: this.count };
	}
	async act() {
		this.actions++;
		this.count++;
	}
	async close() {
		this.closed = true;
	}
}
export function answer(criteria: Record<string, unknown>, chosen = Object.keys(criteria)[0]) {
	return {
		model: 'offline-mock',
		usage: { input_tokens: 10, output_tokens: 2 },
		answers: {
			action: {
				type: 'choice',
				choice: chosen,
				confidence: 1,
				probabilities: Object.fromEntries(
					Object.keys(criteria).map((key) => [key, key === chosen ? 1 : 0])
				)
			}
		}
	};
}
