// All SQL lives here. Commands and backends never write queries; they call the
// Store. That keeps the stored shape and the published JSON shape in one place.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type Creator,
  extractTags,
  type Niche,
  profileUrl,
  reelUrl,
  type StoredCreator,
  type StoredVideo,
  type Transcript,
  type Video,
} from "../core/types.js";
import { IgError } from "../lib/errors.js";
import { MIGRATIONS } from "./schema.js";

type Row = Record<string, unknown>;

// Loaded on first use, not at import time: the module emits an
// ExperimentalWarning on load, and lib/quiet.ts must be in place before that.
// A static import would be hoisted above it by the bundler.
const require = createRequire(import.meta.url);
function openDatabase(path: string): DatabaseSync {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  return new sqlite.DatabaseSync(path);
}

const now = (): string => new Date().toISOString();

/** Local calendar day, YYYY-MM-DD. Budgets reset at the user's midnight. */
export function localDay(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type CreatorListOptions = {
  niche?: string;
  limit?: number;
  sort?: "followers" | "username" | "refreshed";
};

export type VideoListOptions = {
  creatorId?: string;
  niche?: string;
  /** Only videos taken at or after this ISO timestamp. */
  since?: string;
  downloaded?: boolean;
  limit?: number;
};

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Runs `fn` in a transaction; rolls back if it throws. Not reentrant. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- niches ---------------------------------------------------------------

  createNiche(input: { slug: string; name: string; description?: string | null }): Niche {
    if (this.findNiche(input.slug)) {
      throw new IgError("ALREADY_EXISTS", `Niche already exists: ${input.slug}`, {
        hint: `Run \`ig niche show ${input.slug}\`.`,
      });
    }
    this.db
      .prepare("INSERT INTO niches (slug, name, description, created_at) VALUES (?, ?, ?, ?)")
      .run(input.slug, input.name, input.description ?? null, now());
    return this.getNiche(input.slug);
  }

  private nicheQuery = `
    SELECT n.slug, n.name, n.description, n.created_at,
      (SELECT COUNT(*) FROM niche_creators nc WHERE nc.niche_id = n.id) AS creator_count,
      (SELECT COUNT(*) FROM videos v
         JOIN niche_creators nc ON nc.creator_id = v.creator_id
        WHERE nc.niche_id = n.id) AS video_count
    FROM niches n`;

  listNiches(): Niche[] {
    const rows = this.db.prepare(`${this.nicheQuery} ORDER BY n.slug`).all() as Row[];
    return rows.map(toNiche);
  }

  findNiche(slug: string): Niche | null {
    const row = this.db.prepare(`${this.nicheQuery} WHERE n.slug = ?`).get(slug) as Row | undefined;
    return row ? toNiche(row) : null;
  }

  getNiche(slug: string): Niche {
    const niche = this.findNiche(slug);
    if (!niche) {
      throw new IgError("NOT_FOUND", `No such niche: ${slug}`, {
        hint: `List niches with \`ig niche list\` or create it with \`ig niche create ${slug}\`.`,
      });
    }
    return niche;
  }

  private nicheId(slug: string): number {
    this.getNiche(slug);
    const row = this.db.prepare("SELECT id FROM niches WHERE slug = ?").get(slug) as { id: number };
    return row.id;
  }

  // --- creators -------------------------------------------------------------

  /**
   * Inserts or updates a creator. `refreshed` marks this as a full fetch: it
   * stamps `refreshed_at` and records a metrics snapshot. Pass false when the
   * data is partial (a search hit promoted to a stored creator).
   */
  upsertCreator(c: Creator, opts: { refreshed?: boolean } = {}): void {
    const ts = now();
    const refreshed = opts.refreshed ?? true;
    this.db
      .prepare(
        `INSERT INTO creators
           (id, username, full_name, biography, followers, following, media_count,
            is_verified, is_private, category, external_url, profile_pic_url,
            first_seen_at, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           full_name = COALESCE(excluded.full_name, full_name),
           biography = COALESCE(excluded.biography, biography),
           followers = COALESCE(excluded.followers, followers),
           following = COALESCE(excluded.following, following),
           media_count = COALESCE(excluded.media_count, media_count),
           is_verified = excluded.is_verified,
           is_private = excluded.is_private,
           category = COALESCE(excluded.category, category),
           external_url = COALESCE(excluded.external_url, external_url),
           profile_pic_url = COALESCE(excluded.profile_pic_url, profile_pic_url),
           refreshed_at = COALESCE(excluded.refreshed_at, refreshed_at)`,
      )
      .run(
        c.id,
        c.username,
        c.fullName,
        c.biography,
        c.followers,
        c.following,
        c.mediaCount,
        c.isVerified ? 1 : 0,
        c.isPrivate ? 1 : 0,
        c.category,
        c.externalUrl,
        c.profilePicUrl,
        ts,
        refreshed ? ts : null,
      );
    if (refreshed) {
      this.db
        .prepare(
          `INSERT INTO creator_snapshots (creator_id, taken_at, followers, following, media_count)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(c.id, ts, c.followers, c.following, c.mediaCount);
    }
  }

  private creatorQuery = `
    SELECT c.*,
      (SELECT COUNT(*) FROM videos v WHERE v.creator_id = c.id) AS video_count,
      (SELECT GROUP_CONCAT(n.slug, ',') FROM niche_creators nc
         JOIN niches n ON n.id = nc.niche_id WHERE nc.creator_id = c.id) AS niche_slugs
    FROM creators c`;

  /** Looks up by username or numeric id. */
  findCreator(usernameOrId: string): StoredCreator | null {
    const row = this.db
      .prepare(`${this.creatorQuery} WHERE c.username = ? OR c.id = ?`)
      .get(usernameOrId, usernameOrId) as Row | undefined;
    return row ? toCreator(row) : null;
  }

  getCreator(usernameOrId: string): StoredCreator {
    const creator = this.findCreator(usernameOrId);
    if (!creator) {
      throw new IgError("NOT_FOUND", `Creator is not tracked: ${usernameOrId}`, {
        hint: `Add it with \`ig creator add ${usernameOrId}\`.`,
      });
    }
    return creator;
  }

  listCreators(opts: CreatorListOptions = {}): StoredCreator[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.niche) {
      where.push("c.id IN (SELECT creator_id FROM niche_creators WHERE niche_id = ?)");
      params.push(this.nicheId(opts.niche));
    }
    const order =
      opts.sort === "username"
        ? "c.username ASC"
        : opts.sort === "refreshed"
          ? "c.refreshed_at IS NULL DESC, c.refreshed_at ASC"
          : "c.followers IS NULL ASC, c.followers DESC";
    let sql = `${this.creatorQuery}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order}`;
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return (this.db.prepare(sql).all(...params) as Row[]).map(toCreator);
  }

  /** Returns true if the creator was newly added to the niche. */
  addCreatorToNiche(creatorId: string, nicheSlug: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO niche_creators (niche_id, creator_id, added_at) VALUES (?, ?, ?)",
      )
      .run(this.nicheId(nicheSlug), creatorId, now());
    return Number(result.changes) > 0;
  }

  /** Returns true if the creator was in the niche. */
  removeCreatorFromNiche(creatorId: string, nicheSlug: string): boolean {
    const result = this.db
      .prepare("DELETE FROM niche_creators WHERE niche_id = ? AND creator_id = ?")
      .run(this.nicheId(nicheSlug), creatorId);
    return Number(result.changes) > 0;
  }

  /**
   * Deletes a creator with their videos, snapshots and niche memberships.
   * Downloaded files on disk are not touched; the caller reports their paths.
   */
  deleteCreator(creatorId: string): { videos: number; localPaths: string[] } {
    return this.tx(() => {
      const paths = this.db
        .prepare("SELECT local_path FROM videos WHERE creator_id = ? AND local_path IS NOT NULL")
        .all(creatorId) as { local_path: string }[];
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM videos WHERE creator_id = ?")
        .get(creatorId) as { n: number };
      this.db
        .prepare(
          "DELETE FROM videos_fts WHERE video_id IN (SELECT id FROM videos WHERE creator_id = ?)",
        )
        .run(creatorId);
      this.db.prepare("DELETE FROM creators WHERE id = ?").run(creatorId);
      return { videos: count.n, localPaths: paths.map((p) => p.local_path) };
    });
  }

  // --- videos ---------------------------------------------------------------

  /**
   * Inserts or updates videos and records one metrics snapshot per video.
   * The creator must already be stored. Returns how many were new.
   */
  upsertVideos(videos: Video[]): { inserted: number; updated: number } {
    if (videos.length === 0) return { inserted: 0, updated: 0 };
    const ts = now();
    const exists = this.db.prepare("SELECT 1 FROM videos WHERE id = ?");
    const upsert = this.db.prepare(
      `INSERT INTO videos
         (id, shortcode, creator_id, caption, taken_at, duration_sec, plays, likes, comments,
          thumbnail_url, video_url, first_seen_at, refreshed_at,
          hashtags, mentions, audio_id, audio_title, audio_artist, audio_is_original)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         caption = COALESCE(excluded.caption, caption),
         taken_at = COALESCE(excluded.taken_at, taken_at),
         duration_sec = COALESCE(excluded.duration_sec, duration_sec),
         plays = COALESCE(excluded.plays, plays),
         likes = COALESCE(excluded.likes, likes),
         comments = COALESCE(excluded.comments, comments),
         thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
         video_url = COALESCE(excluded.video_url, video_url),
         hashtags = CASE WHEN excluded.caption IS NULL THEN hashtags ELSE excluded.hashtags END,
         mentions = CASE WHEN excluded.caption IS NULL THEN mentions ELSE excluded.mentions END,
         audio_id = COALESCE(excluded.audio_id, audio_id),
         audio_title = COALESCE(excluded.audio_title, audio_title),
         audio_artist = COALESCE(excluded.audio_artist, audio_artist),
         audio_is_original = COALESCE(excluded.audio_is_original, audio_is_original),
         refreshed_at = excluded.refreshed_at`,
    );
    const snapshot = this.db.prepare(
      "INSERT INTO video_snapshots (video_id, taken_at, plays, likes, comments) VALUES (?, ?, ?, ?, ?)",
    );
    const dropFts = this.db.prepare("DELETE FROM videos_fts WHERE video_id = ?");
    const addFts = this.db.prepare(
      "INSERT INTO videos_fts (video_id, caption, username) VALUES (?, ?, ?)",
    );

    return this.tx(() => {
      let inserted = 0;
      for (const v of videos) {
        if (!exists.get(v.id)) inserted++;
        const tags = extractTags(v.caption);
        const original = v.audio?.isOriginal;
        upsert.run(
          v.id,
          v.shortcode,
          v.creatorId,
          v.caption,
          v.takenAt,
          v.durationSec,
          v.plays,
          v.likes,
          v.comments,
          v.thumbnailUrl,
          v.videoUrl,
          ts,
          ts,
          JSON.stringify(tags.hashtags),
          JSON.stringify(tags.mentions),
          v.audio?.id ?? null,
          v.audio?.title ?? null,
          v.audio?.artist ?? null,
          original === null || original === undefined ? null : original ? 1 : 0,
        );
        snapshot.run(v.id, ts, v.plays, v.likes, v.comments);
        dropFts.run(v.id);
        addFts.run(v.id, v.caption ?? "", v.creatorUsername);
      }
      return { inserted, updated: videos.length - inserted };
    });
  }

  private videoQuery = `
    SELECT v.*, c.username AS creator_username,
      EXISTS (SELECT 1 FROM transcripts t WHERE t.video_id = v.id) AS has_transcript
    FROM videos v JOIN creators c ON c.id = v.creator_id`;

  /** Looks up by media id or shortcode. */
  findVideo(idOrShortcode: string): StoredVideo | null {
    const row = this.db
      .prepare(`${this.videoQuery} WHERE v.id = ? OR v.shortcode = ?`)
      .get(idOrShortcode, idOrShortcode) as Row | undefined;
    return row ? toVideo(row) : null;
  }

  /** Newest first. */
  listVideos(opts: VideoListOptions = {}): StoredVideo[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.creatorId) {
      where.push("v.creator_id = ?");
      params.push(opts.creatorId);
    }
    if (opts.niche) {
      where.push("v.creator_id IN (SELECT creator_id FROM niche_creators WHERE niche_id = ?)");
      params.push(this.nicheId(opts.niche));
    }
    if (opts.since) {
      where.push("v.taken_at >= ?");
      params.push(opts.since);
    }
    if (opts.downloaded !== undefined) {
      where.push(opts.downloaded ? "v.local_path IS NOT NULL" : "v.local_path IS NULL");
    }
    let sql = `${this.videoQuery}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY v.taken_at IS NULL ASC, v.taken_at DESC`;
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return (this.db.prepare(sql).all(...params) as Row[]).map(toVideo);
  }

  /**
   * Full-text search over captions and usernames. The query is treated as
   * plain words (all must match), never as FTS syntax, so user input cannot
   * produce a syntax error. Best match first.
   */
  searchVideos(query: string, opts: { niche?: string; limit?: number } = {}): StoredVideo[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(" ");
    const params: (string | number)[] = [match];
    let sql = `
      SELECT v.*, c.username AS creator_username,
        EXISTS (SELECT 1 FROM transcripts t WHERE t.video_id = v.id) AS has_transcript
      FROM videos_fts f
      JOIN videos v ON v.id = f.video_id
      JOIN creators c ON c.id = v.creator_id
      WHERE videos_fts MATCH ?`;
    if (opts.niche) {
      sql += " AND v.creator_id IN (SELECT creator_id FROM niche_creators WHERE niche_id = ?)";
      params.push(this.nicheId(opts.niche));
    }
    sql += " ORDER BY f.rank LIMIT ?";
    params.push(opts.limit ?? 50);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toVideo);
  }

  markDownloaded(videoId: string, localPath: string): void {
    this.db
      .prepare("UPDATE videos SET local_path = ?, downloaded_at = ? WHERE id = ?")
      .run(localPath, now(), videoId);
  }

  /** Records what was measured from the downloaded file. Nulls leave a value untouched. */
  setVideoMedia(
    videoId: string,
    media: { durationSec?: number | null; width?: number | null; height?: number | null },
  ): void {
    this.db
      .prepare(
        `UPDATE videos SET
           duration_sec = COALESCE(?, duration_sec),
           width = COALESCE(?, width),
           height = COALESCE(?, height)
         WHERE id = ?`,
      )
      .run(media.durationSec ?? null, media.width ?? null, media.height ?? null, videoId);
  }

  /** Records the result of `ig video analyze`. */
  setVideoAnalysis(
    videoId: string,
    analysis: { cuts: number | null; cutsPerMin: number | null; framesDir: string | null },
  ): void {
    this.db
      .prepare(
        "UPDATE videos SET cuts = ?, cuts_per_min = ?, frames_dir = ?, analyzed_at = ? WHERE id = ?",
      )
      .run(analysis.cuts, analysis.cutsPerMin, analysis.framesDir, now(), videoId);
  }

  // --- transcripts ----------------------------------------------------------

  /** Stores a transcript, replacing any earlier one for the same video. */
  saveTranscript(t: Omit<Transcript, "createdAt">): Transcript {
    const createdAt = now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO transcripts (video_id, language, text, hook, segments, engine, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET
             language = excluded.language, text = excluded.text, hook = excluded.hook,
             segments = excluded.segments, engine = excluded.engine, model = excluded.model,
             created_at = excluded.created_at`,
        )
        .run(
          t.videoId,
          t.language,
          t.text,
          t.hook,
          JSON.stringify(t.segments),
          t.engine,
          t.model,
          createdAt,
        );
      this.db.prepare("DELETE FROM transcripts_fts WHERE video_id = ?").run(t.videoId);
      this.db
        .prepare("INSERT INTO transcripts_fts (video_id, text) VALUES (?, ?)")
        .run(t.videoId, t.text);
    });
    return { ...t, createdAt };
  }

  /** Looks up by media id or shortcode. */
  getTranscript(idOrShortcode: string): Transcript | null {
    const row = this.db
      .prepare(
        `SELECT t.* FROM transcripts t JOIN videos v ON v.id = t.video_id
         WHERE v.id = ? OR v.shortcode = ?`,
      )
      .get(idOrShortcode, idOrShortcode) as Row | undefined;
    if (!row) return null;
    return {
      videoId: String(row.video_id),
      language: str(row.language),
      text: String(row.text),
      hook: str(row.hook),
      segments: JSON.parse(String(row.segments)),
      engine: String(row.engine),
      model: str(row.model),
      createdAt: String(row.created_at),
    };
  }

  /**
   * Full-text search over what is said in the videos. Plain words, all must
   * match, as in `searchVideos`. `snippet` marks the matches with [brackets].
   */
  searchTranscripts(
    query: string,
    opts: { niche?: string; limit?: number } = {},
  ): { video: StoredVideo; snippet: string }[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) return [];
    const params: (string | number)[] = [terms.map((t) => `"${t}"`).join(" ")];
    let sql = `
      SELECT v.*, c.username AS creator_username, 1 AS has_transcript,
        snippet(transcripts_fts, 1, '[', ']', ' … ', 18) AS snippet
      FROM transcripts_fts f
      JOIN videos v ON v.id = f.video_id
      JOIN creators c ON c.id = v.creator_id
      WHERE transcripts_fts MATCH ?`;
    if (opts.niche) {
      sql += " AND v.creator_id IN (SELECT creator_id FROM niche_creators WHERE niche_id = ?)";
      params.push(this.nicheId(opts.niche));
    }
    sql += " ORDER BY f.rank LIMIT ?";
    params.push(opts.limit ?? 50);
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({
      video: toVideo(r),
      snippet: String(r.snippet),
    }));
  }

  // --- request budget -------------------------------------------------------

  requestsToday(backend: string): number {
    const row = this.db
      .prepare("SELECT count FROM request_log WHERE day = ? AND backend = ?")
      .get(localDay(), backend) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Counts one request against today's budget and returns the new total. */
  countRequest(backend: string): number {
    this.db
      .prepare(
        `INSERT INTO request_log (day, backend, count) VALUES (?, ?, 1)
         ON CONFLICT(day, backend) DO UPDATE SET count = count + 1`,
      )
      .run(localDay(), backend);
    return this.requestsToday(backend);
  }
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toNiche(r: Row): Niche {
  return {
    slug: String(r.slug),
    name: String(r.name),
    description: str(r.description),
    creatorCount: Number(r.creator_count),
    videoCount: Number(r.video_count),
    createdAt: String(r.created_at),
  };
}

function toCreator(r: Row): StoredCreator {
  const username = String(r.username);
  return {
    id: String(r.id),
    username,
    fullName: str(r.full_name),
    biography: str(r.biography),
    followers: num(r.followers),
    following: num(r.following),
    mediaCount: num(r.media_count),
    isVerified: Number(r.is_verified) === 1,
    isPrivate: Number(r.is_private) === 1,
    category: str(r.category),
    externalUrl: str(r.external_url),
    profilePicUrl: str(r.profile_pic_url),
    url: profileUrl(username),
    niches: r.niche_slugs ? String(r.niche_slugs).split(",").sort() : [],
    videoCount: Number(r.video_count),
    firstSeenAt: String(r.first_seen_at),
    refreshedAt: str(r.refreshed_at),
  };
}

function toVideo(r: Row): StoredVideo {
  const shortcode = String(r.shortcode);
  return {
    id: String(r.id),
    shortcode,
    url: reelUrl(shortcode),
    creatorId: String(r.creator_id),
    creatorUsername: String(r.creator_username),
    caption: str(r.caption),
    takenAt: str(r.taken_at),
    durationSec: num(r.duration_sec),
    plays: num(r.plays),
    likes: num(r.likes),
    comments: num(r.comments),
    thumbnailUrl: str(r.thumbnail_url),
    videoUrl: str(r.video_url),
    localPath: str(r.local_path),
    downloadedAt: str(r.downloaded_at),
    firstSeenAt: String(r.first_seen_at),
    refreshedAt: String(r.refreshed_at),
    audio:
      r.audio_id === null && r.audio_title === null && r.audio_artist === null
        ? null
        : {
            id: str(r.audio_id),
            title: str(r.audio_title),
            artist: str(r.audio_artist),
            isOriginal: r.audio_is_original === null ? null : Number(r.audio_is_original) === 1,
          },
    // Rows stored before these columns existed fall back to the caption.
    hashtags: r.hashtags ? JSON.parse(String(r.hashtags)) : extractTags(str(r.caption)).hashtags,
    mentions: r.mentions ? JSON.parse(String(r.mentions)) : extractTags(str(r.caption)).mentions,
    width: num(r.width),
    height: num(r.height),
    cuts: num(r.cuts),
    cutsPerMin: num(r.cuts_per_min),
    framesDir: str(r.frames_dir),
    analyzedAt: str(r.analyzed_at),
    hasTranscript: Number(r.has_transcript ?? 0) === 1,
  };
}
