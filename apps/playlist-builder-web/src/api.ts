import { fetchAccessToken } from "./auth";

export type Track = {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
  duration_ms: number;
};

export async function searchTracks(query: string): Promise<Track[]> {
  if (!query.trim()) return [];
  const token = await fetchAccessToken();
  const params = new URLSearchParams({ q: query, type: "track", limit: "20" });
  const r = await fetch(`https://api.spotify.com/v1/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`spotify_search_failed: ${r.status}`);
  const data = (await r.json()) as { tracks: { items: Track[] } };
  return data.tracks.items;
}

export async function playTrack(deviceId: string, trackUri: string): Promise<void> {
  const token = await fetchAccessToken();
  const r = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uris: [trackUri] }),
  });
  if (!r.ok && r.status !== 204) {
    const text = await r.text();
    throw new Error(`play_failed: ${r.status} ${text}`);
  }
}

export type PlaybackEvent = {
  ts?: string;
  event_type: string;
  track_uri?: string | null;
  track_name?: string | null;
  artists?: string[] | null;
  album?: string | null;
  position_ms?: number | null;
  duration_ms?: number | null;
  paused?: boolean | null;
  context_uri?: string | null;
  raw_state?: unknown;
};

export async function logEvent(event: PlaybackEvent): Promise<void> {
  await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

export type StoredEvent = PlaybackEvent & { id: number; ts: string };

export async function fetchEvents(limit = 50): Promise<StoredEvent[]> {
  const r = await fetch(`/api/events?limit=${limit}`);
  if (!r.ok) throw new Error("events_fetch_failed");
  const data = (await r.json()) as { events: StoredEvent[] };
  return data.events;
}

export type Rating = "heavy_rotation" | "reject" | "defer";

export type LikedSong = {
  track_uri: string;
  track_name: string;
  artists: string;
  album: string | null;
  album_image_url: string | null;
  duration_ms: number | null;
  spotify_added_at: string;
};

export type TriageStats = {
  total: number;
  unrated: number;
  heavy_rotation: number;
  reject: number;
  defer: number;
};

export async function syncLikedSongs(): Promise<{ synced: number; total: number }> {
  const r = await fetch("/api/liked-songs/sync", { method: "POST" });
  if (!r.ok) throw new Error(`sync_failed: ${r.status}`);
  return (await r.json()) as { synced: number; total: number };
}

export async function fetchTriageStats(): Promise<TriageStats> {
  const r = await fetch("/api/triage/stats");
  if (!r.ok) throw new Error("stats_failed");
  return (await r.json()) as TriageStats;
}

export async function fetchNextTriage(): Promise<{ song: LikedSong | null; source?: "unrated" | "deferred" }> {
  const r = await fetch("/api/triage/next");
  if (!r.ok) throw new Error("triage_next_failed");
  return (await r.json()) as { song: LikedSong | null; source?: "unrated" | "deferred" };
}

export async function rateTrack(track_uri: string, rating: Rating): Promise<void> {
  const r = await fetch("/api/triage/rate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ track_uri, rating }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`rate_failed: ${r.status} ${text}`);
  }
}
