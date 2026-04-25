import { useEffect, useRef, useState } from "react";
import { fetchAccessToken } from "./auth";
import { logEvent } from "./api";

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

function loadSdk(): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelector(`script[src="${SDK_SRC}"]`)) {
      if (window.Spotify) return resolve();
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const tag = document.createElement("script");
    tag.src = SDK_SRC;
    tag.async = true;
    document.body.appendChild(tag);
  });
}

type Diff = {
  event_type: string;
  position_ms: number;
  duration_ms: number;
  paused: boolean;
  track_uri: string | null;
  track_name: string | null;
  artists: string[];
  album: string | null;
  context_uri: string | null;
};

function snapshotFrom(state: Spotify.PlaybackState): Diff {
  const t = state.track_window.current_track;
  return {
    event_type: "snapshot",
    position_ms: state.position,
    duration_ms: state.duration,
    paused: state.paused,
    track_uri: t?.uri ?? null,
    track_name: t?.name ?? null,
    artists: t?.artists?.map((a) => a.name) ?? [],
    album: t?.album?.name ?? null,
    context_uri: state.context?.uri ?? null,
  };
}

function classify(prev: Diff | null, next: Diff): string {
  if (!prev) return "session_start";
  if (prev.track_uri !== next.track_uri) {
    if (prev.duration_ms > 0 && prev.position_ms >= prev.duration_ms - 2000) {
      return "track_complete";
    }
    return "track_change";
  }
  if (prev.paused && !next.paused) return "play";
  if (!prev.paused && next.paused) return "pause";
  // Detect seek: time jumps that don't match elapsed wallclock (rough heuristic — refine later)
  return "progress";
}

export function usePlayer() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [currentState, setCurrentState] = useState<Spotify.PlaybackState | null>(null);
  const playerRef = useRef<Spotify.Player | null>(null);
  const prevSnapshot = useRef<Diff | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await loadSdk();
      if (cancelled) return;

      const player = new window.Spotify.Player({
        name: "noahbot",
        getOAuthToken: async (cb) => {
          try {
            const token = await fetchAccessToken();
            cb(token);
          } catch (e) {
            console.error("getOAuthToken failed", e);
          }
        },
        volume: 0.5,
      });
      playerRef.current = player;

      player.addListener("ready", ({ device_id }) => {
        setDeviceId(device_id);
        setReady(true);
      });
      player.addListener("not_ready", () => setReady(false));
      player.addListener("initialization_error", ({ message }) => console.error("init_error", message));
      player.addListener("authentication_error", ({ message }) => console.error("auth_error", message));
      player.addListener("account_error", ({ message }) => console.error("account_error", message));
      player.addListener("playback_error", ({ message }) => console.error("playback_error", message));

      player.addListener("player_state_changed", (state) => {
        if (!state) return;
        setCurrentState(state);
        const next = snapshotFrom(state);
        const event_type = classify(prevSnapshot.current, next);
        prevSnapshot.current = next;
        if (event_type === "progress") return; // skip noisy progress-only updates
        void logEvent({ ...next, event_type, raw_state: state });
      });

      player.connect();
    })();

    return () => {
      cancelled = true;
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, []);

  return { deviceId, ready, currentState, player: playerRef.current };
}
