import { z } from "zod";
import type { Backend } from "../backends/types.js";
import { bold, danger, info, muted, ok, warn } from "../cligentic/platform/style.js";
import { CAPTIONS_FLAG_HELP, type CaptionOutcome } from "../core/captions.js";
import { byFollowersDesc, discoverCreators, type SourceReport } from "../core/discovery.js";
import { refreshCreator } from "../core/refresh.js";
import {
  type CreatorHit,
  CreatorHitSchema,
  isSlug,
  normalizeUsername,
  profileUrl,
  type StoredCreator,
  StoredCreatorSchema,
  slugify,
} from "../core/types.js";
import { defineCommand, flags } from "../lib/command.js";
import { EXIT, IgError, toIgError } from "../lib/errors.js";
import { ago, compact } from "../lib/format.js";
import { type NextStep, oneLine } from "../lib/output.js";
import { type Column, printTable, renderRecord } from "../lib/table.js";

const list = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) =>
    (Array.isArray(v) ? v : v ? v.split(",") : []).map((s) => s.trim()).filter(Boolean),
  );

/** Block and auth errors end a batch: nothing may be retried or attempted after one. */
export function isStopError(err: IgError): boolean {
  return err.exitCode === EXIT.BLOCKED || err.exitCode === EXIT.AUTH;
}

/**
 * The same error, carrying what the batch had already done under
 * `details.progress`, so an agent knows nothing was lost and what remains.
 */
export function stopWithProgress(err: IgError, progress: Record<string, unknown>): IgError {
  return new IgError(err.code, err.message, {
    hint: err.hint,
    details: { ...(err.details ?? {}), progress },
    cause: err,
  });
}

// --- human views --------------------------------------------------------------

const note = (text: string): void => {
  process.stderr.write(`${muted(text)}\n`);
};

/** "@ana ✓", with a marker for private accounts. Usernames are third-party text. */
function handle(c: { username: string; isVerified: boolean; isPrivate: boolean }): string {
  return (
    bold(`@${oneLine(c.username)}`) +
    (c.isVerified ? ` ${info("✓")}` : "") +
    (c.isPrivate ? ` ${muted("private")}` : "")
  );
}

/**
 * Columns for a list of tracked creators. `niches` is off when every row would
 * repeat the one niche the reader asked about.
 */
export function creatorColumns(opts: { niches: boolean }): Column<StoredCreator>[] {
  const columns: Column<StoredCreator>[] = [
    { header: "CREATOR", cell: handle },
    { header: "NAME", cell: (c) => oneLine(c.fullName) || muted("–"), maxWidth: 28 },
    { header: "FOLLOWERS", align: "right", cell: (c) => compact(c.followers) },
    { header: "VIDEOS", align: "right", cell: (c) => String(c.videoCount) },
  ];
  if (opts.niches) {
    columns.push({ header: "NICHES", cell: (c) => c.niches.join(", ") || muted("–") });
  }
  columns.push({
    header: "REFRESHED",
    cell: (c) => (c.refreshedAt ? ago(c.refreshedAt) : warn("never")),
  });
  return columns;
}

// --- creator search -----------------------------------------------------------

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
const quote = (text: string): string => JSON.stringify(text);

type SearchMeta = {
  backend: string;
  sources: SourceReport[];
  skippedSources: { source: string; reason: string }[];
  /** Unique accounts found before filters. */
  candidates: number;
  /** Of those, how many passed the follower filters. */
  matched: number;
  returned: number;
  requestsUsed: number;
  resolve?: {
    attempted: number;
    resolved: number;
    failed: number;
    /** Hits whose followers were still unknown when filters were applied. */
    unresolved: number;
    stoppedBy: string | null;
    note: string | null;
  };
};

