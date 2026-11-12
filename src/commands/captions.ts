// `ig video captions`: fill the captions of reels that are already stored,
// without fetching their metrics again. The companion of `--captions` on the
// refresh commands, for creators tracked before that flag was used.

import { z } from "zod";
import { bold, danger, muted, ok, warn } from "../cligentic/platform/style.js";
import {
  backfillCaptions,
  CAPTION_MAX_REQUESTS,
  missingCaptions,
  pagesForCaptions,
} from "../core/captions.js";
import { normalizeUsername, type StoredCreator } from "../core/types.js";
import { defineCommand, flags } from "../lib/command.js";
import { IgError, toIgError } from "../lib/errors.js";
import { type NextStep, oneLine } from "../lib/output.js";
import { printTable } from "../lib/table.js";
import { isStopError, stopWithProgress } from "./creator.js";

/** One request opens the profile; the rest are pages of 12 posts. */
const DEFAULT_MAX_REQUESTS = CAPTION_MAX_REQUESTS + 1;

const ItemSchema = z.object({
  username: z.string(),
  status: z.enum(["filled", "none-found", "failed", "would-fill", "unsupported"]),
  reason: z.string().nullable().describe("Why nothing was filled; null otherwise"),
  missingBefore: z.number().int().describe("Stored reels without a caption before the run"),
  filled: z.number().int(),
  missing: z
    .number()
    .int()
    .describe("Stored reels whose caption is still unknown (null). An empty caption is known"),
  requests: z.number().int().describe("Backend requests spent on this creator"),
});
type Item = z.infer<typeof ItemSchema>;

type CaptionsMeta = {
  dryRun?: boolean;
  /** Tracked creators in scope whose stored reels all have a caption. */
  complete: number;
  notConsidered: number;
  estimatedRequestsMin?: number;
  estimatedRequestsMax?: number;
  budgetRemaining?: number;
  halted?: boolean;
};

