import { accessSync, constants, mkdirSync } from "node:fs";
import { z } from "zod";
import { hasCommand } from "../cligentic/platform/detect.js";
import { bold, danger, dim, muted, ok } from "../cligentic/platform/style.js";
import {
  type CommandDef,
  cliPath,
  defineCommand,
  jsonSchema,
  outputFields,
} from "../lib/command.js";
import {
  BACKEND_NAMES,
  ConfigSchema,
  SETTABLE_KEYS,
  saveConfig,
  setConfigValue,
} from "../lib/config.js";
import { ERROR_CODES, EXIT, IgError, toIgError } from "../lib/errors.js";
import { printTable, renderRecord } from "../lib/table.js";
import { reportBackend } from "./auth.js";

/** Bumped on any breaking change to the envelope or to a command's data shape. */
export const SCHEMA_VERSION = "1";

export function schemaIndex(all: CommandDef[]) {
  return {
    version: SCHEMA_VERSION,
    envelope: {
      success: '{ "ok": true, "data": <command output>, "meta": { "nextSteps": [...] } }',
      failure: '{ "ok": false, "error": { "code", "message", "hint"?, "details"? } }',
    },
    globalFlags: {
      "--json": "Force the JSON envelope. Automatic when stdout is not a terminal",
      "--fields <a,b>": "Keep only these fields of data, or of each element when data is an array",
      "--params <json>": "Pass the whole input as one JSON object. Overrides individual flags",
      "--quiet": "Suppress progress messages on stderr",
    },
    exitCodes: {
      [EXIT.OK]: "success",
      [EXIT.SYSTEM]: "unexpected failure",
      [EXIT.USER]: "invalid input or unknown entity",
      [EXIT.AUTH]: "backend needs credentials: run `ig auth login`",
      [EXIT.BLOCKED]: "rate limit, checkpoint, halt or exhausted budget: do not retry",
    },
    errorCodes: Object.keys(ERROR_CODES),
    commands: all.map((def) => ({
      id: def.id,
      command: `ig ${cliPath(def.id)}`,
      summary: def.summary,
      network: def.network,
      writes: def.writes,
    })),
  };
}

