// Choosing which stored videos a batch command works on: explicit targets, or
// a selection from the database (--top N ranked, or every downloaded video in
// a --niche / --creator scope, or --all-downloaded). One set of flags and one
// set of rules for `ig video transcribe` and `ig video analyze`.

import type { Command } from "commander";
import { z } from "zod";
import type { Context } from "../context.js";
import { uniqueTargets } from "../core/targets.js";
import { normalizeUsername, SORT_KEYS, SortKey, type StoredVideo } from "../core/types.js";
import { flags } from "../lib/command.js";
import { IgError } from "../lib/errors.js";
import type { NextStep } from "../lib/output.js";
import { selectTop } from "./video.js";

/** Spread into a command's `z.object({ ... })`. */
export const selectionFlags = {
  targets: z.array(z.string()).default([]).describe("Video ids, shortcodes or reel URLs"),
  top: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("The top N stored videos by --sort"),
  niche: flags.niche.describe("Only this niche"),
  creator: z.string().optional().describe("Only this creator"),
  sort: SortKey.default("outlier").describe("With --top: ranking"),
  allDownloaded: z.boolean().default(false).describe("Every downloaded video"),
};

export type SelectionInput = {
  targets: string[];
  top?: number;
  niche?: string;
  creator?: string;
  sort: SortKey;
  allDownloaded: boolean;
};

/** Declares the selection argument and flags on a commander command. */
export function addSelectionOptions(cmd: Command): Command {
  return cmd
    .argument("[targets...]", "video ids, shortcodes or reel URLs")
    .option("--top <n>", "the top N stored videos by --sort")
    .option("--niche <slug>", "only this niche")
    .option("--creator <username>", "only this creator")
    .option("--sort <key>", `with --top: ${SORT_KEYS.join(" | ")}`)
    .option("--all-downloaded", "every downloaded video");
}

export type Selection = {
  /** Stored videos from a selection, or the raw targets as typed. */
  targets: (StoredVideo | string)[];
  /** Where to get data when a --top scope holds no videos at all. */
  emptySteps: NextStep[];
  /** ` --niche <slug> --creator <username>` as given, for suggested commands. */
  scope: string;
};

/**
 * Validates the combination and resolves it. `verb` names the command
 * (`transcribe`, `analyze`) in messages and hints.
 */
export function resolveSelection(ctx: Context, input: SelectionInput, verb: string): Selection {
  const hint = `Run \`ig video ${verb} <shortcode>...\`, \`ig video ${verb} --top 10 --niche <slug>\` or \`ig video ${verb} --all-downloaded\`.`;
  const selecting =
    input.top !== undefined ||
    input.niche !== undefined ||
    input.creator !== undefined ||
    input.allDownloaded;
  if (input.targets.length > 0 && selecting) {
    throw new IgError(
      "INVALID_INPUT",
      "Give either targets or a selection (--top, --niche, --creator, --all-downloaded), not both.",
      { hint },
    );
  }
  if (input.targets.length === 0 && !selecting) {
    throw new IgError("INVALID_INPUT", `Nothing to ${verb}: give targets or a selection.`, {
      hint,
    });
  }
  if (input.top !== undefined && input.allDownloaded) {
    throw new IgError("INVALID_INPUT", "Give either --top or --all-downloaded, not both.", {
      hint,
    });
  }
  if (input.targets.length > 0) {
    return { targets: uniqueTargets(input.targets), emptySteps: [], scope: "" };
  }

  let scope = "";
  if (input.niche) scope += ` --niche ${ctx.store.getNiche(input.niche).slug}`;
  const creator = input.creator
    ? ctx.store.getCreator(normalizeUsername(input.creator))
    : undefined;
  if (creator) scope += ` --creator ${creator.username}`;
  if (input.top !== undefined) {
    const ranked = selectTop(ctx, {
      niche: input.niche,
      creator: input.creator,
      sort: input.sort,
      limit: input.top,
    });
    return { targets: ranked.videos, emptySteps: ranked.emptySteps, scope };
  }
  return {
    targets: ctx.store.listVideos({
      downloaded: true,
      niche: input.niche,
      creatorId: creator?.id,
    }),
    emptySteps: [],
    scope,
  };
}
