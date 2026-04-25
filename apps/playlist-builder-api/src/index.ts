import "dotenv/config";
import express from "express";
import {
  db,
  getAuth,
  saveAuth,
  setHeavyRotationPlaylistId,
  setSpotifyUserId,
  type LikedSongRow,
  type Rating,
  type TrackRatingRow,
} from "./db.js";
import { getValidAccessToken } from "./spotify.js";
import {
  addTracksToPlaylist,
  createPlaylist,
  getAllPlaylistTrackUris,
  getMe,
  getSavedTracksPage,
  removeTracksFromPlaylist,
} from "./spotify-client.js";

function parsePlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1]!;
  if (/^[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
  return null;
}

const PORT = Number(process.env.PORT ?? 3002);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "playlist-builder-api",
    time: new Date().toISOString(),
    authenticated: !!getAuth(),
  });
});

app.post("/api/auth/save", (req, res) => {
  const { access_token, refresh_token, expires_in, scope, spotify_user_id } = req.body ?? {};
  if (!access_token || !refresh_token || typeof expires_in !== "number") {
    return res.status(400).json({ error: "missing_fields" });
  }

  const expiresAt = new Date(Date.now() + (expires_in - 30) * 1000).toISOString();
  saveAuth({
    access_token,
    refresh_token,
    expires_at: expiresAt,
    scope: scope ?? null,
    spotify_user_id: spotify_user_id ?? null,
  });

  res.json({ ok: true });
});