export function metaCommands(getAll: () => CommandDef[]) {
  const schema = defineCommand({
    id: "schema",
    summary: "Describe commands and their JSON contracts",
    description:
      "Without an argument: every command, the envelope, exit codes.\n" +
      "With a command id (e.g. creator.search): its exact input and output JSON Schema.",
    input: z.object({ id: z.string().optional().describe("Command id, e.g. video.top") }),
    output: z.looseObject({ version: z.string() }),
    network: false,
    writes: "none",
    configure: (cmd) => cmd.argument("[id]", "command id, e.g. creator.search"),
    args: ([id]) => ({ id }),
    handler: async (input) => {
      const all = getAll();
      if (!input.id) {
        return {
          data: schemaIndex(all),
          nextSteps: [
            { command: "ig schema <id>", description: "input and output schema of one command" },
          ],
        };
      }
      const wanted = input.id.replace(/\s+/g, ".");
      const def = all.find((d) => d.id === wanted);
      if (!def) {
        throw new IgError("NOT_FOUND", `No such command: ${input.id}`, {
          hint: `Known ids: ${all.map((d) => d.id).join(", ")}`,
        });
      }
      return {
        data: {
          version: SCHEMA_VERSION,
          id: def.id,
          command: `ig ${cliPath(def.id)}`,
          summary: def.summary,
          description: def.description ?? null,
          network: def.network,
          writes: def.writes,
          fields: outputFields(def.output),
          input: jsonSchema(def.input, "input"),
          output: jsonSchema(def.output, "output"),
        },
      };
    },
    human: (data) => {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.commands)) {
        const rows = d.commands as ReturnType<typeof schemaIndex>["commands"];
        printTable(
          rows,
          [
            { header: "COMMAND", cell: (r) => bold(r.command) },
            { header: "NET", cell: (r) => (r.network ? "yes" : dim("no")) },
            {
              header: "WRITES",
              cell: (r) =>
                r.writes === "destructive"
                  ? danger(r.writes)
                  : r.writes === "none"
                    ? dim("none")
                    : r.writes,
            },
            { header: "SUMMARY", cell: (r) => r.summary },
          ],
          "No commands.",
        );
        return;
      }
      process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
    },
  });

  const CheckSchema = z.object({
    name: z.string(),
    ok: z.boolean(),
    required: z.boolean().describe("False for optional extras such as yt-dlp"),
    detail: z.string(),
    hint: z.string().nullable(),
  });
  type Check = z.infer<typeof CheckSchema>;

  const doctor = defineCommand({
    id: "doctor",
    summary: "Check the installation, storage and backends",
    input: z.object({}),
    output: z.object({
      healthy: z.boolean().describe("Every required check passed"),
      checks: z.array(CheckSchema),
    }),
    network: false,
    writes: "none",
    handler: async (_input, ctx) => {
      const checks: Check[] = [];
      const add = (
        name: string,
        passed: boolean,
        detail: string,
        hint: string | null = null,
        required = true,
      ) => checks.push({ name, ok: passed, required, detail, hint: passed ? null : hint });

      const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
      add(
        "node",
        major > 22 || (major === 22 && minor >= 13),
        `v${process.versions.node}`,
        "Install Node 22.13 or newer.",
      );

      let configOk = true;
      try {
        void ctx.config;
        add("config", true, ctx.paths.configFile);
      } catch (err) {
        configOk = false;
        add("config", false, toIgError(err).message, `Fix or delete ${ctx.paths.configFile}.`);
      }

      try {
        const niches = ctx.store.listNiches().length;
        const creators = ctx.store.listCreators().length;
        add("database", true, `${ctx.paths.db} (${niches} niches, ${creators} creators)`);
      } catch (err) {
        add(
          "database",
          false,
          toIgError(err).message,
          `Check that ${ctx.paths.state} is writable.`,
        );
      }

      if (configOk) {
        try {
          mkdirSync(ctx.mediaDir, { recursive: true });
          accessSync(ctx.mediaDir, constants.W_OK);
          add("media-dir", true, ctx.mediaDir);
        } catch {
          add(
            "media-dir",
            false,
            `${ctx.mediaDir} is not writable`,
            "ig config set mediaDir <dir>",
          );
        }

        for (const name of BACKEND_NAMES) {
          const report = await reportBackend(ctx, name);
          const detail = report.halted
            ? `halted: ${report.halted.detail}`
            : `${report.detail} (${report.budget.used}/${report.budget.limit} requests today)`;
          add(
            `backend:${name}`,
            report.ready,
            detail,
            report.halted ? `ig auth resume ${name}` : `ig auth login ${name}`,
            report.default,
          );
        }
      }

      add(
        "yt-dlp",
        hasCommand("yt-dlp"),
        hasCommand("yt-dlp") ? "found on PATH" : "not found",
        "Optional fallback downloader. Install from https://github.com/yt-dlp/yt-dlp",
        false,
      );

      const healthy = checks.every((c) => c.ok || !c.required);
      const failing = checks.filter((c) => !c.ok && c.required && c.hint?.startsWith("ig "));
      return {
        data: { healthy, checks },
        nextSteps: failing.map((c) => ({
          command: c.hint as string,
          description: `fix ${c.name}`,
        })),
      };
    },
    human: (data) => {
      printTable(
        data.checks,
        [
          {
            header: "",
            cell: (c) => (c.ok ? ok("ok") : c.required ? danger("fail") : muted("skip")),
          },
          { header: "CHECK", cell: (c) => c.name },
          {
            header: "DETAIL",
            cell: (c) => (c.ok || !c.hint ? c.detail : `${c.detail} → ${c.hint}`),
          },
        ],
        "No checks.",
      );
      const failed = data.checks.filter((c) => !c.ok && c.required).length;
      process.stdout.write(
        `\n${data.healthy ? ok("Ready.") : danger(`${failed} required check(s) failing.`)}\n`,
      );
    },
  });

  const configShow = defineCommand({
    id: "config.show",
    summary: "Show configuration and where everything is stored",
    input: z.object({}),
    output: z.object({
      config: ConfigSchema,
      paths: z.object({
        configFile: z.string(),
        database: z.string(),
        mediaDir: z.string(),
        browserProfile: z.string(),
      }),
      settableKeys: z.array(z.string()),
    }),
    network: false,
    writes: "none",
    handler: async (_input, ctx) => ({
      data: {
        config: ctx.config,
        paths: {
          configFile: ctx.paths.configFile,
          database: ctx.paths.db,
          mediaDir: ctx.mediaDir,
          browserProfile: ctx.paths.browserProfile,
        },
        settableKeys: [...SETTABLE_KEYS],
      },
    }),
    human: (data) => {
      const c = data.config;
      process.stdout.write(
        `${renderRecord([
          ["backend", c.backend],
          ["minRefreshDays", String(c.minRefreshDays)],
          ["browserWindow", c.browserWindow],
          ["autoInstallSkill", String(c.autoInstallSkill)],
          ["limits.browser.dailyBudget", String(c.limits.browser.dailyBudget)],
          ["limits.hiker.dailyBudget", String(c.limits.hiker.dailyBudget)],
          ["mediaDir", data.paths.mediaDir],
          ["database", data.paths.database],
          ["config file", data.paths.configFile],
          ["browser profile", data.paths.browserProfile],
        ])}\n`,
      );
    },
  });

  const configSet = defineCommand({
    id: "config.set",
    summary: "Change one configuration value",
    input: z.object({
      key: z.string().describe(`One of: ${SETTABLE_KEYS.join(", ")}`),
      value: z.string(),
    }),
    output: z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
    network: false,
    writes: "local",
    configure: (cmd) =>
      cmd.argument("<key>", SETTABLE_KEYS.join(" | ")).argument("<value>", "new value"),
    args: ([key, value]) => ({ key, value }),
    handler: async (input, ctx) => {
      const next = setConfigValue(ctx.config, input.key, input.value);
      saveConfig(ctx.paths, next);
      ctx.reloadConfig();
      const value = input.key
        .split(".")
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], next) as
        | string
        | number
        | boolean;
      return { data: { key: input.key, value } };
    },
    human: (data) => {
      process.stdout.write(`${renderRecord([[data.key, String(data.value)]])}\n`);
    },
  });

  return [doctor, schema, configShow, configSet];
}
