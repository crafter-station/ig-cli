// Downloading reels to disk. The command stays thin; everything that touches
// the network, the filesystem or a child process is here, behind injectable
// seams so tests need no network, no waiting and no yt-dlp binary.
//
// Rules:
//   1. A file already on disk costs zero requests.
//   2. The stored CDN URL is tried first. Only a missing or expired URL spends
//      one budgeted backend request for a fresh one. The CDN fetch itself is
//      not a backend request and does not pass through the gate.
//   3. Bytes land in a temp file beside the destination and are renamed on
//      success, so a killed download never leaves a truncated .mp4.
//   4. A block or auth error ends the batch at once. Anything else fails one
//      item and the batch goes on.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Backend } from "../backends/types.js";
import { hasCommand } from "../cligentic/platform/detect.js";
import type { Store } from "../db/store.js";
import { EXIT, IgError } from "../lib/errors.js";
import { bytes as formatBytes } from "../lib/format.js";
import { oneLine } from "../lib/output.js";
import { parseShortcode, reelUrl, type StoredVideo } from "./types.js";

export type DownloadItem = {
  id: string | null;
  shortcode: string;
  creatorUsername: string | null;
  status: "downloaded" | "skipped" | "failed" | "would-download";
  reason: string | null;
  path: string | null;
  bytes: number | null;
};

export type DownloadSummary = {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
  dir: string;
  items: DownloadItem[];
};

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type DownloadDeps = {
  /** Fetches the CDN URL. */
  fetch: FetchLike;
  /** Waits between two files that touched the network. */
  pause: () => Promise<void>;
  /** Whether the yt-dlp fallback can be used at all. */
  hasYtDlp: () => boolean;
  /** Downloads `url` to `dest` with yt-dlp. Rejects on failure. */
  ytDlp: (url: string, dest: string) => Promise<void>;
};

export type DownloadEnv = {
  store: Store;
  /** Progress lines. Goes to stderr; silent in machine mode. */
  log: (message: string) => void;
  /** Resolved lazily: a batch that only skips never creates a backend. */
  backend: () => Promise<Backend>;
};

export type DownloadRequest = {
  /** Stored videos (from a ranking) or raw targets: media id, shortcode or reel URL. */
  targets: (StoredVideo | string)[];
  /** Root directory; files go to <dir>/<username>/<shortcode>.mp4. */
  dir: string;
  force: boolean;
  dryRun: boolean;
};

/** CDN statuses that mean "this signed URL is dead", not "the video is gone". */
const EXPIRED_STATUS = new Set([403, 404, 410]);
/** Without a video content-type, anything smaller than this is an error page. */
const MIN_UNTYPED_BYTES = 1024;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const YTDLP_TIMEOUT_MS = 10 * 60_000;

const realPause = (): Promise<void> =>
  new Promise((done) => setTimeout(done, 700 + Math.floor(Math.random() * 1100)));

/**
 * Runs yt-dlp with an argument array, never a shell string, so nothing in a
 * URL or path is interpreted. No cookies and no user config: the fallback must
 * not borrow a logged-in browser session behind the gate's back.
 */
export function runYtDlp(url: string, dest: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(
      "yt-dlp",
      [
        "--ignore-config",
        "--no-cookies",
        "--no-cookies-from-browser",
        "--no-playlist",
        "--no-progress",
        "--no-part",
        "--quiet",
        "-f",
        "b[ext=mp4]/b",
        "-o",
        dest,
        "--",
        url,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        timeout: YTDLP_TIMEOUT_MS,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) return done();
      const last = stderr.trim().split(/\r?\n/).pop();
      fail(new Error(last || `exited with code ${code}`));
    });
  });
}

const defaults: DownloadDeps = {
  fetch: (url, init) => fetch(url, init),
  pause: realPause,
  hasYtDlp: () => hasCommand("yt-dlp"),
  ytDlp: runYtDlp,
};

/** Usernames and shortcodes come from upstream; never let one steer the path. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.*$/.test(cleaned) ? "_" : cleaned;
}

export function destinationFor(dir: string, video: { creatorUsername: string; shortcode: string }) {
  return join(
    resolve(dir),
    safeSegment(video.creatorUsername),
    `${safeSegment(video.shortcode)}.mp4`,
  );
}

function tempPath(dest: string, suffix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return join(dirname(dest), `.${basename(dest, ".mp4")}.${rand}${suffix}`);
}

const message = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err));

/** Block and auth errors end the batch; retrying them makes things worse. */
function stopsBatch(err: unknown): err is IgError {
  return err instanceof IgError && (err.exitCode === EXIT.BLOCKED || err.exitCode === EXIT.AUTH);
}

