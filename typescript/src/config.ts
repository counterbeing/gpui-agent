import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export class Refusal extends Error {}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function text(value: unknown, max = 4096): value is string {
	return typeof value === 'string' && value.length <= max && !value.includes('\0');
}
export function integer(value: unknown, min: number, max: number): value is number {
	return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
export function keys(value: JsonObject, allowed: string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Refusal('Unknown configuration field');
}
export async function readBounded(path: string, limit = 65536): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		if (!(await file.stat()).isFile()) throw new Refusal('Expected a regular file');
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > limit) throw new Refusal('File exceeds size limit');
		return buffer.subarray(0, size).toString('utf8');
	} finally {
		await file.close();
	}
}

export type Task = { goal: string; check?: string; textValues: string[] };
export type AppProfile = {
	application: string[];
	maxRequests: number;
	maxSeconds: number;
	description?: string;
};
export type Profile = Task & AppProfile;
export type GoalInput = { app: string; goal: string; textValues?: string[]; check?: string };
export type Project = {
	root: string;
	envFile?: string;
	apps: Record<string, AppProfile>;
	/** Version-1 compatibility only. Version 2 has no task catalog. */
	tasks: Record<string, Profile>;
};

function inputText(value: unknown): value is string {
	return (
		text(value, 1024) &&
		value.isWellFormed() &&
		Buffer.byteLength(value) <= 1024 &&
		!/\p{Cc}/u.test(value)
	);
}
function textValues(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 32 || !value.every(inputText))
		throw new Refusal(
			'Text inputs must contain at most 32 values, each at most 1024 UTF-8 bytes without control characters'
		);
	return [...new Set(value)];
}
function task(value: JsonObject, quoted = false): Task {
	if (
		!text(value.goal) ||
		!value.goal.trim() ||
		!value.goal.isWellFormed() ||
		(value.check !== undefined &&
			(!text(value.check, 128) ||
				!value.check.trim() ||
				!value.check.isWellFormed() ||
				/\p{Cc}/u.test(value.check)))
	)
		throw new Refusal('Provide a nonempty goal and, optionally, a named independent check');
	// No text model or guessing from UI content. Explicit inputs override quoted goal literals.
	const literals =
		quoted && value.textValues === undefined
			? [...value.goal.matchAll(/"([^"\r\n]*)"|“([^”\r\n]*)”|`([^`\r\n]*)`/g)].map(
					(m) => m[1] ?? m[2] ?? m[3]
				)
			: [];
	return {
		goal: value.goal,
		check: value.check as string | undefined,
		textValues: textValues(value.textValues === undefined ? literals : value.textValues)
	};
}
function launch(profile: JsonObject): AppProfile {
	if (
		!Array.isArray(profile.application) ||
		!integer(profile.application.length, 2, 32) ||
		!profile.application.every((v) => text(v, 4096) && v.length > 0) ||
		profile.application.filter((v) => v === '{session}').length !== 1 ||
		profile.application.some((v) => v !== '{session}' && /[{}]/.test(v)) ||
		profile.application[0] === '{session}' ||
		!integer(profile.maxRequests ?? 20, 1, 120) ||
		!integer(profile.maxSeconds ?? 120, 1, 120) ||
		(profile.description !== undefined && !text(profile.description, 256))
	)
		throw new Refusal('Invalid app launch profile');
	return {
		application: [...profile.application] as string[],
		maxRequests: Number(profile.maxRequests ?? 20),
		maxSeconds: Number(profile.maxSeconds ?? 120),
		description: profile.description as string | undefined
	};
}

export function parseConfig(raw: string, root: string): Project {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Refusal('Invalid .gpui-agent.json');
	}
	if (!object(value)) throw new Refusal('Invalid project configuration');
	const legacy = value.version === 1;
	keys(value, ['version', 'fixtureOnly', 'envFile', legacy ? 'tasks' : 'apps']);
	const profiles = legacy ? value.tasks : value.apps;
	if (
		(!legacy && value.version !== 2) ||
		value.fixtureOnly !== true ||
		!object(profiles) ||
		!integer(Object.keys(profiles).length, 1, 32) ||
		(value.envFile !== undefined && (!text(value.envFile, 1024) || !value.envFile))
	)
		throw new Refusal(
			'Configuration must declare fixtureOnly and 1–32 apps (version 2) or legacy tasks (version 1)'
		);
	const apps: Record<string, AppProfile> = Object.create(null);
	const tasks: Record<string, Profile> = Object.create(null);
	for (const [id, profile] of Object.entries(profiles)) {
		if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !object(profile))
			throw new Refusal('Invalid app ID or profile');
		keys(profile, [
			'application',
			'maxRequests',
			'maxSeconds',
			...(legacy ? ['goal', 'check', 'textValues'] : ['description'])
		]);
		apps[id] = launch(profile);
		if (legacy) {
			if (profile.check === undefined || profile.textValues === undefined)
				throw new Refusal('Legacy task requires check and textValues');
			tasks[id] = { ...apps[id], ...task(profile) };
		}
	}
	return {
		root,
		apps,
		tasks,
		envFile: value.envFile ? resolve(root, value.envFile as string) : undefined
	};
}

/** Revalidate library/tool input before credential reads, launch or billing; never merge caller launch settings. */
export function resolveGoal(
	project: Project,
	input: string | GoalInput
): { app: string; taskId: string | null; profile: Profile } {
	if (typeof input === 'string') {
		if (!Object.hasOwn(project.tasks, input))
			throw new Refusal('Unknown legacy task; use an app and free-form goal');
		const profile = project.tasks[input];
		return { app: input, taskId: input, profile: { ...launch(profile), ...task(profile) } };
	}
	if (!object(input)) throw new Refusal('Provide an app and goal');
	keys(input, ['app', 'goal', 'textValues', 'check']);
	if (!text(input.app, 64) || !Object.hasOwn(project.apps, input.app))
		throw new Refusal('Unknown app; call gpui_task with no arguments to list apps');
	return {
		app: input.app,
		taskId: null,
		profile: { ...launch(project.apps[input.app]), ...task(input, true) }
	};
}

/** Caller must establish project trust before loading executable configuration. */
export async function loadProject(cwd: string): Promise<Project> {
	const root = await realpath(cwd);
	try {
		return parseConfig(await readBounded(resolve(root, '.gpui-agent.json')), root);
	} catch (error) {
		if (error instanceof Refusal) throw error;
		throw new Refusal('Cannot read .gpui-agent.json in the current project');
	}
}

export async function readKey(project: Project): Promise<string> {
	const exported = process.env.TYPESAFE_API_KEY?.trim();
	if (exported) return exported;
	if (project.envFile) {
		try {
			// Only this exact key; never evaluate shell or load other environment variables.
			for (const line of (await readBounded(project.envFile)).split(/\r?\n/)) {
				const match = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
				if (match) {
					const key = match[1].replace(/^(['"])(.*)\1$/, '$2');
					if (key) return key;
				}
			}
		} catch {
			throw new Refusal('Cannot read configured credential file');
		}
	}
	throw new Refusal(
		'Set TYPESAFE_API_KEY in the environment launching pi, or in the project envFile'
	);
}
