import { z } from "zod";
import type { SessionBackend } from "../backends/index.js";
import { danger, ok, warn } from "../cligentic/platform/style.js";
import type { Context } from "../context.js";
import { clearHalt } from "../core/gate.js";
import { defineCommand } from "../lib/command.js";
import { BACKEND_NAMES, BackendName } from "../lib/config.js";
import { IgError, toIgError } from "../lib/errors.js";
import { ago } from "../lib/format.js";
import { printTable, renderRecord } from "../lib/table.js";

const backendArg = BackendName.optional().describe("browser | hiker. Defaults to config");

export const BackendReportSchema = z.object({
  backend: BackendName,
  default: z.boolean().describe("This is the backend used when --backend is omitted"),
  ready: z.boolean().describe("Can make requests right now"),
  account: z.string().nullable(),
  detail: z.string(),
  halted: z
    .object({ reason: z.string(), detail: z.string(), at: z.string() })
    .nullable()
    .describe("Set after a block signal. Cleared only by `ig auth resume`"),
  budget: z.object({
    used: z.number().int(),
    limit: z.number().int(),
    remaining: z.number().int(),
  }),
});
export type BackendReport = z.infer<typeof BackendReportSchema>;

/** Status of one backend. Never throws: a broken backend is a report, not a crash. */
export async function reportBackend(ctx: Context, name: BackendName): Promise<BackendReport> {
  const gate = ctx.gate(name);
  const halt = gate.halted();
  const base = {
    backend: name,
    default: ctx.config.backend === name,
    halted: halt ? { reason: halt.reason, detail: halt.detail, at: halt.at } : null,
    budget: gate.budget,
  };
  try {
    const status = await (await ctx.backend(name)).status();
    return {
      ...base,
      ready: status.ready && !halt && gate.budget.remaining > 0,
      account: status.account,
      detail: status.detail,
    };
  } catch (err) {
    return { ...base, ready: false, account: null, detail: toIgError(err).message };
  }
}

function printReports(reports: BackendReport[]): void {
  printTable(
    reports,
    [
      { header: "BACKEND", cell: (r) => (r.default ? `${r.backend} (default)` : r.backend) },
      {
        header: "STATE",
        cell: (r) => (r.halted ? danger("halted") : r.ready ? ok("ready") : warn("not ready")),
      },
      { header: "ACCOUNT", cell: (r) => r.account ?? "–" },
      {
        header: "REQUESTS TODAY",
        align: "right",
        cell: (r) => `${r.budget.used} / ${r.budget.limit}`,
      },
      {
        header: "DETAIL",
        cell: (r) => (r.halted ? `${r.halted.detail} (${ago(r.halted.at)})` : r.detail),
      },
    ],
    "No backends.",
  );
}

const status = defineCommand({
  id: "auth.status",
  summary: "Show whether each backend can make requests",
  input: z.object({ backend: backendArg }),
  output: z.array(BackendReportSchema),
  network: false,
  writes: "none",
  configure: (cmd) => cmd.argument("[backend]", "browser | hiker"),
  args: ([backend]) => ({ backend }),
  handler: async (input, ctx) => {
    const names = input.backend ? [input.backend] : [...BACKEND_NAMES];
    const reports: BackendReport[] = [];
    for (const name of names) reports.push(await reportBackend(ctx, name));
    const nextSteps = reports
      .filter((r) => !r.ready)
      .map((r) =>
        r.halted
          ? {
              command: `ig auth resume ${r.backend}`,
              description: "after checking the account by hand",
            }
          : { command: `ig auth login ${r.backend}`, description: "set up this backend" },
      );
    return { data: reports, nextSteps };
  },
  human: (data) => printReports(data),
});

