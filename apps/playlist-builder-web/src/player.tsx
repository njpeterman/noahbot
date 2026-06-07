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

function updateMediaSession(state: Spotify.PlaybackState) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const t = state.track_window.current_track;
  if (!t) return;
  const artwork = (t.album?.images ?? [])
    .filter((img) => !!img.url)
    .map((img) => {
      const size = img.width && img.height ? `${img.width}x${img.height}` : "512x512";
      return { src: img.url, sizes: size, type: "image/jpeg" };
    });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.name ?? "",
    artist: t.artists?.map((a) => a.name).join(", ") ?? "",
    album: t.album?.name ?? "",
    artwork,
  });
  navigator.mediaSession.playbackState = state.paused ? "paused" : "playing";
  try {
    if (state.duration > 0) {
      navigator.mediaSession.setPositionState({
        duration: state.duration / 1000,
        position: Math.min(state.position, state.duration) / 1000,
        playbackRate: 1,
      });
    }
  } catch {
    // setPositionState throws if values are out of range — safe to ignore
  }
}

function ensureSilentAudioPlaying(audio: HTMLAudioElement | null) {
  if (!audio || !audio.paused) return;
  void audio.play().catch(() => { /* autoplay may be blocked before first user gesture */ });
}

function bindMediaSessionActions(
  player: Spotify.Player,
  silentAudioRef: { current: HTMLAudioElement | null },
) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => {
    ensureSilentAudioPlaying(silentAudioRef.current);
    ms.playbackState = "playing";
    void player.resume();
  });
  ms.setActionHandler("pause", () => {
    ensureSilentAudioPlaying(silentAudioRef.current);
    ms.playbackState = "paused";
    void player.pause();
  });
  ms.setActionHandler("previoustrack", () => {
    ensureSilentAudioPlaying(silentAudioRef.current);
    void player.previousTrack();
  });
  ms.setActionHandler("nexttrack", () => {
    ensureSilentAudioPlaying(silentAudioRef.current);
    void player.nextTrack();
  });
  ms.setActionHandler("seekto", (details) => {
    if (typeof details.seekTime === "number") {
      void player.seek(details.seekTime * 1000);
    }
  });
  // Explicitly disable 10s seek so iOS shows prev/next buttons instead
  try { ms.setActionHandler("seekbackward", null); } catch { /* not all browsers */ }
  try { ms.setActionHandler("seekforward", null); } catch { /* not all browsers */ }
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
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const prevSnapshot = useRef<Diff | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Silent looping audio on the parent page. Without this, iOS attaches its
    // Now Playing card to the cross-origin Spotify iframe (sdk.scdn.co) and
    // ignores our navigator.mediaSession overrides. With it, the parent page
    // owns active media and iOS uses our metadata + action handlers.
    const silent = new Audio("/silent.wav");
    silent.loop = true;
    silent.preload = "auto";
    silentAudioRef.current = silent;

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
        updateMediaSession(state);
        // Keep silent audio running for the lifetime of the session so the
        // parent page always owns iOS's Now Playing card. We never pause it —
        // pausing would let the Spotify iframe momentarily reclaim the card.
        if (!state.paused) ensureSilentAudioPlaying(silentAudioRef.current);
        const next = snapshotFrom(state);
        const event_type = classify(prevSnapshot.current, next);
        prevSnapshot.current = next;
        if (event_type === "progress") return; // skip noisy progress-only updates
        void logEvent({ ...next, event_type, raw_state: state });
      });

      bindMediaSessionActions(player, silentAudioRef);

      player.connect();
    })();

    return () => {
      cancelled = true;
      playerRef.current?.disconnect();
      playerRef.current = null;
      silentAudioRef.current?.pause();
      silentAudioRef.current = null;
    };
  }, []);

  return { deviceId, ready, currentState, player: playerRef.current };
}