app.get("/api/auth/access-token", async (_req, res) => {
  try {
    const token = await getValidAccessToken();
    res.json({ access_token: token });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    res.status(401).json({ error: msg });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  db.prepare("DELETE FROM spotify_auth").run();
  res.json({ ok: true });
});

const insertEvent = db.prepare(`
  INSERT INTO playback_events
    (ts, event_type, track_uri, track_name, artists, album, position_ms, duration_ms, paused, context_uri, raw_state)
  VALUES
    (@ts, @event_type, @track_uri, @track_name, @artists, @album, @position_ms, @duration_ms, @paused, @context_uri, @raw_state)
`);

app.post("/api/events", (req, res) => {
  const e = req.body ?? {};
  if (typeof e.event_type !== "string") {
    return res.status(400).json({ error: "missing_event_type" });
  }

  insertEvent.run({
    ts: e.ts ?? new Date().toISOString(),
    event_type: e.event_type,
    track_uri: e.track_uri ?? null,
    track_name: e.track_name ?? null,
    artists: e.artists ? JSON.stringify(e.artists) : null,
    album: e.album ?? null,
    position_ms: e.position_ms ?? null,
    duration_ms: e.duration_ms ?? null,
    paused: typeof e.paused === "boolean" ? (e.paused ? 1 : 0) : null,
    context_uri: e.context_uri ?? null,
    raw_state: e.raw_state ? JSON.stringify(e.raw_state) : null,
  });

  res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const rows = db
    .prepare("SELECT * FROM playback_events ORDER BY id DESC LIMIT ?")
    .all(limit);
  res.json({ events: rows });
});

const upsertLikedSong = db.prepare(`
  INSERT INTO liked_songs
    (track_uri, track_name, artists, album, album_image_url, duration_ms, spotify_added_at, last_synced_at)
  VALUES
    (@track_uri, @track_name, @artists, @album, @album_image_url, @duration_ms, @spotify_added_at, @last_synced_at)
  ON CONFLICT(track_uri) DO UPDATE SET
    track_name = excluded.track_name,
    artists = excluded.artists,
    album = excluded.album,
    album_image_url = excluded.album_image_url,
    duration_ms = excluded.duration_ms,
    spotify_added_at = excluded.spotify_added_at,
    last_synced_at = excluded.last_synced_at
`);

app.post("/api/liked-songs/sync", async (_req, res) => {
  try {
    let offset = 0;
    let total = 0;
    let synced = 0;
    const now = new Date().toISOString();

    while (true) {
      const page = await getSavedTracksPage(offset);
      total = page.total;
      const rows: LikedSongRow[] = page.items.map((item) => ({
        track_uri: item.track.uri,
        track_name: item.track.name,
        artists: JSON.stringify(item.track.artists.map((a) => a.name)),
        album: item.track.album?.name ?? null,
        album_image_url: item.track.album?.images?.[0]?.url ?? null,
        duration_ms: item.track.duration_ms,
        spotify_added_at: item.added_at,
        last_synced_at: now,
      }));
      const tx = db.transaction((items: LikedSongRow[]) => {
        for (const r of items) upsertLikedSong.run(r);
      });
      tx(rows);
      synced += rows.length;
      if (!page.next) break;
      offset += page.items.length;
    }

    res.json({ ok: true, synced, total });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    res.status(500).json({ error: msg });
  }
});

app.get("/api/triage/stats", (_req, res) => {
  const total = (db.prepare("SELECT COUNT(*) as c FROM liked_songs").get() as { c: number }).c;
  const counts = db
    .prepare(
      "SELECT rating, COUNT(*) as c FROM track_ratings WHERE rating IN ('heavy_rotation','reject','defer') GROUP BY rating"
    )
    .all() as Array<{ rating: Rating; c: number }>;
  const byRating: Record<Rating, number> = { heavy_rotation: 0, reject: 0, defer: 0 };
  for (const r of counts) byRating[r.rating] = r.c;
  const rated = byRating.heavy_rotation + byRating.reject;
  const unrated = Math.max(0, total - rated - byRating.defer);
  res.json({ total, unrated, ...byRating });
});

app.get("/api/triage/next", (_req, res) => {
  // Priority: never-rated songs first (most recently added first), then deferred (oldest defer first).
  const unrated = db
    .prepare(
      `SELECT l.* FROM liked_songs l
       LEFT JOIN track_ratings r ON r.track_uri = l.track_uri
       WHERE r.track_uri IS NULL
       ORDER BY l.spotify_added_at DESC
       LIMIT 1`
    )
    .get() as LikedSongRow | undefined;
  if (unrated) {
    return res.json({ song: unrated, source: "unrated" });
  }
  const deferred = db
    .prepare(
      `SELECT l.* FROM liked_songs l
       JOIN track_ratings r ON r.track_uri = l.track_uri
       WHERE r.rating = 'defer'
       ORDER BY r.rated_at ASC
       LIMIT 1`
    )
    .get() as LikedSongRow | undefined;
  if (deferred) {
    return res.json({ song: deferred, source: "deferred" });
  }
  res.json({ song: null });
});

const upsertRating = db.prepare(`
  INSERT INTO track_ratings (track_uri, rating, rated_at, defer_count)
  VALUES (@track_uri, @rating, @rated_at, @defer_count)
  ON CONFLICT(track_uri) DO UPDATE SET
    rating = excluded.rating,
    rated_at = excluded.rated_at,
    defer_count = track_ratings.defer_count + (CASE WHEN excluded.rating = 'defer' THEN 1 ELSE 0 END)
`);

async function ensureHeavyRotationPlaylist(): Promise<string> {
  const auth = getAuth();
  if (!auth) throw new Error("not_authenticated");
  if (auth.heavy_rotation_playlist_id) return auth.heavy_rotation_playlist_id;

  let userId = auth.spotify_user_id;
  if (!userId) {
    const me = await getMe();
    userId = me.id;
    setSpotifyUserId(userId);
  }
  const playlistId = await createPlaylist(
    userId,
    "noahbot — Heavy Rotation",
    "Auto-curated by noahbot from triaged Liked Songs."
  );
  setHeavyRotationPlaylistId(playlistId);
  return playlistId;
}

app.post("/api/triage/adopt-playlist", async (req, res) => {
  const { playlist } = (req.body ?? {}) as { playlist?: string };
  const playlistId = playlist ? parsePlaylistId(playlist) : null;
  if (!playlistId) {
    return res.status(400).json({ error: "invalid_playlist" });
  }

  try {
    const uris = await getAllPlaylistTrackUris(playlistId);
    const now = new Date().toISOString();
    const tx = db.transaction((trackUris: string[]) => {
      for (const uri of trackUris) {
        upsertRating.run({
          track_uri: uri,
          rating: "heavy_rotation",
          rated_at: now,
          defer_count: 0,
        });
      }
    });
    tx(uris);
    setHeavyRotationPlaylistId(playlistId);
    res.json({ ok: true, adopted: uris.length, playlist_id: playlistId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    res.status(500).json({ error: msg });
  }
});

app.post("/api/triage/rate", async (req, res) => {
  const { track_uri, rating } = (req.body ?? {}) as { track_uri?: string; rating?: Rating };
  if (!track_uri || !rating || !["heavy_rotation", "reject", "defer"].includes(rating)) {
    return res.status(400).json({ error: "invalid_rating" });
  }

  const prior = db.prepare("SELECT * FROM track_ratings WHERE track_uri = ?").get(track_uri) as
    | TrackRatingRow
    | undefined;

  upsertRating.run({
    track_uri,
    rating,
    rated_at: new Date().toISOString(),
    defer_count: rating === "defer" ? 1 : 0,
  });

  try {
    if (rating === "heavy_rotation" && prior?.rating !== "heavy_rotation") {
      const playlistId = await ensureHeavyRotationPlaylist();
      await addTracksToPlaylist(playlistId, [track_uri]);
    }
    if (rating !== "heavy_rotation" && prior?.rating === "heavy_rotation") {
      const auth = getAuth();
      if (auth?.heavy_rotation_playlist_id) {
        await removeTracksFromPlaylist(auth.heavy_rotation_playlist_id, [track_uri]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    res.status(500).json({ error: `rating_saved_but_playlist_sync_failed: ${msg}` });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`playlist-builder-api listening on http://${HOST}:${PORT}`);
});