type Attempt = { ok: true; bytes: number } | { ok: false; reason: string; expired: boolean };

const miss = (reason: string, expired = false): Attempt => ({ ok: false, reason, expired });

/** Streams one URL to `dest` through a temp file. Never leaves a partial file. */
async function fetchToFile(url: string, dest: string, deps: DownloadDeps): Promise<Attempt> {
  if (!/^https?:\/\//i.test(url)) return miss("the stored video URL is not an http(s) URL", true);
  const tmp = tempPath(dest, ".part");
  try {
    let res: Response;
    try {
      res = await deps.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      return miss(`network error: ${message(err)}`);
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return miss(`the CDN answered HTTP ${res.status}`, EXPIRED_STATUS.has(res.status));
    }
    if (!res.body || /^(text\/|application\/(json|xml|xhtml))/.test(type)) {
      await res.body?.cancel().catch(() => {});
      return miss(`the CDN returned ${type || "an empty body"}, not a video`);
    }
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(tmp));
    const size = statSync(tmp).size;
    if (size === 0 || (!type.startsWith("video/") && size < MIN_UNTYPED_BYTES)) {
      return miss(`the response is not a video (${size} bytes, ${type || "no content-type"})`);
    }
    renameSync(tmp, dest);
    return { ok: true, bytes: size };
  } catch (err) {
    return miss(`download interrupted: ${message(err)}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function ytDlpToFile(shortcode: string, dest: string, deps: DownloadDeps): Promise<number> {
  // Keeps the .mp4 extension so yt-dlp does not append one of its own.
  const tmp = tempPath(dest, ".ytdlp.mp4");
  try {
    await deps.ytDlp(reelUrl(shortcode), tmp);
    const size = existsSync(tmp) ? statSync(tmp).size : 0;
    if (size === 0) throw new Error("it produced no file");
    renameSync(tmp, dest);
    return size;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function downloadVideos(
  env: DownloadEnv,
  request: DownloadRequest,
  overrides: Partial<DownloadDeps> = {},
): Promise<DownloadSummary> {
  const deps: DownloadDeps = { ...defaults, ...overrides };
  const dir = resolve(request.dir);
  const summary: DownloadSummary = {
    downloaded: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    dir,
    items: [],
  };
  const total = request.targets.length;
  let networkUsed = false;

  /** One short pause before each file that touches the network, except the first. */
  const breathe = async (item: { paused: boolean }): Promise<void> => {
    if (item.paused) return;
    item.paused = true;
    if (networkUsed) await deps.pause();
    networkUsed = true;
  };

  /** Bytes on success, or the reasons every route failed. Throws only to stop the batch. */
  const fetchVideo = async (
    video: StoredVideo,
    dest: string,
    alreadyFresh: boolean,
  ): Promise<{ bytes: number } | { reason: string }> => {
    const reasons: string[] = [];
    let url = video.videoUrl;
    let refetched = alreadyFresh;
    for (;;) {
      if (url) {
        const attempt = await fetchToFile(url, dest, deps);
        if (attempt.ok) return { bytes: attempt.bytes };
        reasons.push(attempt.reason);
        if (!attempt.expired || refetched) break;
      } else if (refetched) {
        reasons.push("the backend returned no video URL");
        break;
      }
      // One budgeted request for a fresh signed URL. Never more than one.
      refetched = true;
      try {
        const fresh = await (await env.backend()).getVideo(video.shortcode);
        env.store.upsertVideos([fresh]);
        url = fresh.videoUrl;
      } catch (err) {
        if (stopsBatch(err)) throw err;
        reasons.push(`could not get a fresh URL: ${message(err)}`);
        break;
      }
    }
    if (!deps.hasYtDlp()) {
      reasons.push("yt-dlp is not installed for a fallback");
      return { reason: reasons.join("; ") };
    }
    try {
      return { bytes: await ytDlpToFile(video.shortcode, dest, deps) };
    } catch (err) {
      reasons.push(`yt-dlp failed: ${message(err)}`);
      return { reason: reasons.join("; ") };
    }
  };

  const one = async (target: StoredVideo | string): Promise<DownloadItem> => {
    const state = { paused: false };
    let video: StoredVideo | null;
    let fresh = false;

    if (typeof target === "string") {
      const shortcode = parseShortcode(target);
      video =
        env.store.findVideo(target.trim()) ?? (shortcode ? env.store.findVideo(shortcode) : null);
      if (!video) {
        const unknown = {
          id: null,
          shortcode: shortcode ?? oneLine(target),
          creatorUsername: null,
        };
        if (!shortcode) {
          return {
            ...unknown,
            status: "failed",
            reason: "not a stored video id, and not a shortcode or reel URL",
            path: null,
            bytes: null,
          };
        }
        if (request.dryRun) {
          return {
            ...unknown,
            status: "would-download",
            reason: "not stored yet: it would be fetched first (one request)",
            path: null,
            bytes: null,
          };
        }
        await breathe(state);
        try {
          const fetched = await (await env.backend()).getVideo(shortcode);
          // Only id and username are known. An existing row is left alone:
          // a partial upsert would reset its verified/private flags.
          if (!env.store.findCreator(fetched.creatorId)) {
            env.store.upsertCreator(
              {
                id: fetched.creatorId,
                username: fetched.creatorUsername,
                fullName: null,
                biography: null,
                followers: null,
                following: null,
                mediaCount: null,
                isVerified: false,
                isPrivate: false,
                category: null,
                externalUrl: null,
                profilePicUrl: null,
                url: "",
              },
              { refreshed: false },
            );
          }
          env.store.upsertVideos([fetched]);
          video = env.store.findVideo(fetched.id);
          if (!video) throw new Error("the fetched video could not be stored");
          fresh = true;
        } catch (err) {
          if (stopsBatch(err)) throw err;
          return { ...unknown, status: "failed", reason: message(err), path: null, bytes: null };
        }
      }
    } else {
      video = target;
    }

    const base = {
      id: video.id,
      shortcode: video.shortcode,
      creatorUsername: video.creatorUsername,
    };
    const dest = destinationFor(dir, video);

    if (!request.force) {
      const present =
        video.localPath && existsSync(video.localPath)
          ? video.localPath
          : existsSync(dest)
            ? dest
            : null;
      if (present) {
        // A file found at the destination but unknown to the store is recorded,
        // so `localPath` tells the truth afterwards. Still zero requests.
        if (!request.dryRun && video.localPath !== present) {
          env.store.markDownloaded(video.id, present);
        }
        return {
          ...base,
          status: "skipped",
          reason: "already on disk; use --force to download again",
          path: present,
          bytes: statSync(present).size,
        };
      }
    }

    if (request.dryRun) {
      return { ...base, status: "would-download", reason: null, path: dest, bytes: null };
    }

    await breathe(state);
    try {
      mkdirSync(dirname(dest), { recursive: true });
    } catch (err) {
      return { ...base, status: "failed", reason: message(err), path: null, bytes: null };
    }
    const result = await fetchVideo(video, dest, fresh);
    if ("reason" in result) {
      return { ...base, status: "failed", reason: result.reason, path: null, bytes: null };
    }
    env.store.markDownloaded(video.id, dest);
    return { ...base, status: "downloaded", reason: null, path: dest, bytes: result.bytes };
  };

  for (const [index, target] of request.targets.entries()) {
    let item: DownloadItem;
    try {
      item = await one(target);
    } catch (err) {
      if (!stopsBatch(err)) throw err;
      throw new IgError(err.code, err.message, {
        hint: err.hint,
        details: {
          ...err.details,
          progress: summary,
          remaining: total - summary.items.length,
        },
        cause: err,
      });
    }
    summary.items.push(item);
    if (item.status === "downloaded") {
      summary.downloaded++;
      summary.bytes += item.bytes ?? 0;
    } else if (item.status === "skipped") summary.skipped++;
    else if (item.status === "failed") summary.failed++;

    const who = `${item.creatorUsername ?? "?"}/${item.shortcode}`;
    const outcome =
      item.status === "downloaded"
        ? formatBytes(item.bytes ?? 0)
        : item.reason
          ? `${item.status}: ${item.reason}`
          : item.status;
    env.log(`${index + 1}/${total} ${who} ${outcome}`);
  }
  return summary;
}
