import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { integer, object, text, Refusal, type JsonObject } from './config.ts';

export const operations = [
	'click',
	'double_click',
	'type_text',
	'scroll_up',
	'scroll_down'
] as const;
export type Operation = (typeof operations)[number];
export type Decision = {
	operation: Operation | 'wait' | 'done' | 'blocked';
	target?: string;
	text?: string;
};
export type Control = {
	id: string;
	role: string;
	label: string;
	value: string;
	enabled: boolean;
	selected: boolean;
	actions: Operation[];
	bounds: { x: number; y: number; width: number; height: number };
};
export type Snapshot = {
	protocol: 1;
	session: string;
	revision: number;
	surface: { ready: boolean; title: string; facts: JsonObject; controls: Control[] };
};
export type Verification = JsonObject & { passed: boolean };
export interface Driver {
	observe(signal: AbortSignal): Promise<Snapshot>;
	verify(check: string, signal: AbortSignal): Promise<Verification>;
	act(snapshot: Snapshot, decision: Decision, signal: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

export function snapshot(value: unknown, session: string): Snapshot {
	if (
		!object(value) ||
		value.protocol !== 1 ||
		value.session !== session ||
		!integer(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
		!object(value.surface)
	)
		throw new Refusal('Invalid snapshot identity');
	const surface = value.surface;
	if (
		typeof surface.ready !== 'boolean' ||
		!text(surface.title) ||
		!object(surface.facts) ||
		!Array.isArray(surface.controls) ||
		surface.controls.length > 512
	)
		throw new Refusal('Invalid native surface');
	const seen = new Set<string>();
	for (const node of surface.controls) {
		if (
			!object(node) ||
			!text(node.id, 256) ||
			!node.id ||
			seen.has(node.id) ||
			!text(node.role, 256) ||
			!text(node.label) ||
			!text(node.value) ||
			typeof node.enabled !== 'boolean' ||
			typeof node.selected !== 'boolean' ||
			!Array.isArray(node.actions) ||
			node.actions.some((op) => !operations.includes(op)) ||
			!object(node.bounds) ||
			['x', 'y', 'width', 'height'].some(
				(key) =>
					typeof (node.bounds as JsonObject)[key] !== 'number' ||
					!Number.isFinite((node.bounds as JsonObject)[key])
			) ||
			Number(node.bounds.width) <= 0 ||
			Number(node.bounds.height) <= 0
		)
			throw new Refusal('Invalid native control');
		seen.add(node.id);
	}
	return value as Snapshot;
}

export function validateDecision(state: Snapshot, decision: Decision, textValues: string[]) {
	if (['wait', 'done', 'blocked'].includes(decision.operation)) return;
	const target = state.surface.controls.find((node) => node.id === decision.target);
	if (
		!target?.enabled ||
		!target.actions.includes(decision.operation as Operation) ||
		(decision.operation === 'type_text' && !textValues.includes(decision.text!)) ||
		(decision.operation !== 'type_text' && decision.text !== undefined)
	)
		throw new Refusal('Decision is not an offered action');
}

export function childEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'].flatMap((key) =>
			process.env[key] === undefined ? [] : [[key, process.env[key]]]
		)
	);
}

export class StdioDriver implements Driver {
	readonly child: ChildProcessWithoutNullStreams;
	private sequence = 0;
	private buffer = Buffer.alloc(0);
	private fatal?: Refusal;
	private pending?: { resolve(value: unknown): void; reject(error: Error): void };
	private exited = false;
	private exit: Promise<void>;
	private closing?: Promise<void>;

