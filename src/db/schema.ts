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
];