const captions = defineCommand({
  id: "video.captions",
  summary: "Fill missing captions of stored reels, without re-fetching metrics",
  description:
    "The browser backend stores a reel without its caption when the reel was not\n" +
    "among the creator's 12 latest posts at refresh time. This reads further back\n" +
    "through the creator's posts and fills what is missing: caption, hashtags,\n" +
    "mentions, sound, video URL. Play counts are not touched.\n" +
    "Cost per creator on browser: 1 request to open the profile plus 1 per 12 posts\n" +
    `read, at most --max-requests (default ${DEFAULT_MAX_REQUESTS}). Reading stops as soon as the reels\n` +
    "without a caption are covered. A single reel left over is fetched by itself\n" +
    "(1 request) instead of reading on for it. Creators with nothing missing cost\n" +
    "nothing, and a reel found to have no caption text is not asked for again.\n" +
    "It is not held back by `minRefreshDays`: preview the cost with --dry-run.\n" +
    "The hiker backend always returns captions, so there is nothing to do there.\n" +
    "To get complete captions while refreshing, use `ig niche refresh --captions`.",
  input: z.object({
    creator: z.string().optional().describe("Only this creator: username, @handle or URL"),
    niche: flags.niche,
    maxCreators: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Stop after this many creators"),
    maxRequests: z.coerce
      .number()
      .int()
      .min(2)
      .max(31)
      .default(DEFAULT_MAX_REQUESTS)
      .describe("Most requests one creator may cost, opening the profile included"),
    backend: flags.backend,
    dryRun: flags.dryRun,
  }),
  output: z.object({
    backend: z.string(),
    filled: z.number().int().describe("Captions filled by this run"),
    missing: z.number().int().describe("Reels in scope still stored without a caption"),
    requestsUsed: z.number().int().describe("Backend requests spent by this run"),
    items: z.array(ItemSchema).describe("One per creator that had reels without a caption"),
  }),
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .option("--creator <username>", "only this creator")
      .option("--niche <slug>", "only creators of this niche")
      .option("--max-creators <n>", "stop after this many creators")
      .option(
        "--max-requests <n>",
        `most requests per creator, opening the profile included (default ${DEFAULT_MAX_REQUESTS})`,
      )
      .option("--backend <name>", "browser | hiker")
      .option("--dry-run", "list who lacks captions and the cost ceiling; makes no requests"),
  handler: async (input, ctx) => {
    if (input.creator && input.niche) {
      throw new IgError("INVALID_INPUT", "Pass --creator or --niche, not both.", {
        hint: "Without either, every tracked creator is considered.",
      });
    }
    const name = input.backend ?? ctx.config.backend;
    const gate = ctx.gate(name);
    const usedBefore = gate.budget.used;

    const scope: StoredCreator[] = input.creator
      ? [ctx.store.getCreator(normalizeUsername(input.creator))]
      : ctx.store.listCreators(input.niche ? { niche: ctx.store.getNiche(input.niche).slug } : {});
    // Most to gain first, so a run cut short by the budget did the most useful part.
    const lacking = scope
      .map((creator) => ({ creator, missing: missingCaptions(ctx, creator.id).length }))
      .filter((entry) => entry.missing > 0)
      .sort((x, y) => y.missing - x.missing);
    const chosen = input.maxCreators ? lacking.slice(0, input.maxCreators) : lacking;
    const baseMeta: CaptionsMeta = {
      complete: scope.length - lacking.length,
      notConsidered: lacking.length - chosen.length,
    };
    const scopeFlag = input.creator
      ? ` --creator ${chosen[0]?.creator.username ?? normalizeUsername(input.creator)}`
      : input.niche
        ? ` --niche ${input.niche}`
        : "";

    const items: Item[] = [];
    const summary = () => ({
      backend: name,
      filled: items.reduce((sum, item) => sum + item.filled, 0),
      missing: items.reduce((sum, item) => sum + item.missing, 0),
      requestsUsed: gate.budget.used - usedBefore,
      items,
    });
    const planned = (status: Item["status"], reason: string | null): void => {
      for (const { creator, missing } of chosen) {
        items.push({
          username: creator.username,
          status,
          reason,
          missingBefore: missing,
          filled: 0,
          missing,
          requests: 0,
        });
      }
    };

    if (chosen.length === 0) {
      return {
        data: summary(),
        meta: baseMeta,
        nextSteps: [
          {
            command: "ig video search <words>",
            description: "every stored reel in scope has a caption; search them",
          },
        ],
      };
    }

    // Decided from the backend's name, so no browser is launched to say so.
    if (!pagesForCaptions(name)) {
      planned(
        "unsupported",
        `the ${name} backend returns captions with the reels; refresh the creator instead`,
      );
      const first = chosen[0]?.creator.username;
      return {
        data: summary(),
        meta: baseMeta,
        nextSteps: [
          {
            command: `ig creator get ${first} --refresh --backend ${name}`,
            description: "a refresh on this backend stores captions for every reel it returns",
          },
        ],
      };
    }

    if (input.dryRun) {
      planned("would-fill", null);
      const halt = gate.halted();
      const { remaining } = gate.budget;
      const min = chosen.length;
      // A creator missing one caption costs exactly one request: that reel by itself.
      const max = chosen.reduce(
        (sum, entry) => sum + (entry.missing === 1 ? 1 : input.maxRequests),
        0,
      );
      const nextSteps: NextStep[] = [];
      if (halt) {
        nextSteps.push({
          command: `ig auth resume ${name}`,
          description: "the backend is halted; check the account by hand first",
        });
      }
      nextSteps.push({
        command: `ig video captions${scopeFlag}${input.maxCreators ? ` --max-creators ${input.maxCreators}` : ""}${input.maxRequests !== DEFAULT_MAX_REQUESTS ? ` --max-requests ${input.maxRequests}` : ""}${input.backend ? ` --backend ${input.backend}` : ""}`,
        description: `fill captions for ${chosen.length} creator(s): between ${min} and ${max} request(s); ${remaining} left today`,
      });
      return {
        data: summary(),
        meta: {
          ...baseMeta,
          dryRun: true,
          estimatedRequestsMin: min,
          estimatedRequestsMax: max,
          budgetRemaining: remaining,
          halted: halt !== null,
        },
        nextSteps,
      };
    }

    // A halted or exhausted backend fails here, before any work.
    gate.check();
    const backend = await ctx.backend(name);

    for (const [i, { creator, missing }] of chosen.entries()) {
      const position = `${i + 1}/${chosen.length}`;
      try {
        const outcome = await backfillCaptions(ctx, backend, creator, {
          maxRequests: input.maxRequests,
        });
        // "unsupported" and "nothing-missing" cannot happen here: both were ruled out above.
        const status = outcome.filled > 0 ? "filled" : "none-found";
        items.push({
          username: outcome.username,
          status,
          reason:
            status === "filled"
              ? null
              : outcome.missing === 0
                ? "the reels have no caption text or no longer exist; they will not be asked for again"
                : "not among the posts read: older than the request cap reaches, or kept off the profile grid",
          missingBefore: outcome.missingBefore,
          filled: outcome.filled,
          missing: outcome.missing,
          requests: outcome.requests,
        });
        ctx.log(
          `${position} @${outcome.username}: ${outcome.filled} of ${outcome.missingBefore} caption(s) filled, ${outcome.requests} request(s)`,
        );
      } catch (err) {
        const igErr = toIgError(err);
        if (isStopError(igErr)) {
          // Everything in `items` is already stored. Say so, and what is left.
          const { items: done, ...counts } = summary();
          throw stopWithProgress(igErr, {
            ...counts,
            stoppedAt: creator.username,
            remaining: chosen.length - i,
            total: chosen.length,
            items: done,
            resume: `ig video captions${scopeFlag}`,
          });
        }
        items.push({
          username: creator.username,
          status: "failed",
          reason:
            igErr.code === "NOT_FOUND"
              ? "account not found (renamed, deleted or deactivated)"
              : `${igErr.code}: ${igErr.message}`,
          missingBefore: missing,
          filled: 0,
          missing,
          requests: 0,
        });
        ctx.log(`${position} @${creator.username}: failed, ${igErr.message}`);
      }
    }

    const data = summary();
    const nextSteps: NextStep[] = [];
    if (data.filled > 0) {
      nextSteps.push({
        command: "ig video search <words>",
        description: "captions are searchable now",
      });
    }
    const short = items.find((item) => item.status !== "failed" && item.missing > 0);
    if (short) {
      nextSteps.push({
        command: `ig video list ${short.username}`,
        description:
          "see which reels still lack a caption; `ig video download <shortcode>` fetches one reel with its caption",
      });
    }
    if (baseMeta.notConsidered > 0) {
      nextSteps.push({
        command: `ig video captions${scopeFlag} --max-creators ${input.maxCreators}`,
        description: `${baseMeta.notConsidered} more creator(s) lack captions; the ones lacking most go first`,
      });
    }
    return { data, meta: baseMeta, nextSteps };
  },
  human: (data, _ctx, rawMeta) => {
    const meta = rawMeta as unknown as CaptionsMeta;
    if (data.items.length === 0) {
      process.stderr.write(`${muted("Every stored reel in scope has a caption.")}\n`);
      return;
    }
    const parts = meta.dryRun
      ? [
          warn(`dry run: ${data.items.length} creator(s) lack captions`),
          `${data.missing} reel(s) without caption`,
          `between ${meta.estimatedRequestsMin} and ${meta.estimatedRequestsMax} request(s), ${meta.budgetRemaining} left today`,
        ]
      : [
          ok(`${data.filled} caption(s) filled`),
          `${data.missing} still missing`,
          `${data.requestsUsed} request(s)`,
        ];
    process.stdout.write(`${bold("captions")} on ${data.backend}: ${parts.join(muted(" · "))}\n\n`);
    const status = (item: Item): string =>
      item.status === "failed"
        ? danger("failed")
        : item.status === "filled"
          ? ok("filled")
          : item.status === "would-fill"
            ? warn("would fill")
            : muted(item.status === "unsupported" ? "not needed" : "none found");
    printTable(
      data.items,
      [
        { header: "CREATOR", cell: (item) => `@${oneLine(item.username)}` },
        { header: "RESULT", cell: status },
        { header: "MISSING", align: "right", cell: (item) => String(item.missingBefore) },
        {
          header: "FILLED",
          align: "right",
          cell: (item) => (item.filled > 0 ? `+${item.filled}` : muted("–")),
        },
        { header: "LEFT", align: "right", cell: (item) => String(item.missing) },
        { header: "REQUESTS", align: "right", cell: (item) => String(item.requests) },
        { header: "NOTE", cell: (item) => oneLine(item.reason), maxWidth: 60 },
      ],
      "Nothing to fill.",
    );
    if (meta.halted) {
      process.stderr.write(`${warn("backend is halted")} a real run would stop immediately\n`);
    }
  },
});

export const captionCommands = [captions];
