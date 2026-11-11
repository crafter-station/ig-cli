// The CLI carries its own agent manual (skills/ig-cli/SKILL.md) and can place
// it where coding agents look for skills. It writes the file itself rather
// than shelling out to a package manager: no network, no prompt, and it works
// while the repository is private.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../cligentic/foundation/atomic-write.js";
import { IgError } from "../lib/errors.js";

export const SKILL_NAME = "ig-cli";

export const AGENTS = ["claude", "agents"] as const;
export type Agent = (typeof AGENTS)[number];

/** Directory, under a home or project root, that each agent family reads. */
const AGENT_DIRS: Record<Agent, string> = {
  /** Claude Code. */
  claude: ".claude",
  /** The shared location read by Codex, Cursor, Gemini CLI and others. */
  agents: ".agents",
};

export type SkillState = "current" | "outdated" | "missing";

export type SkillTarget = {
  agent: Agent;
  scope: "user" | "project";
  path: string;
  /** Whether that agent's directory exists at all in this scope. */
  agentPresent: boolean;
  state: SkillState;
};

/**
 * Where agent directories are looked up. `IG_CLI_AGENTS_HOME` overrides the
 * real home directory so tests never write into it.
 */
export function agentsHome(): string {
  return process.env.IG_CLI_AGENTS_HOME || homedir();
}

/** The manual shipped with this build. */
export function bundledSkill(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built: dist/<chunk>.js beside ../skills. From source: src/core/ under ../../skills.
  const candidates = [
    join(here, "..", "skills", SKILL_NAME, "SKILL.md"),
    join(here, "..", "..", "skills", SKILL_NAME, "SKILL.md"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  throw new IgError("INTERNAL", "The bundled SKILL.md is missing from this installation.", {
    hint: "Reinstall ig-cli.",
  });
}

function target(
  agent: Agent,
  scope: "user" | "project",
  root: string,
  bundled: string,
): SkillTarget {
  const agentDir = join(root, AGENT_DIRS[agent]);
  const path = join(agentDir, "skills", SKILL_NAME, "SKILL.md");
  let state: SkillState = "missing";
  if (existsSync(path)) {
    state = readFileSync(path, "utf8") === bundled ? "current" : "outdated";
  }
  return { agent, scope, path, agentPresent: existsSync(agentDir), state };
}

/**
 * Every place the skill can live: per agent in the user's home, or in the
 * project at `projectDir` when given.
 */
export function skillTargets(opts: { projectDir?: string } = {}): SkillTarget[] {
  const bundled = bundledSkill();
  const scope = opts.projectDir ? "project" : "user";
  const root = opts.projectDir ? resolve(opts.projectDir) : agentsHome();
  return AGENTS.map((agent) => target(agent, scope, root, bundled));
}

export function writeSkill(t: SkillTarget): void {
  atomicWrite(t.path, bundledSkill());
}

/** Removes the skill's own directory. Nothing else in the agent directory is touched. */
export function removeSkill(t: SkillTarget): void {
  rmSync(dirname(t.path), { recursive: true, force: true });
}

/**
 * Installs or updates the skill for every agent already present in the user's
 * home. Runs after ordinary commands so a fresh install of the CLI becomes
 * usable by agents without a separate step, and an upgraded CLI never leaves
 * a stale manual behind. Never throws: a failure here must not fail the
 * command the user actually ran.
 */
export function autoInstallSkill(): {
  agent: Agent;
  path: string;
  action: "installed" | "updated";
}[] {
  const done: { agent: Agent; path: string; action: "installed" | "updated" }[] = [];
  try {
    for (const t of skillTargets()) {
      if (!t.agentPresent || t.state === "current") continue;
      writeSkill(t);
      done.push({
        agent: t.agent,
        path: t.path,
        action: t.state === "missing" ? "installed" : "updated",
      });
    }
  } catch {
    // Read-only home, odd permissions: `ig skill status` will show the truth.
  }
  return done;
}