const search = defineCommand({
  id: "creator.search",
  summary: "Discover creators on Instagram by keyword",
  description:
    "Lists candidates only; nothing is stored until `ig creator add`.\n" +
    "Instagram search is personalised and incomplete. For breadth, pass --expand\n" +
    "with extra keyword variants (--also) and hashtags (--hashtags).",
  input: z.object({
    query: z.string().min(1),
    limit: flags.limit(30, 200),
    backend: flags.backend,
    expand: z
      .boolean()
      .default(false)
      .describe(
        "Also collect authors of matching reels, authors of hashtag reels, and accounts related to the top hits. Costs more requests",
      ),
    also: list.describe("Extra keyword variants, comma-separated. Used with --expand"),
    hashtags: list.describe(
      "Hashtags without #, comma-separated. Used with --expand. Defaults to the query without spaces",
    ),
    minFollowers: z.coerce.number().int().min(0).optional(),
    maxFollowers: z.coerce.number().int().min(0).optional(),
    resolve: z
      .boolean()
      .default(false)
      .describe(
        "Fetch each hit's profile to fill in a missing follower count. One request per hit. Without it, hits with unknown followers pass the follower filters",
      ),
  }),
  output: z.array(CreatorHitSchema),
  network: true,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<query>", 'keyword, e.g. "cocina" or "gta 6"')
      .option("--limit <n>", "maximum results (default 30)")
      .option("--backend <name>", "browser | hiker")
      .option("--expand", "combine keyword, reels, hashtag and related-account sources")
      .option("--also <keywords>", "extra keyword variants, comma-separated")
      .option("--hashtags <tags>", "hashtags to mine, comma-separated, without #")
      .option("--min-followers <n>", "drop accounts below this")
      .option("--max-followers <n>", "drop accounts above this")
      .option("--resolve", "fetch profiles to fill unknown follower counts"),
  args: ([query]) => ({ query }),
  handler: async (input, ctx) => {
    const { minFollowers: min, maxFollowers: max } = input;
    if (min !== undefined && max !== undefined && min > max) {
      throw new IgError(
        "INVALID_INPUT",
        `--min-followers (${min}) is greater than --max-followers (${max}).`,
        { hint: "Swap them, or drop one." },
      );
    }
    const filtering = min !== undefined || max !== undefined;

    const name = input.backend ?? ctx.config.backend;
    const gate = ctx.gate(name);
    gate.check();
    const usedBefore = gate.budget.used;
    const backend = await ctx.backend(name);

    const found = await discoverCreators(
      backend,
      {
        query: input.query,
        expand: input.expand,
        also: input.also,
        hashtags: input.hashtags,
        limit: input.limit,
      },
      ctx.log,
    );
    const candidates = found.candidates;

    let resolveMeta: SearchMeta["resolve"];
    if (input.resolve) {
      const unknown = candidates.filter((c) => c.followers === null);
      let attempted = 0;
      let resolved = 0;
      let failed = 0;
      let stoppedBy: string | null = null;
      for (const [i, candidate] of unknown.entries()) {
        // Running out of budget here is not a failure of the search: the hits
        // are already in hand. Stop spending and report it.
        if (gate.budget.remaining === 0) {
          stoppedBy = "BUDGET_EXHAUSTED";
          break;
        }
        try {
          attempted++;
          const profile = await backend.getProfile(candidate.username);
          candidate.followers = profile.followers;
          candidate.fullName = profile.fullName ?? candidate.fullName;
          candidate.isVerified = profile.isVerified;
          candidate.isPrivate = profile.isPrivate;
          if (profile.followers !== null) resolved++;
          ctx.log(
            `${i + 1}/${unknown.length} @${candidate.username}: ${compact(profile.followers)} followers`,
          );
        } catch (err) {
          const igErr = toIgError(err);
          if (igErr.code === "BUDGET_EXHAUSTED") {
            attempted--;
            stoppedBy = igErr.code;
            break;
          }
          if (isStopError(igErr)) throw igErr;
          failed++;
          ctx.log(`${i + 1}/${unknown.length} @${candidate.username}: ${igErr.message}`);
        }
      }
      const unresolved = candidates.filter((c) => c.followers === null).length;
      resolveMeta = {
        attempted,
        resolved,
        failed,
        unresolved,
        stoppedBy,
        note: stoppedBy
          ? `The daily budget ran out after resolving ${attempted} of ${unknown.length} profiles.${
              filtering && unresolved > 0
                ? ` ${unresolved} hits with unknown followers were dropped by the follower filters.`
                : ""
            }`
          : null,
      };
    }

    const matched = candidates.filter((c) => {
      // Unknown passes the filters, unless the caller paid to find out and it
      // is still unknown: then it cannot be shown to satisfy them.
      if (c.followers === null) return !(filtering && input.resolve);
      return (min === undefined || c.followers >= min) && (max === undefined || c.followers <= max);
    });

    const hits: CreatorHit[] = matched
      .sort(byFollowersDesc)
      .slice(0, input.limit)
      .map((c) => ({
        id: c.id,
        username: c.username,
        fullName: c.fullName,
        followers: c.followers,
        isVerified: c.isVerified,
        isPrivate: c.isPrivate,
        url: profileUrl(c.username),
        source: c.source,
        tracked: ctx.store.findCreator(c.id) !== null,
      }));

    const meta: SearchMeta = {
      backend: name,
      sources: found.sources,
      skippedSources: found.skipped,
      candidates: candidates.length,
      matched: matched.length,
      returned: hits.length,
      requestsUsed: gate.budget.used - usedBefore,
      ...(resolveMeta ? { resolve: resolveMeta } : {}),
    };

    /** This same search with flags changed, as a runnable command. */
    const again = (over: Partial<typeof input>): string => {
      const i = { ...input, ...over };
      return [
        `ig creator search ${quote(i.query)}`,
        i.expand ? "--expand" : "",
        i.also.length ? `--also ${quote(i.also.join(","))}` : "",
        i.hashtags.length ? `--hashtags ${quote(i.hashtags.join(","))}` : "",
        i.minFollowers !== undefined ? `--min-followers ${i.minFollowers}` : "",
        i.maxFollowers !== undefined ? `--max-followers ${i.maxFollowers}` : "",
        i.resolve ? "--resolve" : "",
        input.backend ? `--backend ${input.backend}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    };

    const nextSteps: NextStep[] = [];
    const fresh = hits.filter((h) => !h.tracked && USERNAME_RE.test(h.username)).slice(0, 5);
    if (fresh.length > 0) {
      const names = fresh.map((h) => h.username).join(" ");
      const slug = slugify(input.query);
      if (isSlug(slug)) {
        if (!ctx.store.findNiche(slug)) {
          nextSteps.push({
            command: `ig niche create ${slug}`,
            description: "a niche to hold them",
          });
        }
        nextSteps.push({
          command: `ig creator add ${names} --niche ${slug}`,
          description: "track the largest untracked hits",
        });
      } else {
        nextSteps.push({
          command: `ig creator add ${names}`,
          description: "track the largest untracked hits",
        });
      }
    }
    if (!input.resolve && hits.some((h) => h.followers === null)) {
      nextSteps.push({
        command: again({ resolve: true }),
        description: "fill in unknown follower counts (one request per unknown hit)",
      });
    }
    if (hits.length === 0 && filtering && candidates.length > 0) {
      nextSteps.push({
        command: again({ minFollowers: undefined, maxFollowers: undefined }),
        description: `${candidates.length} candidates were found; none passed the follower filters`,
      });
    }
    if (!input.expand) {
      nextSteps.push({
        command: again({ expand: true }),
        description: "widen with reel authors, hashtags and related accounts (more requests)",
      });
    }

    return { data: hits, meta, nextSteps };
  },
  human: (data, _ctx, rawMeta) => {
    const meta = rawMeta as unknown as SearchMeta;
    const columns: Column<CreatorHit>[] = [
      { header: "CREATOR", cell: handle },
      { header: "NAME", cell: (h) => oneLine(h.fullName) || muted("–"), maxWidth: 28 },
      { header: "FOLLOWERS", align: "right", cell: (h) => compact(h.followers) },
    ];
    // One source for every row is a heading, not a column.
    if (new Set(data.map((h) => h.source)).size > 1) {
      columns.push({ header: "FOUND VIA", cell: (h) => oneLine(h.source), maxWidth: 28 });
    }
    columns.push({ header: "", cell: (h) => (h.tracked ? ok("tracked") : "") });
    printTable(
      data,
      columns,
      meta.candidates > 0
        ? `${meta.candidates} candidates found, none passed the filters.`
        : "No creators found.",
    );
    if (data.length > 0) {
      note(
        `\n${data.length} shown of ${meta.candidates} found · ${meta.requestsUsed} request(s) on ${meta.backend}`,
      );
    }
    for (const s of meta.skippedSources) note(`skipped ${s.source}: ${oneLine(s.reason)}`);
    if (meta.resolve?.note) process.stderr.write(`${warn(meta.resolve.note)}\n`);
  },
});

// --- creator add ----------------------------------------------------------------

type AddMeta = {
  niche: string | null;
  fetched: number;
  alreadyTracked: number;
  requestsUsed: number;
};

const add = defineCommand({
  id: "creator.add",
  summary: "Track creators, optionally inside a niche",
  description:
    "Fetches each profile (one request per new creator) and stores it. A creator\n" +
    "already tracked is not fetched again; it is only added to the niche.",
  input: z.object({
    usernames: z.array(z.string()).min(1).describe("Usernames, @handles or profile URLs"),
    niche: flags.niche.describe("Niche to add them to. Must exist"),
    backend: flags.backend,
  }),
  output: z.object({
    added: z.array(StoredCreatorSchema).describe("Creators tracked after this call"),
    failed: z.array(z.object({ username: z.string(), code: z.string(), message: z.string() })),
  }),
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<usernames...>", "usernames, @handles or profile URLs")
      .option("--niche <slug>", "niche to add them to")
      .option("--backend <name>", "browser | hiker"),
  args: ([usernames]) => ({ usernames }),
  handler: async (input, ctx) => {
    const usernames = [...new Set(input.usernames.map(normalizeUsername).filter(Boolean))];
    if (usernames.length === 0) {
      throw new IgError("INVALID_INPUT", "No usernames were given.", {
        hint: "Pass usernames, @handles or profile URLs: `ig creator add ana beto`.",
      });
    }
    // Before any request: a typo in the niche must not cost budget.
    if (input.niche) ctx.store.getNiche(input.niche);

    const name = input.backend ?? ctx.config.backend;
    const gate = ctx.gate(name);
    const usedBefore = gate.budget.used;
    let backend: Backend | undefined;

    const ids: string[] = [];
    const failed: { username: string; code: string; message: string }[] = [];
    let fetched = 0;
    let alreadyTracked = 0;

    for (const [i, username] of usernames.entries()) {
      const position = `${i + 1}/${usernames.length}`;
      let id: string;
      const existing = ctx.store.findCreator(username);
      if (existing) {
        id = existing.id;
        alreadyTracked++;
        ctx.log(`${position} @${username}: already tracked`);
      } else if (!USERNAME_RE.test(username)) {
        failed.push({
          username,
          code: "INVALID_INPUT",
          message: "Not a valid Instagram username (letters, digits, dots, underscores).",
        });
        ctx.log(`${position} ${username}: not a valid username`);
        continue;
      } else {
        backend ??= await ctx.backend(name);
        try {
          const profile = await backend.getProfile(username);
          // Not a full refresh: reels have not been fetched, so the creator
          // must stay first in line for `niche refresh`.
          ctx.store.upsertCreator(profile, { refreshed: false });
          id = profile.id;
          fetched++;
          ctx.log(`${position} @${profile.username}: ${compact(profile.followers)} followers`);
        } catch (err) {
          const igErr = toIgError(err);
          if (isStopError(igErr)) {
            throw stopWithProgress(igErr, {
              added: ids.map((done) => ctx.store.getCreator(done).username),
              failed,
              remaining: usernames.slice(i),
              requestsUsed: gate.budget.used - usedBefore,
            });
          }
          failed.push({ username, code: igErr.code, message: igErr.message });
          ctx.log(`${position} @${username}: ${igErr.message}`);
          continue;
        }
      }
      if (input.niche) ctx.store.addCreatorToNiche(id, input.niche);
      if (!ids.includes(id)) ids.push(id);
    }

    const added = ids.map((id) => ctx.store.getCreator(id));
    const meta: AddMeta = {
      niche: input.niche ?? null,
      fetched,
      alreadyTracked,
      requestsUsed: gate.budget.used - usedBefore,
    };

    const nextSteps: NextStep[] = [];
    if (added.length === 0) {
      nextSteps.push({
        command: `ig creator search ${quote(failed[0]?.username ?? usernames[0] ?? "")}`,
        description: "nothing was added; look up the exact username",
      });
    } else if (input.niche) {
      nextSteps.push({
        command: `ig niche refresh ${input.niche}`,
        description: "fetch reels and metrics for the niche",
      });
    } else {
      const first = added[0] as StoredCreator;
      nextSteps.push({
        command: `ig creator get ${first.username} --refresh`,
        description: "fetch this creator's reels and metrics",
      });
    }
    return { data: { added, failed }, meta, nextSteps };
  },
  human: (data, _ctx, rawMeta) => {
    const meta = rawMeta as unknown as AddMeta;
    printTable(data.added, creatorColumns({ niches: !meta.niche }), "No creators were added.");
    if (data.added.length > 0) {
      const where = meta.niche ? ` in niche ${meta.niche}` : "";
      note(
        `\n${data.added.length} tracked${where}: ${meta.fetched} fetched, ${meta.alreadyTracked} already tracked`,
      );
    }
    for (const f of data.failed) {
      process.stderr.write(
        `${danger("failed")} ${oneLine(f.username)}: ${oneLine(f.message)} ${muted(`[${f.code}]`)}\n`,
      );
    }
  },
});

// --- creator get ----------------------------------------------------------------

type GetMeta = {
  refresh?: {
    status: "refreshed" | "skipped";
    reason: string | null;
    newVideos: number;
    requestsUsed: number;
    /** Only with --captions, when the creator was refreshed. */
    captions?: CaptionOutcome;
  };
};

const get = defineCommand({
  id: "creator.get",
  summary: "Show a tracked creator",
  input: z.object({
    username: z.string(),
    refresh: z.boolean().default(false).describe("Fetch profile and reels first"),
    reels: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(15)
      .describe("Reels to fetch on refresh"),
    backend: flags.backend,
    force: flags.force.describe("Refresh even if refreshed recently"),
    captions: z.boolean().default(false).describe(`With --refresh: ${CAPTIONS_FLAG_HELP}`),
  }),
  output: StoredCreatorSchema,
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<username>")
      .option("--refresh", "fetch profile and reels first")
      .option("--reels <n>", "reels to fetch on refresh (default 15)")
      .option("--backend <name>", "browser | hiker")
      .option("--force", "refresh even if refreshed recently")
      .option("--captions", `with --refresh: ${CAPTIONS_FLAG_HELP}`),
  args: ([username]) => ({ username }),
  handler: async (input, ctx) => {
    if (input.captions && !input.refresh) {
      throw new IgError("INVALID_INPUT", "--captions only applies together with --refresh.", {
        hint: `Run \`ig creator get ${normalizeUsername(input.username)} --refresh --captions\`, or \`ig video captions --creator ${normalizeUsername(input.username)}\` to fill stored reels only.`,
      });
    }
    const creator = ctx.store.getCreator(normalizeUsername(input.username));
    if (!input.refresh) {
      return {
        data: creator,
        nextSteps: [
          {
            command: `ig creator get ${creator.username} --refresh`,
            description: "fetch the latest profile and reels",
          },
          {
            command: `ig video top --creator ${creator.username}`,
            description: "their best-performing stored videos",
          },
        ],
      };
    }

    const name = input.backend ?? ctx.config.backend;
    const gate = ctx.gate(name);
    const usedBefore = gate.budget.used;
    const backend = await ctx.backend(name);
    const outcome = await refreshCreator(ctx, backend, creator, {
      reels: input.reels,
      force: input.force,
      captions: input.captions,
    });
    const meta: GetMeta = {
      refresh: {
        status: outcome.status,
        reason: outcome.reason,
        newVideos: outcome.newVideos,
        requestsUsed: gate.budget.used - usedBefore,
        ...(outcome.captions ? { captions: outcome.captions } : {}),
      },
    };
    // By id: the account may have been renamed since it was stored.
    const updated = ctx.store.getCreator(creator.id);
    return {
      data: updated,
      meta,
      nextSteps: [
        outcome.status === "skipped"
          ? {
              command: `ig creator get ${updated.username} --refresh --force`,
              description: "refresh anyway",
            }
          : {
              command: `ig video top --creator ${updated.username}`,
              description: "their best-performing stored videos",
            },
      ],
    };
  },
  human: (data, _ctx, rawMeta) => {
    const meta = rawMeta as GetMeta;
    const bio = oneLine(data.biography);
    const pairs: [string, string][] = [
      ["creator", handle(data)],
      ["name", oneLine(data.fullName) || muted("–")],
      ["followers", compact(data.followers)],
      ["following", compact(data.following)],
      ["posts", compact(data.mediaCount)],
    ];
    if (data.category) pairs.push(["category", oneLine(data.category)]);
    if (bio) pairs.push(["bio", bio.length > 100 ? `${bio.slice(0, 99)}…` : bio]);
    if (data.externalUrl) pairs.push(["link", oneLine(data.externalUrl)]);
    pairs.push(
      ["niches", data.niches.join(", ") || muted("none")],
      ["videos stored", String(data.videoCount)],
      ["refreshed", data.refreshedAt ? ago(data.refreshedAt) : warn("never")],
      ["url", data.url],
    );
    process.stdout.write(`${renderRecord(pairs)}\n`);
    if (meta.refresh?.status === "skipped") {
      process.stderr.write(`${warn("not refreshed")} ${meta.refresh.reason ?? ""}\n`);
    } else if (meta.refresh) {
      const c = meta.refresh.captions;
      note(
        `refreshed: ${meta.refresh.newVideos} new video(s), ${meta.refresh.requestsUsed} request(s)${c ? `; captions: ${c.filled} filled with ${c.requests} of those request(s), ${c.missing} reel(s) still without` : ""}`,
      );
    }
  },
});

