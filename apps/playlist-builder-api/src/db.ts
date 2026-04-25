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
`);

export type SpotifyAuthRow = {
  id: 1;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
  spotify_user_id: string | null;
  updated_at: string;
};

export function getAuth(): SpotifyAuthRow | undefined {
  return db.prepare("SELECT * FROM spotify_auth WHERE id = 1").get() as SpotifyAuthRow | undefined;
}

export function saveAuth(row: Omit<SpotifyAuthRow, "id" | "updated_at">) {
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
