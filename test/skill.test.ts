import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillCommands } from "../src/commands/skill.js";
import { autoInstallSkill, bundledSkill, skillTargets } from "../src/core/skill.js";
import { byId, type TestEnv, testEnv } from "./fake-backend.js";
import { tempHome } from "./helpers.js";

const install = byId(skillCommands, "skill.install");
const status = byId(skillCommands, "skill.status");
const uninstall = byId(skillCommands, "skill.uninstall");

let env: TestEnv;
let agents: ReturnType<typeof tempHome>;
let cwd: string;

const skillFile = (root: string, dir: string) => join(root, dir, "skills", "ig-cli", "SKILL.md");

beforeEach(() => {
  agents = tempHome();
  process.env.IG_CLI_AGENTS_HOME = agents.dir;
  cwd = process.cwd();
  env = testEnv();
});
afterEach(async () => {
  process.chdir(cwd);
  await env.cleanup();
  delete process.env.IG_CLI_AGENTS_HOME;
  agents.cleanup();
});

describe("bundled skill", () => {
  it("ships a manual with valid frontmatter", () => {
    const text = bundledSkill();
    expect(text.startsWith("---\nname: ig-cli\n")).toBe(true);
    expect(text).toMatch(/\ndescription: ".{40,}"\n---\n/);
  });
});

describe("skill install", () => {
  it("fails with a hint when no agent directory exists, and writes nothing", async () => {
    await expect(env.run(install, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(existsSync(join(agents.dir, ".claude"))).toBe(false);
  });

  it("installs only for agents that are present when none is named", async () => {
    mkdirSync(join(agents.dir, ".claude"));
    const { data } = await env.run(install, {});
    expect(data.map((r) => [r.agent, r.state])).toEqual([["claude", "installed"]]);
    expect(readFileSync(skillFile(agents.dir, ".claude"), "utf8")).toBe(bundledSkill());
    expect(existsSync(join(agents.dir, ".agents"))).toBe(false);
  });

  it("creates the directory for an agent named explicitly", async () => {
    const { data } = await env.run(install, { agent: "agents" });
    expect(data).toMatchObject([{ agent: "agents", state: "installed", agentPresent: true }]);
    expect(existsSync(skillFile(agents.dir, ".agents"))).toBe(true);
  });

  it("is idempotent, and replaces an older copy", async () => {
    await env.run(install, { agent: "all" });
    const again = await env.run(install, { agent: "all" });
    expect(again.data.map((r) => r.state)).toEqual(["current", "current"]);

    writeFileSync(skillFile(agents.dir, ".claude"), "old manual");
    expect((await env.run(status, {})).data.map((r) => r.state)).toEqual(["outdated", "current"]);
    const fixed = await env.run(install, {});
    expect(fixed.data.map((r) => r.state)).toEqual(["updated", "current"]);
    expect(readFileSync(skillFile(agents.dir, ".claude"), "utf8")).toBe(bundledSkill());
  });

  it("a dry run writes nothing", async () => {
    const { data } = await env.run(install, { agent: "all", dryRun: true });
    expect(data.map((r) => r.state)).toEqual(["would-install", "would-install"]);
    expect(existsSync(join(agents.dir, ".claude"))).toBe(false);
  });

  it("--project targets the current directory, not the home", async () => {
    const project = tempHome();
    try {
      mkdirSync(join(project.dir, ".claude"));
      process.chdir(project.dir);
      const { data } = await env.run(install, { project: true });
      expect(data).toMatchObject([{ agent: "claude", scope: "project", state: "installed" }]);
      expect(existsSync(skillFile(process.cwd(), ".claude"))).toBe(true);
      expect(existsSync(join(agents.dir, ".claude"))).toBe(false);
    } finally {
      process.chdir(cwd);
      project.cleanup();
    }
  });
});

describe("skill uninstall", () => {
  it("removes only its own directory and turns automatic install off", async () => {
    mkdirSync(join(agents.dir, ".claude", "skills", "someone-else"), { recursive: true });
    await env.run(install, { agent: "claude" });
    const { data, meta } = await env.run(uninstall, {});
    expect(data.map((r) => [r.agent, r.state])).toEqual([
      ["claude", "removed"],
      ["agents", "missing"],
    ]);
    expect(existsSync(join(agents.dir, ".claude", "skills", "ig-cli"))).toBe(false);
    expect(existsSync(join(agents.dir, ".claude", "skills", "someone-else"))).toBe(true);
    expect(meta?.autoInstall).toBe(false);
    expect(env.ctx.config.autoInstallSkill).toBe(false);
  });

  it("a dry run removes nothing and leaves automatic install on", async () => {
    await env.run(install, { agent: "claude" });
    const { data } = await env.run(uninstall, { dryRun: true });
    expect(data[0]?.state).toBe("would-remove");
    expect(existsSync(skillFile(agents.dir, ".claude"))).toBe(true);
    expect(env.ctx.config.autoInstallSkill).toBe(true);
  });

  it("an explicit install turns automatic install back on", async () => {
    await env.run(install, { agent: "claude" });
    await env.run(uninstall, {});
    await env.run(install, { agent: "claude" });
    expect(env.ctx.config.autoInstallSkill).toBe(true);
  });
});

describe("automatic install", () => {
  it("installs for present agents, never creates an agent directory, and then stays quiet", () => {
    expect(autoInstallSkill()).toEqual([]);
    mkdirSync(join(agents.dir, ".agents"));
    expect(autoInstallSkill()).toMatchObject([{ agent: "agents", action: "installed" }]);
    expect(existsSync(join(agents.dir, ".claude"))).toBe(false);
    expect(autoInstallSkill()).toEqual([]);
  });

  it("updates a stale copy left by an older version", () => {
    mkdirSync(join(agents.dir, ".claude", "skills", "ig-cli"), { recursive: true });
    writeFileSync(skillFile(agents.dir, ".claude"), "old manual");
    expect(autoInstallSkill()).toMatchObject([{ agent: "claude", action: "updated" }]);
    expect(skillTargets().find((t) => t.agent === "claude")?.state).toBe("current");
  });
});
