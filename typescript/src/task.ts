import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Refusal, readKey, resolveGoal, type GoalInput, type Project } from './config.ts';
import {
	StdioDriver,
	validateDecision,
	type Driver,
	type Verification,
	type Snapshot
} from './driver.ts';
import { JevPolicy, type Policy, type History } from './policy.ts';
export { loadProject } from './config.ts';
export type { GoalInput } from './config.ts';

export type Report = {
	protocol: 1;
	task: string | null;
	app: string;
	goal: string;
	mode: 'jev' | 'scripted';
	status: string;
	completed: boolean;
	passed: boolean;
	check: string | null;
	final_observation: string | null;
	decisions: number;
	model_requests: number;
	elapsed_ms: number;
	usage: { input_tokens: number; output_tokens: number };
	resolved_models: string[];
	verification: Verification | null;
	visual_verification: 'unavailable';
	artifacts: string;
	error?: string;
};
export type TaskOptions = {
	signal?: AbortSignal;
	progress?: (message: string) => void;
};
/** Library-only test seam. Never exposed in model arguments or project JSON. */
export type TestOptions = TaskOptions & {
	policyFactory?: (emit: (event: unknown) => void) => Policy;
	driverFactory?: (
		command: string[],
		session: string,
		cwd: string,
		stderr: (data: Buffer) => void
	) => Driver;
};

