import { registerGpui } from '../src/extension.ts';
import { runTask, type GoalInput } from '../src/task.ts';

export function harness(root: string, executeTask = runTask) {
	const events = new Map<string, (...args: any[]) => Promise<void>>();
	const commands = new Map<string, any>();
	const entries: any[] = [],
		updates: string[] = [];
	let tool: any;
	const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true };
	const api = {
		registerTool(value: any) {
			tool = value;
		},
		registerCommand(name: string, value: any) {
			commands.set(name, value);
		},
		on(event: string, callback: any) {
			events.set(event, callback);
		},
		appendEntry(type: string, data: any) {
			entries.push({ type, data });
		}
	};
	registerGpui(api as any, executeTask);
	return {
		ctx,
		events,
		commands,
		entries,
		updates,
		tool: () => tool,
		call: (input?: string | GoalInput, signal?: AbortSignal) =>
			tool.execute(
				'test-invocation',
				typeof input === 'string' ? { task: input } : (input ?? {}),
				signal,
				(result: any) => updates.push(result.content[0].text),
				ctx
			)
	};
}