	readonly session: string;
	constructor(command: string[], session: string, cwd: string, stderr: (chunk: Buffer) => void) {
		this.session = session;
		this.child = spawn(command[0], command.slice(1), {
			cwd,
			env: childEnvironment(),
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			detached: process.platform !== 'win32'
		});
		this.exit = new Promise((resolve) => {
			this.child.once('close', () => {
				this.exited = true;
				this.fail('Native pipe closed');
				resolve();
			});
			this.child.once('error', () => {
				this.fail('Native launch failed');
			});
		});
		this.child.stdin.on('error', () => this.fail('Native input pipe failed'));
		this.child.stdout.on('error', () => this.fail('Native output pipe failed'));
		this.child.stderr.on('error', () => this.fail('Native diagnostic pipe failed'));
		let stderrBytes = 0;
		this.child.stderr.on('data', (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > 1048576) {
				this.fail('Native diagnostics exceeded limit');
				return;
			}
			try {
				stderr(chunk);
			} catch {
				this.fail('Cannot retain native diagnostics');
			}
		});
		this.child.stdout.on('data', (chunk: Buffer) => {
			if (this.fatal) return;
			this.buffer = Buffer.concat([this.buffer, chunk]);
			if (this.buffer.length > 1048576) {
				this.fail('Native response exceeded limit');
				return;
			}
			const end = this.buffer.indexOf(10);
			if (end < 0) return;
			// Exactly one reply per in-flight command; never queue unsolicited input.
			if (!this.pending || end !== this.buffer.length - 1) {
				this.fail('Unexpected native response');
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(this.buffer.subarray(0, end).toString('utf8'));
			} catch {
				this.fail('Invalid native JSON');
				return;
			}
			this.buffer = Buffer.alloc(0);
			this.pending.resolve(value);
		});
	}

	private fail(message: string) {
		this.fatal ??= new Refusal(message);
		this.pending?.reject(this.fatal);
	}

	async request(command: JsonObject, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		if (this.fatal) throw this.fatal;
		if (this.pending) throw new Refusal('Concurrent native command refused');
		const id = ++this.sequence;
		const wire = JSON.stringify({ protocol: 1, session: this.session, id, command }) + '\n';
		if (Buffer.byteLength(wire) > 65536) throw new Refusal('Native request too large');
		const reply = await new Promise<unknown>((resolve, reject) => {
			const finish = (error?: Error, value?: unknown) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', abort);
				this.pending = undefined;
				error ? reject(error) : resolve(value);
			};
			const abort = () => {
				this.fatal = new Refusal('Native command cancelled');
				finish(this.fatal);
			};
			const timer = setTimeout(() => {
				this.fatal = new Refusal('Native command timed out');
				finish(this.fatal);
			}, 10000);
			this.pending = {
				resolve: (value) => finish(undefined, value),
				reject: (error) => finish(error)
			};
			signal.addEventListener('abort', abort, { once: true });
			this.child.stdin.write(wire);
		});
		if (!object(reply) || reply.protocol !== 1 || reply.id !== id)
			throw new Refusal('Native response identity mismatch');
		if (reply.ok !== true)
			throw new Refusal(
				reply.error === 'stale_observation' ? 'stale_observation' : 'Native request refused'
			);
		return reply.result;
	}

	async observe(signal: AbortSignal) {
		return snapshot(await this.request({ method: 'observe' }, signal), this.session);
	}
	async verify(check: string, signal: AbortSignal): Promise<Verification> {
		const result = await this.request({ method: 'verify', check }, signal);
		if (!object(result) || typeof result.passed !== 'boolean')
			throw new Refusal('Invalid independent verification');
		return result as Verification;
	}
	async act(state: Snapshot, decision: Decision, signal: AbortSignal) {
		const result = await this.request(
			{ method: 'act', action: { revision: state.revision, ...decision } },
			signal
		);
		if (!object(result) || result.executed !== true)
			throw new Refusal('Native execution not confirmed; no replay');
	}
	close() {
		return (this.closing ??= this.stop());
	}
	private async stop() {
		if (this.exited) return;
		if (!this.pending && !this.fatal) {
			try {
				await this.request({ method: 'close' }, AbortSignal.timeout(500));
			} catch {
				/* Close owned child below. */
			}
		}
		this.child.stdin.end();
		await Promise.race([this.exit, delay(300)]);
		for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
			if (this.exited) break;
			try {
				// A new process group was created at spawn; never look up or kill by application name.
				if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
				else this.child.kill(signal);
			} catch {
				/* Already exited. */
			}
			await Promise.race([this.exit, delay(500)]);
		}
		if (!this.exited) throw new Refusal('Owned child shutdown unconfirmed');
	}
}