export async function runTask(
	project: Project,
	input: string | GoalInput,
	options: TestOptions = {}
): Promise<Report> {
	const { app, taskId, profile } = resolveGoal(project, input);
	options.signal?.throwIfAborted();
	const offline = Boolean(options.policyFactory);
	// Resolve the external tooling credential before launching any native process.
	const key = offline ? '' : await readKey(project);
	const session = randomUUID().replaceAll('-', '');
	const artifacts = await mkdtemp(join(tmpdir(), 'gpui-task-'));
	const trace = openSync(join(artifacts, 'trace.jsonl'), 'wx', 0o600);
	const stderr = openSync(join(artifacts, 'native.stderr.log'), 'wx', 0o600);
	const started = performance.now();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), profile.maxSeconds * 1000);
	const signal = options.signal
		? AbortSignal.any([options.signal, deadline.signal])
		: deadline.signal;
	const report: Report = {
		protocol: 1,
		task: taskId,
		app,
		goal: profile.goal,
		mode: offline ? 'scripted' : 'jev',
		status: 'limit_exceeded',
		completed: false,
		passed: false,
		check: profile.check ?? null,
		final_observation: null,
		decisions: 0,
		model_requests: 0,
		elapsed_ms: 0,
		usage: { input_tokens: 0, output_tokens: 0 },
		resolved_models: [],
		verification: null,
		visual_verification: 'unavailable',
		artifacts
	};
	let bytes = 0;
	const emit = (event: unknown) => {
		const line =
			JSON.stringify({ elapsed_ms: Math.round(performance.now() - started), event }) + '\n';
		bytes += Buffer.byteLength(line);
		if (bytes > 32 * 1024 * 1024) throw new Refusal('Trace size limit exceeded');
		writeSync(trace, line);
	};
	let driver: Driver | undefined, policy: Policy | undefined;
	let lastSnapshot: Snapshot | undefined;
	try {
		signal.throwIfAborted();
		policy = options.policyFactory?.(emit) ?? new JevPolicy(key, undefined, emit);
		const command = profile.application.map((arg) => (arg === '{session}' ? session : arg));
		driver = (options.driverFactory ?? ((...args) => new StdioDriver(...args)))(
			command,
			session,
			project.root,
			(data) => {
				writeSync(stderr, data);
			}
		);
		const history: History = [];
		let previousSurface = '',
			unchanged = 0;
		options.progress?.('Starting owned fixture window');
		for (let step = 0; step < 80; step++) {
			signal.throwIfAborted();
			const snapshot = await driver.observe(signal);
			lastSnapshot = snapshot;
			signal.throwIfAborted();
			const verification = profile.check ? await driver.verify(profile.check, signal) : null;
			signal.throwIfAborted();
			report.verification = verification;
			emit({ event: 'observation', snapshot, verification });
			if (verification?.passed === true) {
				report.status = 'passed';
				report.passed = true;
				break;
			}
			if (!snapshot.surface.ready) {
				await delay(100, undefined, { signal });
				continue;
			}
			const surface = JSON.stringify(snapshot.surface);
			if (surface === previousSurface && history.at(-1)?.result === 'executed') unchanged++;
			else unchanged = 0;
			if (unchanged >= 3) throw new Refusal('No observed progress after three inputs');
			previousSurface = surface;
			if (policy.requests >= profile.maxRequests) break;
			const decision = await policy.choose(snapshot, profile, history, signal);
			signal.throwIfAborted(); // Never apply decisions completing after deadline/cancellation.
			validateDecision(snapshot, decision, profile.textValues);
			report.decisions++;
			options.progress?.(
				`Driving fixture · ${report.decisions} decisions · ${policy.requests} Jev requests`
			);
			if (decision.operation === 'done' || decision.operation === 'blocked') {
				if (decision.operation === 'done' && !profile.check) {
					// A terminal judgment must still refer to the current semantic surface.
					lastSnapshot = await driver.observe(signal);
					signal.throwIfAborted();
					emit({ event: 'completion_observation', snapshot: lastSnapshot });
					if (!lastSnapshot.surface.ready || JSON.stringify(lastSnapshot.surface) !== surface) {
						history.push({ ...decision, result: 'stale_rejected' });
						emit({ event: 'decision', decision, result: 'stale_rejected' });
						continue;
					}
				}
				emit({ event: 'decision', decision });
				report.status =
					decision.operation === 'blocked'
						? 'blocked'
						: profile.check
							? 'verification_failed'
							: 'completed_unverified';
				break; // Model DONE can complete interaction, but never independently pass a test.
			}
			let result = 'waited';
			if (decision.operation === 'wait') await delay(100, undefined, { signal });
			else {
				try {
					await driver.act(snapshot, decision, signal);
					result = 'executed';
				} catch (error) {
					if (!(error instanceof Refusal) || error.message !== 'stale_observation') throw error;
					result = 'stale_rejected'; // Fresh observation AND new decision; no replay.
				}
			}
			// Record execution before any post-action wait/observation can fail.
			const target = snapshot.surface.controls.find((node) => node.id === decision.target);
			history.push({
				...decision,
				result,
				...(target ? { target_label: target.label, target_role: target.role } : {})
			});
			emit({ event: 'decision', decision, result });
			if (result !== 'waited') await delay(80, undefined, { signal });
		}
	} catch (error) {
		report.status = options.signal?.aborted
			? 'cancelled'
			: deadline.signal.aborted
				? 'timed_out'
				: 'blocked';
		report.error =
			error instanceof Refusal ? error.message : 'Execution failed; inspect retained artifacts';
		report.passed = false;
	} finally {
		clearTimeout(timer);
		if (driver) {
			try {
				await driver.close();
			} catch {
				report.status = 'shutdown_failed';
				report.passed = false;
				report.error = 'Owned child shutdown unconfirmed';
			}
		}
		closeSync(trace);
		closeSync(stderr);
		report.completed = report.status === 'passed' || report.status === 'completed_unverified';
		if (lastSnapshot) {
			report.final_observation = join(artifacts, 'final-observation.json');
			writeFileSync(report.final_observation, JSON.stringify(lastSnapshot) + '\n', {
				flag: 'wx',
				mode: 0o600
			});
		}
		report.elapsed_ms = Math.round(performance.now() - started);
		report.model_requests = policy?.requests ?? 0;
		report.usage = policy?.usage ?? report.usage;
		report.resolved_models = [...(policy?.models ?? [])];
		writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
			flag: 'wx',
			mode: 0o600
		});
	}
	return report;
}

/** Deliberately small: no observations, per-click history, SDK payloads or images in model context. */
export function summary(report: Report): string {
	return JSON.stringify({
		task: report.task,
		app: report.app,
		status: report.status,
		completed: report.completed,
		passed: report.passed,
		final_observation: report.final_observation,
		check: report.check,
		mode: report.mode,
		decisions: report.decisions,
		requests: report.model_requests,
		elapsed_ms: report.elapsed_ms,
		tokens: report.usage,
		visual_verification: report.visual_verification,
		error: report.error,
		report: join(report.artifacts, 'report.json'),
		trace: join(report.artifacts, 'trace.jsonl')
	});
}
