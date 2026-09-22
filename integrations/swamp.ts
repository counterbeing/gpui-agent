/**
 * Swamp model factory for configured GPUI review tasks.
 * No registration, publishing, processes or model calls occur on import.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgs = z.object({
  runnerPath: z.string().min(1),
  taskPath: z.string().min(1),
  application: z.array(z.string()).min(1),
  envFile: z.string().optional(),
  allowCloud: z.boolean().default(false),
  maxRequests: z.number().int().min(1).max(30).default(10),
  decisionMode: z.enum(["fanout", "actions"]).optional(),
  keepalive: z.boolean().optional(),
  settleMs: z.number().min(0).max(1000).optional(),
});

/** Stable report envelope; detailed native evidence remains in the artifact directory. */
export const Report = z.object({
  protocol: z.literal(1),
  status: z.string(),
  passed: z.boolean(),
  model_requests: z.number().int().nonnegative().optional(),
  artifacts: z.string().optional(),
  steps: z.number().int().nonnegative().optional(),
  verification: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  elapsed_ms: z.number().nonnegative().optional(),
  model_ms: z.number().nonnegative().optional(),
  timings_ms: z.record(z.string(), z.number().nonnegative()).optional(),
  policy: z.object({
    decision_mode: z.enum(["fanout", "actions"]),
    keepalive: z.boolean(),
  }).optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  engine: z.enum(["jev", "script"]).optional(),
  model: z.string().nullable().optional(),
  resolved_models: z.array(z.string()).optional(),
  session: z.string().optional(),
  goal: z.string().optional(),
  limits: z.object({
    requests: z.number(),
    steps: z.number(),
    seconds: z.number(),
    settle_ms: z.number().min(0).max(1000).optional(),
  }).optional(),
  checkpoint: z.record(z.string(), z.unknown()).optional(),
}).strict();

type Args = z.infer<typeof GlobalArgs>;

/** Construct literal argv, never a shell command; application configuration is operator-owned. */
export function runnerArgs(args: Args): string[] {
  if (!args.allowCloud) {
    throw new Error("This configured model has not authorized cloud review");
  }
  if (!args.application.some((part) => part.includes("{session}"))) {
    throw new Error("The opted-in application command must contain {session}");
  }
  return [
    args.runnerPath,
    "--task",
    args.taskPath,
    "--allow-cloud",
    "--max-requests",
    String(args.maxRequests),
    ...(args.envFile ? ["--env-file", args.envFile] : []),
    ...(args.decisionMode ? ["--decision-mode", args.decisionMode] : []),
    ...(args.keepalive ? ["--keepalive"] : []),
    ...(args.settleMs !== undefined
      ? ["--settle-ms", String(args.settleMs)]
      : []),
    "--",
    ...args.application,
  ];
}

/**
 * Make a locally registered model using YOUR collective's type name.
 * A failed review is saved as passed=false; downstream workflows must assert passed.
 */
export function createGpuiModel(type: string) {
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(type)) {
    throw new Error("Use a collective-qualified model type");
  }
  return {
    type,
    version: "2026.09.17.2",
    globalArguments: GlobalArgs,
    resources: {
      result: {
        description:
          "Independent native review outcome and retained evidence paths",
        schema: Report,
        lifetime: "infinite" as const,
        garbageCollection: 10,
      },
    },
    methods: {
      run: {
        description:
          "Run the operator-configured GPUI fixture task through bounded Jev decisions",
        arguments: z.object({}),
        execute: async (_args: Record<string, never>, context: {
          globalArgs: Args;
          logger?: {
            info: (message: string, fields?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        }) => {
          const args = GlobalArgs.parse(context.globalArgs);
          context.logger?.info("Starting bounded GPUI review");
          const child = new Deno.Command("python3", {
            args: runnerArgs(args),
            stdout: "piped",
            stderr: "null",
          }).spawn();
          const timer = setTimeout(() => {
            try {
              child.kill("SIGTERM");
            } catch { /* already exited */ }
          }, 190_000);
          try {
            const chunks: Uint8Array[] = [];
            let length = 0;
            for await (const chunk of child.stdout) {
              length += chunk.length;
              if (length > 65_536) {
                try {
                  child.kill("SIGTERM");
                } catch { /* already exited */ }
                throw new Error("GPUI runner report exceeded its bound");
              }
              chunks.push(chunk);
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            const result = Report.parse(
              JSON.parse(new TextDecoder().decode(bytes)),
            );
            const status = await child.status;
            if (result.passed && status.code !== 0) {
              throw new Error("Runner exit/report mismatch");
            }
            if (result.status === "error") {
              throw new Error("GPUI runner configuration or protocol failure");
            }
            context.logger?.info("GPUI review completed", {
              passed: result.passed,
              status: result.status,
            });
            const handle = await context.writeResource(
              "result",
              "review",
              result,
            );
            return { dataHandles: [handle] };
          } finally {
            clearTimeout(timer);
            try {
              child.kill("SIGTERM");
            } catch { /* already exited; never touch another process */ }
          }
        },
      },
    },
  };
}
