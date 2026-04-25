import { getValidAccessToken } from "./spotify.js";

const API = "https://api.spotify.com/v1";

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getValidAccessToken();
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

export type SpotifyMe = { id: string; display_name: string | null; email: string | null };

export async function getMe(): Promise<SpotifyMe> {
  const r = await authedFetch("/me");
  if (!r.ok) throw new Error(`getMe failed: ${r.status}`);
  return (await r.json()) as SpotifyMe;
}

export type SavedTracksItem = {
  added_at: string;
  track: {
    uri: string;
    name: string;
    duration_ms: number;
    artists: { name: string }[];
    album: { name: string; images: { url: string }[] };
  };
};

export type SavedTracksPage = {
  items: SavedTracksItem[];
  next: string | null;
  total: number;
};

export async function getSavedTracksPage(offset: number, limit = 50): Promise<SavedTracksPage> {
  const r = await authedFetch(`/me/tracks?limit=${limit}&offset=${offset}`);
  if (!r.ok) throw new Error(`getSavedTracksPage failed: ${r.status}`);
  return (await r.json()) as SavedTracksPage;
}

export async function createPlaylist(userId: string, name: string, description: string): Promise<string> {
  const r = await authedFetch(`/users/${encodeURIComponent(userId)}/playlists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, public: false }),
  });
  if (!r.ok) throw new Error(`createPlaylist failed: ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { id: string };
  return data.id;
}

export async function addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
  if (trackUris.length === 0) return;
  const r = await authedFetch(`/playlists/${playlistId}/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris: trackUris }),
  });
  if (!r.ok) throw new Error(`addTracksToPlaylist failed: ${r.status} ${await r.text()}`);
}

export async function removeTracksFromPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
  if (trackUris.length === 0) return;
  const r = await authedFetch(`/playlists/${playlistId}/tracks`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: trackUris.map((uri) => ({ uri })) }),
  });
  if (!r.ok) throw new Error(`removeTracksFromPlaylist failed: ${r.status} ${await r.text()}`);
}

type PlaylistTracksItem = {
  track: { uri: string; type: string; is_local?: boolean } | null;
};

type PlaylistTracksPage = {
  items: PlaylistTracksItem[];
  next: string | null;
  total: number;
};

export async function getAllPlaylistTrackUris(playlistId: string): Promise<string[]> {
  const uris: string[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const r = await authedFetch(
      `/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=items(track(uri,type,is_local)),next,total`
    );
    if (!r.ok) throw new Error(`getAllPlaylistTrackUris failed: ${r.status} ${await r.text()}`);
    const page = (await r.json()) as PlaylistTracksPage;
    for (const it of page.items) {
      const t = it.track;
      if (!t || t.is_local || t.type !== "track" || !t.uri.startsWith("spotify:track:")) continue;
      uris.push(t.uri);
    }
    if (!page.next || page.items.length === 0) break;
    offset += page.items.length;
  }
  return uris;
}
