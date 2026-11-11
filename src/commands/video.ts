import { z } from "zod";
import { RankedVideoSchema, SortKey, StoredVideoSchema, VideoSchema } from "../core/types.js";
import { defineCommand, flags, notImplemented } from "../lib/command.js";

const list = defineCommand({
  id: "video.list",
  summary: "List a tracked creator's stored reels, newest first",
  input: z.object({
    creator: z.string().describe("Username, @handle or profile URL"),
    limit: flags.limit(20),
    refresh: z.boolean().default(false).describe("Fetch the latest reels first"),
    backend: flags.backend,
    force: flags.force.describe("Refresh even if refreshed recently"),
  }),
  output: z.array(StoredVideoSchema),
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<creator>")
      .option("--limit <n>", "maximum results (default 20)")
      .option("--refresh", "fetch the latest reels first")
      .option("--backend <name>", "browser | hiker")
      .option("--force", "refresh even if refreshed recently"),
  args: ([creator]) => ({ creator }),
  handler: async () => notImplemented("video.list"),
});

const top = defineCommand({
  id: "video.top",
  summary: "Rank stored videos: what performed best",
  description:
    "Reads the local database only. The default order, `outlier`, is plays divided\n" +
    "by that creator's median plays: what did unusually well for them, regardless\n" +
    "of account size. Run `ig niche refresh` first for current numbers.",
  input: z.object({
    niche: flags.niche,
    creator: z.string().optional().describe("Only this creator"),
    sort: SortKey.default("outlier"),
    limit: flags.limit(20),
    since: z.string().optional().describe("Only videos newer than this: 30d, 12h, 2w or a date"),
    minPlays: z.coerce.number().int().min(0).optional(),
    perCreator: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("At most this many videos per creator"),
  }),
  output: z.array(RankedVideoSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .option("--niche <slug>", "only this niche")
      .option("--creator <username>", "only this creator")
      .option("--sort <key>", "outlier | plays | engagement | likes | comments | recent")
      .option("--limit <n>", "maximum results (default 20)")
      .option("--since <when>", "only videos newer than 30d, 12h, 2w or a date")
      .option("--min-plays <n>", "drop videos below this")
      .option("--per-creator <n>", "at most this many videos per creator"),
  handler: async () => notImplemented("video.top"),
});

const search = defineCommand({
  id: "video.search",
  summary: "Full-text search over stored captions",
  description:
    "Searches the local database, not Instagram. All words must match; accents\n" +
    "are ignored. To find new reels on Instagram use `ig video discover`.",
  input: z.object({
    query: z.string().min(1),
    niche: flags.niche,
    limit: flags.limit(20),
  }),
  output: z.array(StoredVideoSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<query>")
      .option("--niche <slug>", "only this niche")
      .option("--limit <n>", "maximum results (default 20)"),
  args: ([query]) => ({ query }),
  handler: async () => notImplemented("video.search"),
});

const discover = defineCommand({
  id: "video.discover",
  summary: "Find reels on Instagram by keyword or hashtag",
  description:
    "Lists reels only; nothing is stored. Add an interesting author with\n" +
    "`ig creator add`, or fetch one reel with `ig video download <url>`.",
  input: z.object({
    query: z.string().min(1),
    hashtag: z.boolean().default(false).describe("Treat the query as a hashtag"),
    limit: flags.limit(30, 200),
    backend: flags.backend,
  }),
  output: z.array(
    VideoSchema.extend({
      creatorTracked: z.boolean().describe("The author is already tracked locally"),
    }),
  ),
  network: true,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<query>", "keyword, or a hashtag with --hashtag")
      .option("--hashtag", "treat the query as a hashtag")
      .option("--limit <n>", "maximum results (default 30)")
      .option("--backend <name>", "browser | hiker"),
  args: ([query]) => ({ query }),
  handler: async () => notImplemented("video.discover"),
});

export const DownloadItemSchema = z.object({
  id: z.string().nullable(),
  shortcode: z.string(),
  creatorUsername: z.string().nullable(),
  status: z.enum(["downloaded", "skipped", "failed", "would-download"]),
  reason: z.string().nullable().describe("Why it was skipped or failed"),
  path: z.string().nullable().describe("Absolute path of the file"),
  bytes: z.number().int().nullable(),
});

const download = defineCommand({
  id: "video.download",
  summary: "Download videos as mp4",
  description:
    "Give ids, shortcodes or URLs, or select from the database with --top.\n" +
    "Files go to <mediaDir>/<username>/<shortcode>.mp4. A video already on disk\n" +
    "is skipped unless --force. Video URLs expire, so a stale one is re-fetched\n" +
    "from the backend (one request).",
  input: z.object({
    targets: z.array(z.string()).default([]).describe("Video ids, shortcodes or reel URLs"),
    top: z.coerce.number().int().min(1).max(500).optional().describe("Download the top N instead"),
    niche: flags.niche.describe("With --top: only this niche"),
    creator: z.string().optional().describe("With --top: only this creator"),
    sort: SortKey.default("outlier").describe("With --top: ranking"),
    since: z.string().optional().describe("With --top: only videos newer than this"),
    perCreator: z.coerce.number().int().min(1).optional().describe("With --top: cap per creator"),
    out: z.string().optional().describe("Directory to write to. Defaults to mediaDir"),
    backend: flags.backend,
    force: flags.force.describe("Download again even if the file exists"),
    dryRun: flags.dryRun,
  }),
  output: z.object({
    downloaded: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    bytes: z.number().int(),
    dir: z.string(),
    items: z.array(DownloadItemSchema),
  }),
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("[targets...]", "video ids, shortcodes or reel URLs")
      .option("--top <n>", "download the top N stored videos instead")
      .option("--niche <slug>", "with --top: only this niche")
      .option("--creator <username>", "with --top: only this creator")
      .option(
        "--sort <key>",
        "with --top: outlier | plays | engagement | likes | comments | recent",
      )
      .option("--since <when>", "with --top: only videos newer than 30d, 12h, 2w or a date")
      .option("--per-creator <n>", "with --top: at most this many per creator")
      .option("--out <dir>", "directory to write to")
      .option("--backend <name>", "browser | hiker")
      .option("--force", "download again even if the file exists")
      .option("--dry-run", "list what would be downloaded"),
  args: ([targets]) => ({ targets }),
  handler: async () => notImplemented("video.download"),
});

export const videoCommands = [list, top, search, discover, download];
