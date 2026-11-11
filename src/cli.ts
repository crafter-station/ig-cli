import "./lib/quiet.js";

import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { printBanner } from "./cligentic/foundation/banner.js";
import { commands, GROUPS } from "./commands/index.js";
import { schemaIndex } from "./commands/meta.js";
import { Context, type GlobalOptions } from "./context.js";
import { autoInstallSkill } from "./core/skill.js";
import { type CommandDef, outputFields, parseInput } from "./lib/command.js";
import { EXIT, IgError, toIgError } from "./lib/errors.js";
import {
  applyFields,
  makeLogger,
  printError,
  printNextSteps,
  resolveMode,
  writeEnvelope,
} from "./lib/output.js";

const GLOBAL_KEYS = ["json", "quiet", "fields", "params"] as const;

/**
 * Global flags are declared on every leaf command rather than on the program:
 * commander consumes program-level options before a subcommand's action sees
 * them, so `ig video top --json` would otherwise lose the flag.
 */
function addGlobalFlags(cmd: Command): Command {
  return cmd
    .option("--json", "output the JSON envelope (automatic when piped)")
    .option("--fields <list>", "comma-separated fields to keep in the output")
    .option("--params <json>", "the whole input as one JSON object; overrides flags")
    .option("--quiet", "no progress messages");
}

function parseParams(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new IgError("INVALID_INPUT", "--params is not valid JSON.", {
      hint: "Pass one JSON object, e.g. --params '{\"limit\":10}'.",
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IgError("INVALID_INPUT", "--params must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Keeps the agent skill installed and matching this version of the CLI. An
 * isolated run (IG_CLI_HOME set) leaves the real home directory alone unless
 * the agents home is redirected too.
 */
function keepSkillCurrent(def: CommandDef, ctx: Context): void {
  if (def.id.startsWith("skill.")) return;
  if (process.env.IG_CLI_HOME && !process.env.IG_CLI_AGENTS_HOME) return;
  try {
    if (!ctx.config.autoInstallSkill) return;
  } catch {
    return;
  }
  for (const done of autoInstallSkill()) {
    ctx.log(`agent skill ${done.action} for ${done.agent}: ${done.path}`);
  }
}

async function run(
  def: CommandDef,
  positional: unknown[],
  opts: Record<string, unknown>,
): Promise<void> {
  const globals = opts as GlobalOptions;
  const mode = resolveMode(globals);
  const ctx = new Context(mode, globals, makeLogger(mode, globals.quiet));
  try {
    const flagInput = Object.fromEntries(
      Object.entries(opts).filter(([key]) => !(GLOBAL_KEYS as readonly string[]).includes(key)),
    );
    const named = Object.fromEntries(
      Object.entries(def.args?.(positional) ?? {}).filter(([, v]) => v !== undefined),
    );
    const input = parseInput(def, { ...flagInput, ...named, ...parseParams(globals.params) });

    const result = await def.handler(input, ctx);
    keepSkillCurrent(def, ctx);
    const meta = { ...(result.meta ?? {}), nextSteps: result.nextSteps ?? [] };
    // Filter before branching on mode, so --fields means the same for both.
    const data = applyFields(result.data, globals.fields, outputFields(def.output));

    if (mode === "json") {
      writeEnvelope({ ok: true, data, meta });
    } else {
      if (def.human && !globals.fields) def.human(result.data, ctx, meta);
      else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      if (!globals.quiet) printNextSteps(meta.nextSteps);
    }
  } catch (err) {
    const igErr = toIgError(err);
    printError(igErr, mode);
    if (igErr.code === "INTERNAL" && process.env.IG_DEBUG && igErr.cause instanceof Error) {
      process.stderr.write(`${igErr.cause.stack}\n`);
    }
    process.exitCode = igErr.exitCode;
  } finally {
    await ctx.close();
  }
}

function build(): Command {
  const program = new Command("ig")
    .description(pkg.description)
    .version(pkg.version, "-v, --version")
    .helpCommand(false)
    .showSuggestionAfterError(true)
    .exitOverride()
    // Commander's own diagnostics must never land on stdout.
    .configureOutput({ writeErr: () => {} });

  const groups = new Map<string, Command>();
  for (const def of commands) {
    const parts = def.id.split(".");
    const leafName = parts.pop() as string;
    let parent = program;
    const groupName = parts[0];
    if (groupName) {
      let group = groups.get(groupName);
      if (!group) {
        group = program
          .command(groupName)
          .description(GROUPS[groupName] ?? "")
          .helpCommand(false)
          .exitOverride()
          .configureOutput({ writeErr: () => {} });
        groups.set(groupName, group);
      }
      parent = group;
    }
    const leaf = parent
      .command(leafName)
      .summary(def.summary)
      .description(def.description ? `${def.summary}\n\n${def.description}` : def.summary)
      .exitOverride()
      .configureOutput({ writeErr: () => {} });
    def.configure?.(leaf);
    addGlobalFlags(leaf);
    leaf.action(async (...args: unknown[]) => {
      const cmd = args[args.length - 1] as Command;
      await run(def, args.slice(0, -2), cmd.opts());
    });
  }
  return program;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const program = build();
  const wantsJson = argv.includes("--json") || !process.stdout.isTTY;

  // Bare invoke is not an error. A person gets the banner and help; an agent
  // gets the command index it would otherwise have to ask for.
  if (argv.length === 0) {
    if (wantsJson) {
      writeEnvelope({
        ok: true,
        data: schemaIndex(commands),
        meta: {
          nextSteps: [{ command: "ig schema <id>", description: "contract of one command" }],
        },
      });
    } else {
      printBanner({
        name: "ig",
        tagline: "Instagram creator research for agents and humans",
        version: pkg.version,
        gradient: ["#F9CE34", "#EE2A7B"],
      });
      process.stdout.write(`\n${program.helpInformation()}`);
    }
    return;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    // --help and --version print to stdout and exit cleanly.
    if (err.exitCode === 0) return;
    // A group invoked without a subcommand: show its help, as a usage error.
    if (err.code === "commander.help" && !wantsJson) {
      process.exitCode = EXIT.USER;
      return;
    }
    let message = err.message.replace(/^error:\s*/i, "");
    if (err.code === "commander.help") {
      // A group with no subcommand: name the choices instead of printing help.
      const group = argv.find((arg) => !arg.startsWith("-")) ?? "";
      const subs = commands
        .filter((def) => def.id.startsWith(`${group}.`))
        .map((def) => def.id.slice(group.length + 1));
      message = `\`ig ${group}\` needs a subcommand: ${subs.join(", ")}.`;
    }
    printError(
      new IgError("INVALID_INPUT", message, {
        hint: "Run `ig --help`, or `ig schema` for the machine-readable command list.",
      }),
      wantsJson ? "json" : "human",
    );
    process.exitCode = EXIT.USER;
  }
}

main().catch((err) => {
  printError(toIgError(err), process.stdout.isTTY ? "human" : "json");
  process.exitCode = EXIT.SYSTEM;
});
