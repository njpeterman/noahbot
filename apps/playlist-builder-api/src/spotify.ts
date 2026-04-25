import { getAuth, saveAuth } from "./db.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;

if (!CLIENT_ID) {
  throw new Error("SPOTIFY_CLIENT_ID is required");
}

type TokenResponse = {
  access_token: string;
  token_type: string;
  scope?: string;
  expires_in: number;
  refresh_token?: string;
};

export async function refreshAccessToken(): Promise<string> {
  const auth = getAuth();
  if (!auth) throw new Error("not_authenticated");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
    client_id: CLIENT_ID!,
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`spotify_refresh_failed: ${r.status} ${text}`);
  }

  const data = (await r.json()) as TokenResponse;
  const expiresAt = new Date(Date.now() + (data.expires_in - 30) * 1000).toISOString();

  saveAuth({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? auth.refresh_token,
    expires_at: expiresAt,
    scope: data.scope ?? auth.scope,
    spotify_user_id: auth.spotify_user_id,
  });

  return data.access_token;
}

export async function getValidAccessToken(): Promise<string> {
  const auth = getAuth();
  if (!auth) throw new Error("not_authenticated");

  const expiresAt = new Date(auth.expires_at).getTime();
  if (Date.now() < expiresAt) return auth.access_token;

  return refreshAccessToken();
}
