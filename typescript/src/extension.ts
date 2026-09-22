import { Type } from '@earendil-works/pi-ai';
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext
} from '@earendil-works/pi-coding-agent';
import { loadProject, runTask, summary } from './task.ts';
import { keys, object, Refusal, type GoalInput } from './config.ts';

/** Generic pi adapter. No app-specific goals, native paths or per-click tools. */
export default function (pi: ExtensionAPI) {
	registerGpui(pi);
}

/** Injectable library call for offline adapter verification only. */
export function registerGpui(pi: ExtensionAPI, executeTask = runTask) {
	const active = new Map<AbortController, Promise<unknown>>();
	let disposed = false;
	const projectFor = async (ctx: ExtensionContext) => {
		if (disposed) throw new Refusal('GPUI extension session has shut down');
		if (!ctx.isProjectTrusted())
			throw new Refusal('Trust this project before loading GPUI launch configuration');
		const project = await loadProject(ctx.cwd);
		if (disposed) throw new Refusal('GPUI extension session has shut down');
		return project;
	};
	const register = (catalog = '') =>
		pi.registerTool(
			defineTool({
				name: 'gpui_task',
				label: 'GPUI goal',
				description:
					'Drive a free-form goal in an owned GPUI fixture app in ONE invocation. Supply app and goal; no configured task or host check required. Optional textValues supplies exact text for typing; otherwise double-quoted, curly-double-quoted or backtick phrases in the goal are offered as text. Optional check names an independent native assertion. Without a check, completion is explicitly unverified, never passed. Omit all arguments to list apps without launch, key reads or billing. Uses TYPESAFE_API_KEY from the pi environment or project envFile. Compact result (<4 KB); observations stay in bounded local artifacts. No visual certification. ' +
					catalog,
				promptSnippet:
					'Delegate a whole free-form native GPUI goal; distinguish completion from independently verified success',
				promptGuidelines: [
					'Use gpui_task once with app and goal for an entire native workflow rather than driving each click with bash.',
					'For gpui_task typing, include exact textValues in this call or quote the intended text in the goal; no project text bank or text-generation model is needed. Supply an empty string explicitly when clearing a field.',
					'gpui_task completed_unverified means the interaction policy reported completion, not that a test passed. Only passed:true means an independent host check passed. Neither certifies pixels, accessibility or permission to mutate content.',
					'If gpui_task blocks, inspect its report/trace before escalating. Never bypass launch admission or repeatedly relaunch to evade per-run limits.'
				],
				parameters: Type.Object(
					{
						app: Type.Optional(
							Type.String({ maxLength: 64, description: 'Configured app launch profile ID' })
						),
						goal: Type.Optional(
							Type.String({
								minLength: 1,
								maxLength: 4096,
								description: 'Free-form interaction goal'
							})
						),
						textValues: Type.Optional(
							Type.Array(Type.String({ maxLength: 1024 }), {
								maxItems: 32,
								description:
									'Exact text inputs for this invocation; overrides quoted-goal extraction'
							})
						),
						check: Type.Optional(
							Type.String({
								minLength: 1,
								maxLength: 128,
								description: 'Optional independent native assertion name; not executable code'
							})
						),
						task: Type.Optional(
							Type.String({
								maxLength: 64,
								description: 'Optional version-1 preset compatibility; do not combine with app/goal'
							})
						)
					},
					{ additionalProperties: false }
				),
				async execute(_id, params, signal, onUpdate, ctx) {
					const project = await projectFor(ctx);
					if (disposed) throw new Refusal('GPUI extension session has shut down');
					if (!object(params))
						throw new Refusal('Provide an app and goal, or no arguments to discover apps');
					keys(params, ['app', 'goal', 'textValues', 'check', 'task']);
					if (Object.keys(params).length === 0) {
						const listing = {
							apps: Object.entries(project.apps).map(([id, app]) => ({
								id,
								description: app.description
							})),
							...(Object.keys(project.tasks).length
								? {
										tasks: Object.entries(project.tasks).map(([id, task]) => ({
											id,
											goal: task.goal.slice(0, 160),
											check: task.check
										}))
									}
								: {})
						};
						let output = JSON.stringify(listing);
						if (Buffer.byteLength(output) > 12000)
							output = JSON.stringify({
								apps: Object.keys(project.apps),
								tasks: Object.keys(project.tasks)
							});
						return { content: [{ type: 'text', text: output }], details: {} };
					}
					let input: string | GoalInput;
					if (params.task !== undefined) {
						if (typeof params.task !== 'string' || !params.task || Object.keys(params).length !== 1)
							throw new Refusal('A legacy task cannot be combined with free-form goal arguments');
						input = params.task;
					} else input = params as GoalInput; // runTask independently validates before launch/key reads.
					if (active.size) throw new Refusal('A GPUI goal is already running in this session');
					const controller = new AbortController();
					const abort = () => controller.abort();
					signal?.addEventListener('abort', abort, { once: true });
					if (signal?.aborted) abort();
					const pending = executeTask(project, input, {
						signal: controller.signal,
						progress: (message) =>
							onUpdate?.({ content: [{ type: 'text', text: message }], details: {} })
					});
					active.set(controller, pending);
					try {
						const report = await pending;
						if (!disposed)
							pi.appendEntry('gpui-task', {
								app: report.app,
								task: report.task,
								status: report.status,
								completed: report.completed,
								passed: report.passed,
								requests: report.model_requests,
								artifacts: report.artifacts
							});
						// Preserve measured tokens, not invented pricing or $0 nested pi usage.
						return { content: [{ type: 'text', text: summary(report) }], details: {} };
					} finally {
						active.delete(controller);
						signal?.removeEventListener('abort', abort);
					}
				}
			})
		);
	register();
	pi.on('session_start', async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		try {
			const project = await projectFor(ctx);
			register(
				'Configured apps: ' +
					Object.entries(project.apps)
						.map(
							([id, app]) => `${id}${app.description ? ': ' + app.description.slice(0, 140) : ''}`
						)
						.join('; ')
			);
		} catch {
			/* Missing configuration is shown on invocation, never launch during discovery. */
		}
	});
	pi.on('session_shutdown', async () => {
		disposed = true;
		for (const controller of active.keys()) controller.abort();
		await Promise.allSettled([...active.values()]);
	});
}