// --- creator list ---------------------------------------------------------------

type ListMeta = { niche: string | null; total: number; returned: number };

const listCmd = defineCommand({
  id: "creator.list",
  summary: "List tracked creators",
  input: z.object({
    niche: flags.niche,
    sort: z.enum(["followers", "username", "refreshed"]).default("followers"),
    limit: flags.limit(100, 5000),
  }),
  output: z.array(StoredCreatorSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .option("--niche <slug>", "only this niche")
      .option("--sort <key>", "followers | username | refreshed (stalest first)")
      .option("--limit <n>", "maximum results (default 100)"),
  handler: async (input, ctx) => {
    // Unlimited read, then cut: the total tells the caller whether --limit hid rows.
    const all = ctx.store.listCreators({ niche: input.niche, sort: input.sort });
    const data = all.slice(0, input.limit);
    const meta: ListMeta = {
      niche: input.niche ?? null,
      total: all.length,
      returned: data.length,
    };

    const nextSteps: NextStep[] = [];
    if (data.length === 0) {
      nextSteps.push({
        command: 'ig creator search "<topic>"',
        description: "discover creators to track",
      });
      if (input.niche) {
        nextSteps.push({
          command: `ig creator add <username> --niche ${input.niche}`,
          description: "add a creator to this niche",
        });
      }
    } else {
      if (input.niche) {
        nextSteps.push({
          command: `ig niche refresh ${input.niche}`,
          description: "fetch fresh reels and metrics",
        });
        nextSteps.push({
          command: `ig video top --niche ${input.niche}`,
          description: "best-performing videos in this niche",
        });
      } else {
        nextSteps.push({
          command: `ig creator get ${(data[0] as StoredCreator).username}`,
          description: "details of one creator",
        });
      }
      if (all.length > data.length) {
        nextSteps.push({
          command: `ig creator list${input.niche ? ` --niche ${input.niche}` : ""} --sort ${input.sort} --limit ${all.length}`,
          description: `all ${all.length} creators`,
        });
      }
    }
    return { data, meta, nextSteps };
  },
  human: (data, _ctx, rawMeta) => {
    const meta = rawMeta as unknown as ListMeta;
    printTable(
      data,
      creatorColumns({ niches: !meta.niche }),
      meta.niche ? `No creators in niche ${meta.niche}.` : "No creators are tracked yet.",
    );
    if (meta.total > data.length) note(`\n${data.length} shown of ${meta.total}`);
  },
});

// --- creator remove -------------------------------------------------------------

const remove = defineCommand({
  id: "creator.remove",
  summary: "Remove a creator from a niche, or stop tracking them entirely",
  description:
    "With --niche: removes the membership only; the creator and videos stay.\n" +
    "Without --niche: deletes the creator, their videos and metric history from\n" +
    "the database. That needs --yes. Downloaded files are never deleted.",
  input: z.object({
    username: z.string(),
    niche: flags.niche.describe("Remove from this niche only"),
    dryRun: flags.dryRun,
    yes: flags.yes,
  }),
  output: z.object({
    username: z.string(),
    action: z.enum(["removed-from-niche", "deleted", "would-remove-from-niche", "would-delete"]),
    niche: z.string().nullable(),
    videosDeleted: z.number().int(),
    filesLeftOnDisk: z.array(z.string()).describe("Downloaded files that were not deleted"),
  }),
  network: false,
  writes: "destructive",
  configure: (cmd) =>
    cmd
      .argument("<username>")
      .option("--niche <slug>", "remove from this niche only")
      .option("--dry-run", "report what would be removed")
      .option("--yes", "confirm deleting the creator and their data"),
  args: ([username]) => ({ username }),
  handler: async (input, ctx) => {
    const creator = ctx.store.getCreator(normalizeUsername(input.username));
    const username = creator.username;

    if (input.niche) {
      const niche = ctx.store.getNiche(input.niche).slug;
      if (!creator.niches.includes(niche)) {
        throw new IgError("NOT_FOUND", `${username} is not in niche ${niche}.`, {
          hint: creator.niches.length
            ? `It is in: ${creator.niches.join(", ")}.`
            : `It is in no niche. To stop tracking it: \`ig creator remove ${username} --dry-run\`.`,
        });
      }
      const base = { username, niche, videosDeleted: 0, filesLeftOnDisk: [] };
      if (input.dryRun) {
        return {
          data: { ...base, action: "would-remove-from-niche" as const },
          nextSteps: [
            {
              command: `ig creator remove ${username} --niche ${niche}`,
              description: "remove the membership; the creator and videos stay",
            },
          ],
        };
      }
      ctx.store.removeCreatorFromNiche(creator.id, niche);
      return {
        data: { ...base, action: "removed-from-niche" as const },
        nextSteps: [
          { command: `ig niche show ${niche}`, description: "what is left in the niche" },
        ],
      };
    }

    if (input.dryRun) {
      // The same rows the delete would take, read without deleting.
      const videos = ctx.store.listVideos({ creatorId: creator.id });
      return {
        data: {
          username,
          action: "would-delete" as const,
          niche: null,
          videosDeleted: videos.length,
          filesLeftOnDisk: videos.flatMap((v) => (v.localPath ? [v.localPath] : [])),
        },
        nextSteps: [
          {
            command: `ig creator remove ${username} --yes`,
            description: "delete the creator, their videos and metric history",
          },
        ],
      };
    }
    if (!input.yes) {
      throw new IgError(
        "INVALID_INPUT",
        `Deleting ${username} and their ${creator.videoCount} stored video(s) needs --yes.`,
        {
          hint: `Run \`ig creator remove ${username} --yes\` to delete, or \`ig creator remove ${username} --dry-run\` to preview.`,
        },
      );
    }
    const deleted = ctx.store.deleteCreator(creator.id);
    return {
      data: {
        username,
        action: "deleted" as const,
        niche: null,
        videosDeleted: deleted.videos,
        filesLeftOnDisk: deleted.localPaths,
      },
    };
  },
  human: (data) => {
    const dry = data.action.startsWith("would-");
    const pairs: [string, string][] = [
      ["creator", `@${oneLine(data.username)}`],
      ["result", dry ? warn(`${data.action} (dry run, nothing changed)`) : ok(data.action)],
    ];
    if (data.niche) pairs.push(["niche", data.niche]);
    else pairs.push([dry ? "videos to delete" : "videos deleted", String(data.videosDeleted)]);
    process.stdout.write(`${renderRecord(pairs)}\n`);
    if (data.filesLeftOnDisk.length > 0) {
      // Same stream as the paths, so the heading cannot drift away from its list.
      const heading = `${data.filesLeftOnDisk.length} downloaded file(s) stay on disk:`;
      process.stdout.write(`\n${muted(heading)}\n`);
      for (const path of data.filesLeftOnDisk) process.stdout.write(`  ${path}\n`);
    }
  },
});

export const creatorCommands = [search, add, get, listCmd, remove];
