import { z } from "zod";
import type { Backend } from "../backends/types.js";
import { bold, danger, muted, ok, warn } from "../cligentic/platform/style.js";
import { isFresh, refreshCreator } from "../core/refresh.js";
import {
  isSlug,
  NicheSchema,
  type StoredCreator,
  StoredCreatorSchema,
  slugify,
} from "../core/types.js";
import { defineCommand, flags } from "../lib/command.js";
import { IgError, toIgError } from "../lib/errors.js";
import { ago, compact } from "../lib/format.js";
import { type NextStep, oneLine } from "../lib/output.js";
import { printTable, renderRecord } from "../lib/table.js";
import { creatorColumns, isStopError, stopWithProgress } from "./creator.js";

const note = (text: string): void => {
  process.stderr.write(`${muted(text)}\n`);
};

const create = defineCommand({
  id: "niche.create",
  summary: "Create a niche: a named group of creators",
  input: z.object({
    slug: z.string().describe("Lowercase identifier: letters, digits, dashes. e.g. gta-6"),
    name: z.string().optional().describe("Display name. Defaults to the slug"),
    description: z.string().optional(),
  }),
  output: NicheSchema,
  network: false,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<slug>", "lowercase identifier, e.g. gta-6")
      .option("--name <name>", "display name")
      .option("--description <text>", "what belongs in this niche"),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    if (!isSlug(input.slug)) {
      const suggestion = slugify(input.slug);
      throw new IgError(
        "INVALID_INPUT",
        `Not a valid niche slug: ${JSON.stringify(input.slug)}. Use lowercase letters, digits and single dashes.`,
        {
          hint: isSlug(suggestion)
            ? `Try \`ig niche create ${suggestion}${input.name ? "" : ` --name ${JSON.stringify(input.slug.trim())}`}\`.`
            : "Pick a slug such as `gta-6` and pass the display name with --name.",
        },
      );
    }
    const niche = ctx.store.createNiche({
      slug: input.slug,
      name: input.name?.trim() || input.slug,
      description: input.description?.trim() || null,
    });
    return {
      data: niche,
      nextSteps: [
        {
          command: `ig creator search ${JSON.stringify(niche.name)}`,
          description: "discover creators for this niche",
        },
        {
          command: `ig creator add <username> --niche ${niche.slug}`,
          description: "track a creator in this niche",
        },
      ],
    };
  },
  human: (data) => {
    const pairs: [string, string][] = [
      ["niche", bold(data.slug)],
      ["name", oneLine(data.name)],
    ];
    if (data.description) pairs.push(["description", oneLine(data.description)]);
    pairs.push(["result", ok("created")]);
    process.stdout.write(`${renderRecord(pairs)}\n`);
  },
});

const list = defineCommand({
  id: "niche.list",
  summary: "List niches with creator and video counts",
  input: z.object({}),
  output: z.array(NicheSchema),
  network: false,
  writes: "none",
  handler: async (_input, ctx) => {
    const niches = ctx.store.listNiches();
    const nextSteps: NextStep[] = [];
    if (niches.length === 0) {
      nextSteps.push({ command: "ig niche create <slug>", description: "create the first niche" });
    } else {
      // The one with the most creators is the one most likely being worked on.
      const busiest = [...niches].sort((a, b) => b.creatorCount - a.creatorCount)[0];
      if (busiest) {
        nextSteps.push({
          command: `ig niche show ${busiest.slug}`,
          description: "creators in this niche",
        });
      }
      const empty = niches.find((n) => n.creatorCount === 0);
      if (empty) {
        nextSteps.push({
          command: `ig creator search ${JSON.stringify(empty.name)}`,
          description: `${empty.slug} has no creators yet`,
        });
      }
    }
    return { data: niches, nextSteps };
  },
  human: (data) => {
    printTable(
      data,
      [
        { header: "NICHE", cell: (n) => bold(n.slug) },
        { header: "NAME", cell: (n) => oneLine(n.name), maxWidth: 28 },
        { header: "CREATORS", align: "right", cell: (n) => String(n.creatorCount) },
        { header: "VIDEOS", align: "right", cell: (n) => compact(n.videoCount) },
        { header: "CREATED", cell: (n) => ago(n.createdAt) },
        { header: "DESCRIPTION", cell: (n) => oneLine(n.description), maxWidth: 40 },
      ],
      "No niches yet.",
    );
  },
});

