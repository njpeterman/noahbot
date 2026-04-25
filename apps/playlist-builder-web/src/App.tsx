import { useEffect, useState } from "react";
import { exchangeCodeForTokens, login, logout } from "./auth";
import {
  adoptPlaylist,
  buildPlaylist,
  fetchEvents,
  fetchTriageStats,
  playTrackUris,
  rateTrack,
  syncLikedSongs,
  type PlaylistTrack,
  type Rating,
  type StoredEvent,
  type TriageStats,
} from "./api";
import { usePlayer } from "./player";

type AuthStatus = "unknown" | "authed" | "anon" | "error";
type Tab = "listen" | "events";

function useAuthStatus(): [AuthStatus, () => void] {
  const [status, setStatus] = useState<AuthStatus>("unknown");

  const refresh = () => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { authenticated: boolean }) => setStatus(d.authenticated ? "authed" : "anon"))
      .catch(() => setStatus("error"));
  };

  useEffect(refresh, []);
  return [status, refresh];
}

function CallbackHandler({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState("Finishing login…");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    if (error) {
      setMsg(`Spotify error: ${error}`);
      return;
    }
    if (!code || !state) {
      setMsg("Missing code/state in callback URL.");
      return;
    }
    exchangeCodeForTokens(code, state)
      .then(() => {
        window.history.replaceState({}, "", "/");
        onDone();
      })
      .catch((e: Error) => setMsg(`Login failed: ${e.message}`));
  }, [onDone]);
  return <p>{msg}</p>;
}

