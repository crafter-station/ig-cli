import { z } from "zod";
import { danger, dim, muted, ok, warn } from "../cligentic/platform/style.js";
import { AGENTS, removeSkill, type SkillTarget, skillTargets, writeSkill } from "../core/skill.js";
import { defineCommand, flags } from "../lib/command.js";
import { saveConfig } from "../lib/config.js";
import { IgError } from "../lib/errors.js";
import { printTable } from "../lib/table.js";

const AgentChoice = z
  .enum([...AGENTS, "all"])
  .optional()
  .describe(
    "claude (Claude Code) | agents (the shared ~/.agents directory read by Codex, Cursor, Gemini CLI and others) | all. Default: every agent whose directory exists",
  );

const projectFlag = z
  .boolean()
  .default(false)
  .describe("Use the current directory's .claude/ and .agents/ instead of the home directory");

const TargetSchema = z.object({
  agent: z.enum(AGENTS),
  scope: z.enum(["user", "project"]),
  path: z.string().describe("Where the SKILL.md is or would be"),
  state: z.enum([
    "current",
    "outdated",
    "missing",
    "installed",
    "updated",
    "removed",
    "would-install",
    "would-update",
    "would-remove",
  ]),
  agentPresent: z.boolean().describe("That agent's directory exists in this scope"),
});
type TargetReport = z.infer<typeof TargetSchema>;

const report = (t: SkillTarget, state: TargetReport["state"] = t.state): TargetReport => ({
  agent: t.agent,
  scope: t.scope,
  path: t.path,
  state,
  agentPresent: t.agentPresent,
});

/** Targets selected by `[agent]`; with none given, the agents that exist. */
function select(agent: z.infer<typeof AgentChoice>, project: boolean): SkillTarget[] {
  const all = skillTargets(project ? { projectDir: process.cwd() } : {});
  if (agent === "all") return all;
  if (agent) return all.filter((t) => t.agent === agent);
  const present = all.filter((t) => t.agentPresent);
  if (present.length > 0) return present;
  throw new IgError(
    "NOT_FOUND",
    project
      ? "No .claude or .agents directory in the current directory."
      : "No agent directory (~/.claude or ~/.agents) was found.",
    { hint: "Name one to create it: `ig skill install claude` or `ig skill install agents`." },
  );
}

function printTargets(rows: TargetReport[]): void {
  const good = new Set(["current", "installed", "updated"]);
  printTable(
    rows,
    [
      { header: "AGENT", cell: (r) => r.agent },
      { header: "SCOPE", cell: (r) => r.scope },
      {
        header: "STATE",
        cell: (r) =>
          good.has(r.state)
            ? ok(r.state)
            : r.state === "outdated"
              ? warn(r.state)
              : r.state === "removed"
                ? danger(r.state)
                : r.state === "missing" && !r.agentPresent
                  ? dim("agent not found")
                  : muted(r.state),
      },
      { header: "PATH", cell: (r) => r.path },
    ],
    "No agents selected.",
  );
}

const configure =
  (extra: (cmd: import("commander").Command) => void = () => {}) =>
  (cmd: import("commander").Command) => {
    cmd
      .argument("[agent]", "claude | agents | all")
      .option("--project", "use ./.claude and ./.agents instead of the home directory");
    extra(cmd);
  };

const status = defineCommand({
  id: "skill.status",
  summary: "Show where the agent skill is installed and whether it is up to date",
  input: z.object({ project: projectFlag }),
  output: z.array(TargetSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd.option("--project", "look in ./.claude and ./.agents instead of the home directory"),
  handler: async (input, ctx) => {
    const targets = skillTargets(input.project ? { projectDir: process.cwd() } : {});
    const stale = targets.some((t) => t.agentPresent && t.state !== "current");
    return {
      data: targets.map((t) => report(t)),
      meta: { autoInstall: ctx.config.autoInstallSkill },
      nextSteps: stale
        ? [
            {
              command: `ig skill install${input.project ? " --project" : ""}`,
              description: "install or update the skill",
            },
          ]
        : [],
    };
  },
  human: (data) => printTargets(data),
});

const install = defineCommand({
  id: "skill.install",
  summary: "Install this CLI's agent skill so coding agents know how to use it",
  description:
    "Writes the SKILL.md shipped with this version into each agent's skills\n" +
    "directory. No network. Safe to repeat: an up-to-date copy is left alone and\n" +
    "an old one is replaced. The CLI also does this by itself after ordinary\n" +
    "commands for agents found in the home directory; turn that off with\n" +
    "`ig config set autoInstallSkill false`.",
  input: z.object({ agent: AgentChoice, project: projectFlag, dryRun: flags.dryRun }),
  output: z.array(TargetSchema),
  network: false,
  writes: "local",
  configure: configure((cmd) => cmd.option("--dry-run", "report what would be written")),
  args: ([agent]) => ({ agent }),
  handler: async (input, ctx) => {
    const rows = select(input.agent, input.project).map((t) => {
      if (t.state === "current") return report(t);
      const fresh = t.state === "missing";
      if (input.dryRun) return report(t, fresh ? "would-install" : "would-update");
      writeSkill(t);
      return report({ ...t, agentPresent: true }, fresh ? "installed" : "updated");
    });
    // An explicit install is also consent to keep the copy up to date.
    if (!input.dryRun && !input.project && !ctx.config.autoInstallSkill) {
      saveConfig(ctx.paths, { ...ctx.config, autoInstallSkill: true });
      ctx.reloadConfig();
    }
    return {
      data: rows,
      nextSteps: input.dryRun
        ? []
        : [
            {
              command: "ig schema",
              description: "what an agent reads next: commands and contracts",
            },
          ],
    };
  },
  human: (data) => printTargets(data),
});

const uninstall = defineCommand({
  id: "skill.uninstall",
  summary: "Remove the agent skill and stop installing it automatically",
  description:
    "Deletes only the ig-cli skill directory this CLI created. Without --project\n" +
    "it also sets autoInstallSkill to false, so the skill does not come back on\n" +
    "the next command. `ig skill install` puts it back at any time.",
  input: z.object({ agent: AgentChoice, project: projectFlag, dryRun: flags.dryRun }),
  output: z.array(TargetSchema),
  network: false,
  writes: "local",
  configure: configure((cmd) => cmd.option("--dry-run", "report what would be removed")),
  args: ([agent]) => ({ agent }),
  handler: async (input, ctx) => {
    const all = skillTargets(input.project ? { projectDir: process.cwd() } : {});
    const chosen =
      !input.agent || input.agent === "all" ? all : all.filter((t) => t.agent === input.agent);
    const rows = chosen.map((t) => {
      if (t.state === "missing") return report(t);
      if (input.dryRun) return report(t, "would-remove");
      removeSkill(t);
      return report(t, "removed");
    });
    let autoInstall = ctx.config.autoInstallSkill;
    if (!input.dryRun && !input.project && autoInstall) {
      saveConfig(ctx.paths, { ...ctx.config, autoInstallSkill: false });
      autoInstall = ctx.reloadConfig().autoInstallSkill;
    }
    return {
      data: rows,
      meta: { autoInstall },
      nextSteps: [{ command: "ig skill install", description: "put the skill back" }],
    };
  },
  human: (data) => printTargets(data),
});

export const skillCommands = [install, status, uninstall];
