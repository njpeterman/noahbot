import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/playlist-builder.sqlite";

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS spotify_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    scope TEXT,
    spotify_user_id TEXT,
    heavy_rotation_playlist_id TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_type TEXT NOT NULL,
    track_uri TEXT,
    track_name TEXT,
    artists TEXT,
    album TEXT,
    position_ms INTEGER,
    duration_ms INTEGER,
    paused INTEGER,
    context_uri TEXT,
    raw_state TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts ON playback_events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_track ON playback_events(track_uri);

  CREATE TABLE IF NOT EXISTS liked_songs (
    track_uri TEXT PRIMARY KEY,
    track_name TEXT NOT NULL,
    artists TEXT NOT NULL,
    album TEXT,
    album_image_url TEXT,
    duration_ms INTEGER,
    spotify_added_at TEXT NOT NULL,
    last_synced_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_liked_added ON liked_songs(spotify_added_at);

  CREATE TABLE IF NOT EXISTS track_ratings (
    track_uri TEXT PRIMARY KEY,
    rating TEXT NOT NULL CHECK (rating IN ('heavy_rotation', 'reject', 'defer')),
    rated_at TEXT NOT NULL,
    defer_count INTEGER NOT NULL DEFAULT 0
  );
`);

// Migration: add heavy_rotation_playlist_id column to existing dbs
const cols = db.prepare("PRAGMA table_info(spotify_auth)").all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === "heavy_rotation_playlist_id")) {
  db.exec("ALTER TABLE spotify_auth ADD COLUMN heavy_rotation_playlist_id TEXT");
}

export type SpotifyAuthRow = {
  id: 1;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
  spotify_user_id: string | null;
  heavy_rotation_playlist_id: string | null;
  updated_at: string;
};

export type LikedSongRow = {
  track_uri: string;
  track_name: string;
  artists: string;
  album: string | null;
  album_image_url: string | null;
  duration_ms: number | null;
  spotify_added_at: string;
  last_synced_at: string;
};

export type Rating = "heavy_rotation" | "reject" | "defer";

export type TrackRatingRow = {
  track_uri: string;
  rating: Rating;
  rated_at: string;
  defer_count: number;
};

export function getAuth(): SpotifyAuthRow | undefined {
  return db.prepare("SELECT * FROM spotify_auth WHERE id = 1").get() as SpotifyAuthRow | undefined;
}

export function saveAuth(row: Omit<SpotifyAuthRow, "id" | "updated_at" | "heavy_rotation_playlist_id">) {
  db.prepare(`
    INSERT INTO spotify_auth (id, access_token, refresh_token, expires_at, scope, spotify_user_id, updated_at)
    VALUES (1, @access_token, @refresh_token, @expires_at, @scope, @spotify_user_id, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      scope = COALESCE(excluded.scope, spotify_auth.scope),
      spotify_user_id = COALESCE(excluded.spotify_user_id, spotify_auth.spotify_user_id),
      updated_at = excluded.updated_at
  `).run({ ...row, updated_at: new Date().toISOString() });
}

export function setSpotifyUserId(userId: string) {
  db.prepare("UPDATE spotify_auth SET spotify_user_id = ? WHERE id = 1").run(userId);
}

export function setHeavyRotationPlaylistId(playlistId: string) {
  db.prepare("UPDATE spotify_auth SET heavy_rotation_playlist_id = ? WHERE id = 1").run(playlistId);
}
