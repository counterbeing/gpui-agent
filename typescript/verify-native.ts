#!/usr/bin/env node
/** Explicit opt-in native verification. NEVER imported by the automatic test suite.
 * Executes the actual registered pi tool body. Offline by default; --live explicitly calls Jev.
 * Projects/configurations must launch fresh generated fixtures only.
 */
import { readFile } from 'node:fs/promises';
import { harness } from './tests/extension-harness.ts';
import { runTask } from './src/task.ts';
import { object, Refusal } from './src/config.ts';
import type { Snapshot, Decision } from './src/driver.ts';
import type { Policy } from './src/policy.ts';

if (
	![5, 7].includes(process.argv.length) ||
	process.argv[2] !== '--fixtures-only' ||
	(process.argv.length === 7 && (process.argv[5] !== '--expect-text' || !process.argv[6]))
) {
	throw new Error(
		"Usage: node verify-native.ts --fixtures-only 'GOAL_JSON' SCRIPT.json|--live [--expect-text TEXT] (fresh fixtures only; --live sends UI state to TypeSafe). Legacy v1 task IDs also accepted."
	);
}
const [, , , input, scriptPath] = process.argv;
const task = input.startsWith('{') ? JSON.parse(input) : input;
const expectedText = process.argv[6];
const live = scriptPath === '--live';
const steps: unknown = live ? [] : JSON.parse(await readFile(scriptPath, 'utf8'));
if (!Array.isArray(steps) || steps.length > 80 || !steps.every(object))
	throw new Error('Invalid offline script');
if (!live)
	globalThis.fetch = async () => {
		throw new Error('Network prohibited in native offline verification');
	};
class NativeScript implements Policy {
	requests = 0;
	usage = { input_tokens: 0, output_tokens: 0 };
	models = new Set<string>();
	index = 0;
	async choose(snapshot: Snapshot): Promise<Decision> {
		const step = (steps as Record<string, unknown>[])[this.index];
		if (!step) return { operation: 'done' };
		if (['wait', 'done', 'blocked'].includes(String(step.operation))) {
			this.index++;
			return step as Decision;
		}
		const controls = snapshot.surface.controls.filter(
			(node) =>
				node.enabled &&
				node.actions.includes(step.operation as any) &&
				(step.id === undefined || node.id === step.id) &&
				(step.label === undefined || node.label === step.label)
		);
		if (controls.length === 0 && step.waitFor === true) return { operation: 'wait' };
		if (controls.length !== 1) throw new Refusal('Offline script target missing or ambiguous');
		this.index++;
		return {
			operation: step.operation,
			target: controls[0].id,
			...(step.text === undefined ? {} : { text: step.text })
		} as Decision;
	}
}
const h = harness(
	process.cwd(),
	live
		? runTask
		: (project, id, options) =>
				runTask(project, id, { ...options, policyFactory: () => new NativeScript() })
);
await h.events.get('session_start')!({}, h.ctx);
const result = await h.call(task);
const report = JSON.parse((result.content[0] as { text: string }).text);
// Test-only, generic post-run assertion. It never influences Jev or the runner's outcome.
let externalAssertion;
if (expectedText) {
	const final: Snapshot | undefined = report.final_observation
		? JSON.parse(await readFile(report.final_observation, 'utf8'))
		: undefined;
	const content = final?.surface.facts.accessibility_content;
	const nodes = [...(final?.surface.controls ?? []), ...(Array.isArray(content) ? content : [])];
	externalAssertion = {
		kind: 'native_tree_text',
		text: expectedText,
		passed: nodes.some(
			(node) => object(node) && (node.label === expectedText || node.value === expectedText)
		)
	};
}
console.log(
	JSON.stringify(
		{
			...report,
			external_assertion: externalAssertion,
			verification_method: live
				? 'registered pi tool handler harness, live Jev, actual owned GPUI process'
				: 'registered pi tool handler harness, offline script, actual owned GPUI process',
			paid_requests: report.requests
		},
		null,
		2
	)
);
process.exitCode = report.completed && externalAssertion?.passed !== false ? 0 : 1;