type PlayerHandle = ReturnType<typeof usePlayer>;

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function PlaylistPanel({ player }: { player: PlayerHandle }) {
  const [queue, setQueue] = useState<PlaylistTrack[]>([]);
  const [stats, setStats] = useState<TriageStats | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [adoptInput, setAdoptInput] = useState("");
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const paused = player.currentState?.paused ?? true;
  const duration = player.currentState?.duration ?? 0;
  const currentUri = player.currentState?.track_window.current_track?.uri ?? null;
  const current = currentUri ? queue.find((t) => t.track_uri === currentUri) ?? null : null;

  const [position, setPosition] = useState(0);
  const [seeking, setSeeking] = useState(false);

  useEffect(() => {
    if (seeking) return;
    setPosition(player.currentState?.position ?? 0);
  }, [player.currentState, seeking]);

  useEffect(() => {
    if (paused || !player.player || seeking) return;
    const id = setInterval(() => {
      void player.player!.getCurrentState().then((s) => {
        if (s) setPosition(s.position);
      });
    }, 500);
    return () => clearInterval(id);
  }, [paused, player.player, seeking]);

  const refreshStats = () => {
    fetchTriageStats().then(setStats).catch(() => {});
  };

  useEffect(() => {
    refreshStats();
  }, []);

  const onBuild = async () => {
    if (!player.deviceId) {
      setErr("Player not ready yet — wait a moment.");
      return;
    }
    setBuilding(true);
    setErr(null);
    try {
      const { tracks } = await buildPlaylist();
      setQueue(tracks);
      if (tracks.length === 0) {
        setErr("No tracks available — sync Liked Songs first.");
        return;
      }
      await playTrackUris(player.deviceId, tracks.map((t) => t.track_uri));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "build failed");
    } finally {
      setBuilding(false);
    }
  };

  const onAdopt = async () => {
    if (!adoptInput.trim()) return;
    setAdopting(true);
    setErr(null);
    try {
      const { adopted } = await adoptPlaylist(adoptInput.trim());
      setAdoptInput("");
      setAdoptOpen(false);
      refreshStats();
      alert(`Adopted ${adopted} tracks as Heavy Rotation.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "adopt failed");
    } finally {
      setAdopting(false);
    }
  };

  const onSync = async () => {
    setSyncing(true);
    setErr(null);
    try {
      await syncLikedSongs();
      refreshStats();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const onRate = async (rating: Rating) => {
    if (!current || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await rateTrack(current.track_uri, rating);
      setQueue((q) =>
        q.map((t) => (t.track_uri === current.track_uri ? { ...t, rating } : t))
      );
      refreshStats();
      if (rating === "reject") {
        void player.player?.nextTrack();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "rate failed");
    } finally {
      setBusy(false);
    }
  };

  const artists: string[] = current ? JSON.parse(current.artists) : [];

  return (
    <section className="triage">
      <div className="triage-header">
        {stats && (
          <div className="stats">
            <span><strong>{stats.unrated}</strong> untriaged</span>
            <span><strong>{stats.heavy_rotation}</strong> 🔥</span>
            <span><strong>{stats.reject}</strong> 🗑</span>
          </div>
        )}
        <div className="header-actions">
          <button onClick={onSync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync Liked Songs"}
          </button>
          <button onClick={() => setAdoptOpen((v) => !v)} disabled={adopting}>
            Adopt playlist
          </button>
        </div>
      </div>

      {adoptOpen && (
        <div className="adopt-form">
          <input
            value={adoptInput}
            onChange={(e) => setAdoptInput(e.target.value)}
            placeholder="Spotify playlist URL or ID"
            disabled={adopting}
          />
          <button onClick={onAdopt} disabled={adopting || !adoptInput.trim()} className="primary">
            {adopting ? "Adopting…" : "Adopt"}
          </button>
        </div>
      )}

      {err && <p className="error">{err}</p>}

      {queue.length === 0 && (
        <div className="triage-empty">
          <button onClick={onBuild} disabled={building || !player.deviceId} className="primary build">
            {building ? "Building…" : "Build Playlist"}
          </button>
          <p className="hint">~60 min mix of Heavy Rotation + untriaged Liked Songs, shuffled.</p>
        </div>
      )}

      {current && (
        <>
          <div className="triage-card">
            {current.album_image_url && (
              <img src={current.album_image_url} alt="" className="triage-art" />
            )}
            <h2>{current.track_name}</h2>
            <p className="triage-artists">{artists.join(", ")}</p>
            <p className="triage-album">{current.album}</p>
            {current.rating === "heavy_rotation" && (
              <p className="triage-source">🔥 In Heavy Rotation</p>
            )}

            <div className="triage-progress">
              <span className="time">{fmtMs(position)}</span>
              <input
                type="range"
                className="scrubber"
                min={0}
                max={duration || 0}
                value={position}
                onMouseDown={() => setSeeking(true)}
                onTouchStart={() => setSeeking(true)}
                onMouseUp={() => setSeeking(false)}
                onTouchEnd={() => setSeeking(false)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setPosition(v);
                  void player.player?.seek(v);
                }}
                disabled={!player.player || duration === 0}
              />
              <span className="time">{fmtMs(duration)}</span>
            </div>

            <div className="triage-playback">
              <button
                onClick={() => void player.player?.previousTrack()}
                disabled={!player.player}
                className="seek"
                title="Previous track"
              >
                ⏮
              </button>
              <button
                onClick={() => void player.player?.togglePlay()}
                disabled={!player.player}
                className="primary play-pause"
              >
                {paused ? "▶" : "⏸"}
              </button>
              <button
                onClick={() => void player.player?.nextTrack()}
                disabled={!player.player}
                className="seek"
                title="Next track"
              >
                ⏭
              </button>
            </div>
          </div>

          {current.rating !== "heavy_rotation" && (
            <div className="triage-actions">
              <button
                onClick={() => onRate("reject")}
                disabled={busy}
                className="reject"
              >
                🗑 Reject
              </button>
              <button
                onClick={() => onRate("heavy_rotation")}
                disabled={busy}
                className="primary heavy"
              >
                🔥 Heavy Rotation
              </button>
            </div>
          )}

          <div className="queue-meta">
            {queue.findIndex((t) => t.track_uri === current.track_uri) + 1} / {queue.length}
            <button onClick={onBuild} disabled={building} className="rebuild">
              {building ? "Building…" : "↻ New playlist"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function EventLog() {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const refresh = () => {
    fetchEvents(50).then(setEvents).catch(() => setEvents([]));
  };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);
  return (
    <section className="events">
      <h3>Recent events</h3>
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>type</th>
            <th>track</th>
            <th>pos</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.ts).toLocaleTimeString()}</td>
              <td>{e.event_type}</td>
              <td>{e.track_name ?? ""}</td>
              <td>{e.position_ms != null && e.duration_ms != null
                ? `${Math.floor(e.position_ms / 1000)}/${Math.floor(e.duration_ms / 1000)}s`
                : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AuthedApp({ onLogout }: { onLogout: () => void }) {
  const player = usePlayer();
  const [tab, setTab] = useState<Tab>("listen");

  return (
    <>
      <header>
        <h1>Playlist Builder</h1>
        <button className="logout" onClick={onLogout}>Log out</button>
      </header>

      <nav className="tabs">
        <button onClick={() => setTab("listen")} className={tab === "listen" ? "active" : ""}>Listen</button>
        <button onClick={() => setTab("events")} className={tab === "events" ? "active" : ""}>Events</button>
      </nav>

      {tab === "listen" && <PlaylistPanel player={player} />}
      {tab === "events" && <EventLog />}
    </>
  );
}

export default function App() {
  const [authStatus, refreshAuth] = useAuthStatus();
  const isCallback = window.location.pathname === "/auth/callback";

  if (isCallback) {
    return (
      <main>
        <header>
          <h1>Playlist Builder</h1>
        </header>
        <CallbackHandler onDone={refreshAuth} />
      </main>
    );
  }

  return (
    <main>
      {authStatus === "unknown" && <p>Loading…</p>}
      {authStatus === "error" && (
        <>
          <header><h1>Playlist Builder</h1></header>
          <p className="error">Could not reach API. Is the backend running?</p>
        </>
      )}
      {authStatus === "anon" && (
        <>
          <header><h1>Playlist Builder</h1></header>
          <section className="login">
            <p>Connect Spotify to start.</p>
            <button className="primary" onClick={() => void login()}>
              Log in with Spotify
            </button>
          </section>
        </>
      )}
      {authStatus === "authed" && (
        <AuthedApp
          onLogout={async () => {
            await logout();
            refreshAuth();
          }}
        />
      )}
    </main>
  );
}