const show = defineCommand({
  id: "niche.show",
  summary: "Show a niche and its creators",
  input: z.object({
    slug: z.string(),
    limit: flags.limit(100),
  }),
  output: z.object({
    niche: NicheSchema,
    creators: z.array(StoredCreatorSchema).describe("Largest first"),
  }),
  network: false,
  writes: "none",
  configure: (cmd) => cmd.argument("<slug>").option("--limit <n>", "maximum creators"),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    const niche = ctx.store.getNiche(input.slug);
    const creators = ctx.store.listCreators({
      niche: niche.slug,
      sort: "followers",
      limit: input.limit,
    });
    const nextSteps: NextStep[] =
      creators.length === 0
        ? [
            {
              command: `ig creator search ${JSON.stringify(niche.name)}`,
              description: "discover creators for this niche",
            },
            {
              command: `ig creator add <username> --niche ${niche.slug}`,
              description: "track a creator in this niche",
            },
          ]
        : [
            {
              command: `ig niche refresh ${niche.slug}`,
              description: "fetch fresh reels and metrics",
            },
            {
              command: `ig video top --niche ${niche.slug}`,
              description: "best-performing videos in this niche",
            },
          ];
    if (niche.creatorCount > creators.length) {
      nextSteps.push({
        command: `ig creator list --niche ${niche.slug} --limit ${niche.creatorCount}`,
        description: `all ${niche.creatorCount} creators`,
      });
    }
    return { data: { niche, creators }, nextSteps };
  },
  human: (data) => {
    const n = data.niche;
    const title = oneLine(n.name) === n.slug ? bold(n.slug) : `${bold(n.slug)}  ${oneLine(n.name)}`;
    process.stdout.write(
      `${title}  ${muted(`${n.creatorCount} creator(s) · ${compact(n.videoCount)} video(s)`)}\n`,
    );
    if (n.description) process.stdout.write(`${muted(oneLine(n.description))}\n`);
    process.stdout.write("\n");
    printTable(data.creators, creatorColumns({ niches: false }), "No creators in this niche yet.");
    if (n.creatorCount > data.creators.length && data.creators.length > 0) {
      note(`\n${data.creators.length} shown of ${n.creatorCount}`);
    }
  },
});

export const RefreshItemSchema = z.object({
  username: z.string(),
  status: z.enum(["refreshed", "skipped", "failed", "would-refresh"]),
  reason: z
    .string()
    .nullable()
    .describe("Why it was skipped or failed, e.g. 'refreshed 2d ago', 'account not found'"),
  followers: z.number().int().nullable(),
  newVideos: z.number().int().describe("Videos seen for the first time in this run"),
  totalVideos: z.number().int().describe("Videos stored for this creator after the run"),
});
type RefreshItem = z.infer<typeof RefreshItemSchema>;

/** What `niche refresh` would do to one creator, decided without any request. */
function planItem(creator: StoredCreator, fresh: boolean): RefreshItem {
  return {
    username: creator.username,
    status: fresh ? "skipped" : "would-refresh",
    reason: fresh ? `refreshed ${ago(creator.refreshedAt)}; use --force to refresh anyway` : null,
    followers: creator.followers,
    newVideos: 0,
    totalVideos: creator.videoCount,
  };
}

