// An in-memory backend plus a ready Context for command tests. It honours the
// real contract: one `gate.before()` per upstream request, NOT_FOUND for
// unknown accounts, so budget and halt behaviour are exercised for real.

import type { SessionBackend } from "../src/backends/index.js";
import type { BackendStatus, CreatorCandidate, ListOptions } from "../src/backends/types.js";
import { Context } from "../src/context.js";
import type { Gate } from "../src/core/gate.js";
import type { Creator, Video } from "../src/core/types.js";
import { type CommandDef, parseInput } from "../src/lib/command.js";
import type { BackendName } from "../src/lib/config.js";
import { IgError } from "../src/lib/errors.js";
import { tempHome } from "./helpers.js";

export type FakeData = {
  profiles?: Creator[];
  /** Reels by creator id, newest first. */
  reels?: Record<string, Video[]>;
  /** Keyword -> accounts. */
  creatorSearch?: Record<string, CreatorCandidate[]>;
  /** Keyword -> reels. */
  reelSearch?: Record<string, Video[]>;
  /** Hashtag -> reels. */
  hashtags?: Record<string, Video[]>;
  /** Creator id -> related accounts. */
  related?: Record<string, CreatorCandidate[]>;
};

export class FakeBackend implements SessionBackend {
  /** Every upstream call, e.g. "getProfile:ana", in order. */
  readonly calls: string[] = [];
  /** Set to make the next request hit a block signal. */
  blockNext: "RATE_LIMITED" | "CHECKPOINT" | null = null;

  constructor(
    readonly name: BackendName,
    private readonly gate: Gate,
    readonly data: FakeData = {},
  ) {}

  private async request(call: string): Promise<void> {
    await this.gate.before();
    this.calls.push(call);
    if (this.blockNext) {
      const reason = this.blockNext;
      this.blockNext = null;
      this.gate.block(reason, reason === "CHECKPOINT" ? "challenge page" : "HTTP 429");
    }
  }

  async status(): Promise<BackendStatus> {
    return { backend: this.name, ready: true, account: "fake_account", detail: "fake" };
  }

  async getProfile(username: string): Promise<Creator> {
    await this.request(`getProfile:${username}`);
    const found = this.data.profiles?.find((p) => p.username === username);
    if (!found) throw new IgError("NOT_FOUND", `No Instagram account named ${username}`);
    return found;
  }

  async listReels(creator: { id: string; username: string }, opts: ListOptions): Promise<Video[]> {
    await this.request(`listReels:${creator.username}`);
    return (this.data.reels?.[creator.id] ?? []).slice(0, opts.limit);
  }

  async getVideo(shortcode: string): Promise<Video> {
    await this.request(`getVideo:${shortcode}`);
    const all = [
      ...Object.values(this.data.reels ?? {}),
      ...Object.values(this.data.reelSearch ?? {}),
      ...Object.values(this.data.hashtags ?? {}),
    ].flat();
    const found = all.find((v) => v.shortcode === shortcode);
    if (!found) throw new IgError("NOT_FOUND", `No reel with shortcode ${shortcode}`);
    return found;
  }

  async searchCreators(query: string, opts: ListOptions): Promise<CreatorCandidate[]> {
    await this.request(`searchCreators:${query}`);
    return (this.data.creatorSearch?.[query] ?? []).slice(0, opts.limit);
  }

  async searchReels(query: string, opts: ListOptions): Promise<Video[]> {
    await this.request(`searchReels:${query}`);
    return (this.data.reelSearch?.[query] ?? []).slice(0, opts.limit);
  }

  async hashtagReels(tag: string, opts: ListOptions): Promise<Video[]> {
    await this.request(`hashtagReels:${tag}`);
    return (this.data.hashtags?.[tag] ?? []).slice(0, opts.limit);
  }

  async relatedCreators(
    creator: { id: string; username: string },
    opts: ListOptions,
  ): Promise<CreatorCandidate[]> {
    await this.request(`relatedCreators:${creator.username}`);
    return (this.data.related?.[creator.id] ?? []).slice(0, opts.limit);
  }

  async login(): Promise<BackendStatus> {
    return this.status();
  }

  async logout(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

export type TestEnv = {
  ctx: Context;
  backend: FakeBackend;
  /** Runs a command the way the CLI does: validates input, then the handler. */
  run: <D extends CommandDef>(
    def: D,
    input: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<D["handler"]>>>;
  cleanup: () => Promise<void>;
};

/**
 * A Context on a throwaway IG_CLI_HOME with a FakeBackend registered under
 * `name`. Pauses are zero so tests do not wait.
 */
export function testEnv(data: FakeData = {}, name: BackendName = "browser"): TestEnv {
  const home = tempHome();
  const previous = process.env.IG_CLI_HOME;
  process.env.IG_CLI_HOME = home.dir;

  const ctx = new Context("json", {}, () => {});
  for (const limits of Object.values(ctx.config.limits)) limits.delayMs = [0, 0];
  const backend = new FakeBackend(name, ctx.gate(name), data);
  ctx.useBackend(backend);

  return {
    ctx,
    backend,
    run: async (def, input) => (await def.handler(parseInput(def, input), ctx)) as never,
    cleanup: async () => {
      await ctx.close();
      if (previous === undefined) delete process.env.IG_CLI_HOME;
      else process.env.IG_CLI_HOME = previous;
      home.cleanup();
    },
  };
}

/** Finds a command definition by id in a group's export. */
export function byId<D extends CommandDef>(defs: readonly D[], id: string): D {
  const def = defs.find((d) => d.id === id);
  if (!def) throw new Error(`no command ${id}`);
  return def;
}