const login = defineCommand({
  id: "auth.login",
  summary: "Set up a backend's credentials",
  description:
    "browser: opens a visible Chrome window on a dedicated profile and waits for\n" +
    "you to log in to Instagram. This needs a human at a terminal; it fails with\n" +
    "AUTH_REQUIRED instead of waiting when run non-interactively. Use a secondary\n" +
    "account, never one you cannot afford to lose.\n" +
    "hiker: checks the HIKERAPI_KEY environment variable against the API.",
  input: z.object({
    backend: backendArg,
    timeout: z.coerce
      .number()
      .int()
      .min(10)
      .max(1800)
      .default(300)
      .describe("Seconds to wait for the login to complete"),
  }),
  output: BackendReportSchema,
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("[backend]", "browser | hiker")
      .option("--timeout <seconds>", "how long to wait for the login (default 300)"),
  args: ([backend]) => ({ backend }),
  handler: async (input, ctx) => {
    const name = input.backend ?? ctx.config.backend;
    const backend = (await ctx.backend(name)) as SessionBackend;
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY) && ctx.mode !== "json";
    await backend.login({ interactive, timeoutMs: input.timeout * 1000 });
    const report = await reportBackend(ctx, name);
    return {
      data: report,
      nextSteps: report.ready
        ? [
            { command: "ig doctor", description: "confirm everything is in place" },
            { command: 'ig creator search "<topic>"', description: "discover creators" },
          ]
        : [],
    };
  },
  human: (data) => printReports([data]),
});

const logout = defineCommand({
  id: "auth.logout",
  summary: "Forget a backend's local credentials",
  description:
    "browser: deletes the dedicated Chrome profile, which holds the session.\n" +
    "Needs --yes. The Instagram account itself is not touched.",
  input: z.object({
    backend: BackendName.describe("browser | hiker"),
    dryRun: z.boolean().default(false),
    yes: z.boolean().default(false),
  }),
  output: z.object({
    backend: BackendName,
    action: z.enum(["logged-out", "nothing-to-forget", "would-log-out"]),
  }),
  network: false,
  writes: "destructive",
  configure: (cmd) =>
    cmd
      .argument("<backend>", "browser | hiker")
      .option("--dry-run", "report what would be forgotten")
      .option("--yes", "confirm"),
  args: ([backend]) => ({ backend }),
  handler: async (input, ctx) => {
    if (input.dryRun) return { data: { backend: input.backend, action: "would-log-out" as const } };
    if (!input.yes) {
      throw new IgError("INVALID_INPUT", `Logging out of "${input.backend}" needs --yes.`, {
        hint: `Run \`ig auth logout ${input.backend} --yes\`, or add --dry-run to preview.`,
      });
    }
    const backend = (await ctx.backend(input.backend)) as SessionBackend;
    const forgot = await backend.logout();
    return {
      data: {
        backend: input.backend,
        action: forgot ? ("logged-out" as const) : ("nothing-to-forget" as const),
      },
    };
  },
  human: (data) => {
    process.stdout.write(
      `${renderRecord([
        ["backend", data.backend],
        ["result", data.action],
      ])}\n`,
    );
  },
});

const resume = defineCommand({
  id: "auth.resume",
  summary: "Clear a halt after a rate limit or checkpoint",
  description:
    "A backend halts itself when Instagram or the provider pushes back, and stays\n" +
    "halted until this command runs. Check the account by hand first: resuming\n" +
    "into an unresolved checkpoint makes it worse.",
  input: z.object({ backend: BackendName.describe("browser | hiker") }),
  output: z.object({
    backend: BackendName,
    action: z.enum(["resumed", "was-not-halted"]),
  }),
  network: false,
  writes: "local",
  configure: (cmd) => cmd.argument("<backend>", "browser | hiker"),
  args: ([backend]) => ({ backend }),
  handler: async (input, ctx) => {
    const cleared = clearHalt(ctx.paths.halt, input.backend);
    return {
      data: {
        backend: input.backend,
        action: cleared ? ("resumed" as const) : ("was-not-halted" as const),
      },
      nextSteps: [{ command: "ig auth status", description: "confirm the backend is ready" }],
    };
  },
  human: (data) => {
    process.stdout.write(
      `${renderRecord([
        ["backend", data.backend],
        ["result", data.action],
      ])}\n`,
    );
  },
});

export const authCommands = [login, status, logout, resume];