const refresh = defineCommand({
  id: "niche.refresh",
  summary: "Fetch fresh profile and reel metrics for every creator in a niche",
  description:
    "Creators refreshed more recently than `minRefreshDays` are skipped unless --force.\n" +
    "Stale creators go first. Progress is saved per creator, so a run stopped by a\n" +
    "block or the daily budget loses nothing and can be continued later.",
  input: z.object({
    slug: z.string(),
    reels: z.coerce.number().int().min(0).max(100).default(15).describe("Reels per creator"),
    maxCreators: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Stop after this many creators"),
    backend: flags.backend,
    force: flags.force.describe("Refresh even if refreshed recently"),
    dryRun: flags.dryRun,
  }),
  output: z.object({
    niche: z.string(),
    backend: z.string(),
    refreshed: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    requestsUsed: z.number().int().describe("Backend requests spent by this run"),
    items: z.array(RefreshItemSchema),
  }),
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<slug>")
      .option("--reels <n>", "reels to fetch per creator (default 15)")
      .option("--max-creators <n>", "stop after this many creators")
      .option("--backend <name>", "browser | hiker")
      .option("--force", "refresh even if refreshed recently")
      .option("--dry-run", "list what would be refreshed; makes no requests"),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    const niche = ctx.store.getNiche(input.slug).slug;
    const name = input.backend ?? ctx.config.backend;
    const gate = ctx.gate(name);
    const usedBefore = gate.budget.used;

    // Stalest first, so a run cut short by the budget did the most useful part.
    const inNiche = ctx.store.listCreators({ niche, sort: "refreshed" });
    const creators = input.maxCreators ? inNiche.slice(0, input.maxCreators) : inNiche;
    const items: RefreshItem[] = [];
    const count = (status: RefreshItem["status"]): number =>
      items.filter((item) => item.status === status).length;
    const summary = () => ({
      niche,
      backend: name,
      refreshed: count("refreshed"),
      skipped: count("skipped"),
      failed: count("failed"),
      requestsUsed: gate.budget.used - usedBefore,
      items,
    });

    if (creators.length === 0) {
      return {
        data: summary(),
        nextSteps: [
          {
            command: `ig creator add <username> --niche ${niche}`,
            description: "this niche has no creators to refresh",
          },
        ],
      };
    }

    if (input.dryRun) {
      // The freshness rule only reads the backend's name, so the plan is made
      // without creating a backend: no browser is launched, no request is spent.
      const named = { name } as Backend;
      for (const creator of creators) {
        items.push(planItem(creator, !input.force && isFresh(ctx, named, creator)));
      }
      const would = count("would-refresh");
      const { remaining } = gate.budget;
      const halt = gate.halted();
      // One for the profile, at least one for reels. An estimate, not a quote.
      const estimatedRequests = would * (input.reels > 0 ? 2 : 1);
      const nextSteps: NextStep[] = [];
      if (halt) {
        nextSteps.push({
          command: `ig auth resume ${name}`,
          description: "the backend is halted; check the account by hand first",
        });
      }
      if (would > 0) {
        nextSteps.push({
          command: `ig niche refresh ${niche}${input.force ? " --force" : ""}${input.reels !== 15 ? ` --reels ${input.reels}` : ""}${input.maxCreators ? ` --max-creators ${input.maxCreators}` : ""}${input.backend ? ` --backend ${input.backend}` : ""}`,
          description: `refresh ${would} creator(s), about ${estimatedRequests} request(s); ${remaining} left today`,
        });
      } else {
        nextSteps.push({
          command: `ig niche refresh ${niche} --force --dry-run`,
          description: "everything is fresh; preview a forced refresh",
        });
      }
      return {
        data: summary(),
        meta: {
          dryRun: true,
          wouldRefresh: would,
          estimatedRequests,
          budgetRemaining: remaining,
          halted: halt !== null,
          notConsidered: inNiche.length - creators.length,
        },
        nextSteps,
      };
    }

    // A halted or exhausted backend fails here, before any work.
    gate.check();
    const backend = await ctx.backend(name);

    for (const [i, creator] of creators.entries()) {
      const position = `${i + 1}/${creators.length}`;
      try {
        const outcome = await refreshCreator(ctx, backend, creator, {
          reels: input.reels,
          force: input.force,
        });
        items.push(outcome);
        ctx.log(
          outcome.status === "refreshed"
            ? `${position} @${outcome.username}: ${compact(outcome.followers)} followers, ${outcome.newVideos} new of ${outcome.totalVideos} videos`
            : `${position} @${outcome.username}: skipped, ${outcome.reason}`,
        );
      } catch (err) {
        const igErr = toIgError(err);
        if (isStopError(igErr)) {
          // Everything in `items` is already stored. Say so, and what is left.
          const { items: done, ...counts } = summary();
          throw stopWithProgress(igErr, {
            ...counts,
            stoppedAt: creator.username,
            remaining: creators.length - i,
            total: creators.length,
            items: done,
            resume: `ig niche refresh ${niche}`,
          });
        }
        items.push({
          username: creator.username,
          status: "failed",
          reason:
            igErr.code === "NOT_FOUND"
              ? "account not found (renamed, deleted or deactivated)"
              : `${igErr.code}: ${igErr.message}`,
          followers: creator.followers,
          newVideos: 0,
          totalVideos: creator.videoCount,
        });
        ctx.log(`${position} @${creator.username}: failed, ${igErr.message}`);
      }
    }

    const data = summary();
    const nextSteps: NextStep[] = [];
    if (data.refreshed > 0) {
      nextSteps.push({
        command: `ig video top --niche ${niche}`,
        description: "best-performing videos in this niche",
      });
    }
    const gone = items.find(
      (item) => item.status === "failed" && item.reason?.startsWith("account not found"),
    );
    if (gone) {
      nextSteps.push({
        command: `ig creator remove ${gone.username} --niche ${niche}`,
        description: "drop an account that no longer exists from the niche",
      });
    }
    if (data.skipped > 0 && data.refreshed === 0) {
      nextSteps.push({
        command: `ig niche refresh ${niche} --force`,
        description: `${data.skipped} creator(s) were fresh; refresh them anyway`,
      });
    }
    if (inNiche.length > creators.length) {
      nextSteps.push({
        command: `ig niche refresh ${niche} --max-creators ${input.maxCreators}`,
        description: `${inNiche.length - creators.length} more creator(s) in the niche; stalest go first`,
      });
    }
    return { data, meta: { notConsidered: inNiche.length - creators.length }, nextSteps };
  },
  human: (data, _ctx, meta) => {
    if (data.items.length === 0) {
      note(`Niche ${data.niche} has no creators to refresh.`);
      return;
    }
    const would = data.items.filter((item) => item.status === "would-refresh").length;
    const parts = meta.dryRun
      ? [
          warn(`dry run: ${would} would be refreshed`),
          `${data.skipped} skipped`,
          `about ${meta.estimatedRequests} request(s), ${meta.budgetRemaining} left today`,
        ]
      : [
          ok(`${data.refreshed} refreshed`),
          `${data.skipped} skipped`,
          data.failed > 0 ? danger(`${data.failed} failed`) : "0 failed",
          `${data.requestsUsed} request(s)`,
        ];
    process.stdout.write(`${bold(data.niche)} on ${data.backend}: ${parts.join(muted(" · "))}\n\n`);

    const status = (item: RefreshItem): string =>
      item.status === "failed"
        ? danger("failed")
        : item.status === "refreshed"
          ? ok("refreshed")
          : item.status === "would-refresh"
            ? warn("would refresh")
            : muted("skipped");
    printTable(
      data.items,
      [
        { header: "CREATOR", cell: (item) => `@${oneLine(item.username)}` },
        { header: "RESULT", cell: status },
        { header: "FOLLOWERS", align: "right", cell: (item) => compact(item.followers) },
        {
          header: "NEW",
          align: "right",
          cell: (item) => (item.newVideos > 0 ? `+${item.newVideos}` : muted("–")),
        },
        { header: "VIDEOS", align: "right", cell: (item) => String(item.totalVideos) },
        { header: "NOTE", cell: (item) => oneLine(item.reason), maxWidth: 60 },
      ],
      "Nothing to refresh.",
    );
    if (meta.halted) {
      process.stderr.write(`${warn("backend is halted")} a real run would stop immediately\n`);
    }
  },
});

export const nicheCommands = [create, list, show, refresh];
