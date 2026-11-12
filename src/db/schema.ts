// Migrations are append-only: never edit a shipped entry, add a new one.

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE niches (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE creators (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT,
    biography TEXT,
    followers INTEGER,
    following INTEGER,
    media_count INTEGER,
    is_verified INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    external_url TEXT,
    profile_pic_url TEXT,
    first_seen_at TEXT NOT NULL,
    refreshed_at TEXT
  );

  CREATE TABLE niche_creators (
    niche_id INTEGER NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (niche_id, creator_id)
  );

  CREATE TABLE creator_snapshots (
    id INTEGER PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    taken_at TEXT NOT NULL,
    followers INTEGER,
    following INTEGER,
    media_count INTEGER
  );
  CREATE INDEX creator_snapshots_by_creator ON creator_snapshots(creator_id, taken_at);

  CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    shortcode TEXT NOT NULL UNIQUE,
    creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    caption TEXT,
    taken_at TEXT,
    duration_sec REAL,
    plays INTEGER,
    likes INTEGER,
    comments INTEGER,
    thumbnail_url TEXT,
    video_url TEXT,
    local_path TEXT,
    downloaded_at TEXT,
    first_seen_at TEXT NOT NULL,
    refreshed_at TEXT NOT NULL
  );
  CREATE INDEX videos_by_creator ON videos(creator_id, taken_at);

  CREATE TABLE video_snapshots (
    id INTEGER PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    taken_at TEXT NOT NULL,
    plays INTEGER,
    likes INTEGER,
    comments INTEGER
  );
  CREATE INDEX video_snapshots_by_video ON video_snapshots(video_id, taken_at);

  CREATE VIRTUAL TABLE videos_fts USING fts5(
    video_id UNINDEXED,
    caption,
    username,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE request_log (
    day TEXT NOT NULL,
    backend TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, backend)
  );
  `,
  `
  ALTER TABLE videos ADD COLUMN hashtags TEXT;
  ALTER TABLE videos ADD COLUMN mentions TEXT;
  ALTER TABLE videos ADD COLUMN audio_id TEXT;
  ALTER TABLE videos ADD COLUMN audio_title TEXT;
  ALTER TABLE videos ADD COLUMN audio_artist TEXT;
  ALTER TABLE videos ADD COLUMN audio_is_original INTEGER;
  ALTER TABLE videos ADD COLUMN width INTEGER;
  ALTER TABLE videos ADD COLUMN height INTEGER;
  ALTER TABLE videos ADD COLUMN cuts INTEGER;
  ALTER TABLE videos ADD COLUMN cuts_per_min REAL;
  ALTER TABLE videos ADD COLUMN frames_dir TEXT;
  ALTER TABLE videos ADD COLUMN analyzed_at TEXT;

  CREATE TABLE transcripts (
    video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    language TEXT,
    text TEXT NOT NULL,
    hook TEXT,
    segments TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE transcripts_fts USING fts5(
    video_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];
