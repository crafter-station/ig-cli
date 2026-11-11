// Creator discovery: one keyword search, or with `expand` a union of every
// surface that can name an account. Instagram search is personalised and
// shallow, so breadth comes from combining sources, not from paging one.
//
// Nothing here touches the store. The command decides what to do with hits.

import type { Backend, CreatorCandidate } from "../backends/types.js";
import { IgError, toIgError } from "../lib/errors.js";
import type { Video } from "./types.js";

export type DiscoveryOptions = {
  query: string;
  /** False: only the keyword search for `query`. */
  expand: boolean;
  /** Extra keyword variants. Used only with `expand`. */
  also: string[];
  /** Hashtags without #. Empty means "derive one from the query". Used only with `expand`. */
  hashtags: string[];
  /** Page size asked of each source. */
  limit: number;
};

export type DiscoveredCreator = CreatorCandidate & {
  /** The first source that named this account. */
  source: string;
};

export type SourceReport = {
  /** keyword:<query>, reels:<query>, hashtag:<tag> or related:<username>. */
  source: string;
  /** Accounts the source returned. */
  found: number;
  /** Of those, how many no earlier source had already named. */
  added: number;
};

export type DiscoveryResult = {
  /** Unique by creator id, in the order first seen. */
  candidates: DiscoveredCreator[];
  sources: SourceReport[];
  /** Sources the backend cannot serve. They cost no result, not the run. */
  skipped: { source: string; reason: string }[];
};

/** How many keyword hits are asked for their related accounts. */
export const RELATED_SEEDS = 3;

/**
 * Largest first, unknown follower counts last. The one place this ordering is
 * written, because "unknown" sorting as zero or as infinity are both easy to
 * get wrong at a call site.
 */
export function byFollowersDesc(
  a: { followers: number | null },
  b: { followers: number | null },
): number {
  if (a.followers === null && b.followers === null) return 0;
  if (a.followers === null) return 1;
  if (b.followers === null) return -1;
  return b.followers - a.followers;
}

/** "GTA 6" -> "gta6", "Cocina Fácil" -> "cocinafácil". Empty when nothing usable is left. */
export function hashtagFromQuery(query: string): string {
  return query.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** A reel names its author by id and username only; everything else is unknown. */
function authorsOf(videos: Video[]): CreatorCandidate[] {
  return videos.map((v) => ({
    id: v.creatorId,
    username: v.creatorUsername,
    fullName: null,
    followers: null,
    isVerified: false,
    isPrivate: false,
  }));
}

export async function discoverCreators(
  backend: Backend,
  opts: DiscoveryOptions,
  log: (message: string) => void = () => {},
): Promise<DiscoveryResult> {
  const byId = new Map<string, DiscoveredCreator>();
  const sources: SourceReport[] = [];
  const skipped: { source: string; reason: string }[] = [];
  const page = { limit: opts.limit };

  const merge = (reportAs: string, source: string, found: CreatorCandidate[]): void => {
    const seenHere = new Set<string>();
    let added = 0;
    for (const candidate of found) {
      if (seenHere.has(candidate.id)) continue;
      seenHere.add(candidate.id);
      const existing = byId.get(candidate.id);
      if (!existing) {
        byId.set(candidate.id, { ...candidate, source });
        added++;
        continue;
      }
      // A later source may know what the first one omitted. The source label
      // stays with whoever found the account first.
      existing.followers ??= candidate.followers;
      existing.fullName ??= candidate.fullName;
      existing.isVerified ||= candidate.isVerified;
      existing.isPrivate ||= candidate.isPrivate;
    }
    sources.push({ source: reportAs, found: seenHere.size, added });
    log(`${reportAs}: ${seenHere.size} found, ${added} new`);
  };

  /** Runs one source. UNSUPPORTED skips it; every other error propagates. */
  const collect = async (
    reportAs: string,
    source: string,
    fetch: () => Promise<CreatorCandidate[]>,
  ): Promise<void> => {
    let found: CreatorCandidate[];
    try {
      found = await fetch();
    } catch (err) {
      const igErr = toIgError(err);
      if (igErr.code !== "UNSUPPORTED") throw igErr;
      skipped.push({ source: reportAs, reason: igErr.message });
      log(`${reportAs}: skipped, not supported by the ${backend.name} backend`);
      return;
    }
    merge(reportAs, source, found);
  };

  if (!opts.expand) {
    // Not wrapped: with a single source, UNSUPPORTED is the answer, not a skip.
    merge(`keyword:${opts.query}`, "keyword", await backend.searchCreators(opts.query, page));
    return { candidates: [...byId.values()], sources, skipped };
  }

  for (const keyword of unique([opts.query, ...opts.also])) {
    await collect(`keyword:${keyword}`, "keyword", () => backend.searchCreators(keyword, page));
  }

  await collect(`reels:${opts.query}`, `reels:${opts.query}`, async () =>
    authorsOf(await backend.searchReels(opts.query, page)),
  );

  const tags = unique(
    (opts.hashtags.length > 0 ? opts.hashtags : [hashtagFromQuery(opts.query)]).map((t) =>
      t.trim().replace(/^#+/, "").toLowerCase(),
    ),
  );
  for (const tag of tags) {
    await collect(`hashtag:${tag}`, `hashtag:${tag}`, async () =>
      authorsOf(await backend.hashtagReels(tag, page)),
    );
  }

  const seeds = [...byId.values()]
    .filter((c) => c.source === "keyword")
    .sort(byFollowersDesc)
    .slice(0, RELATED_SEEDS);
  for (const seed of seeds) {
    const label = `related:${seed.username}`;
    await collect(label, label, () =>
      backend.relatedCreators({ id: seed.id, username: seed.username }, page),
    );
  }

  // Every source refused: an empty success would hide that nothing was searched.
  if (sources.length === 0 && skipped.length > 0) {
    throw new IgError(
      "UNSUPPORTED",
      `The ${backend.name} backend supports none of the discovery sources.`,
      {
        hint: "Switch with `--backend`.",
        details: { skipped },
      },
    );
  }

  return { candidates: [...byId.values()], sources, skipped };
}
