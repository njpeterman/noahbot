import "dotenv/config";
import express from "express";
import { db, getAuth, saveAuth } from "./db.js";
import { getValidAccessToken } from "./spotify.js";

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

app.listen(PORT, HOST, () => {
  console.log(`playlist-builder-api listening on http://${HOST}:${PORT}`);
});
