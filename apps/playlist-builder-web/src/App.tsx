import { useEffect, useState } from "react";
import { exchangeCodeForTokens, login, logout } from "./auth";
import {
  fetchEvents,
  fetchNextTriage,
  fetchTriageStats,
  playTrack,
  rateTrack,
  searchTracks,
  syncLikedSongs,
  type LikedSong,
  type Rating,
  type StoredEvent,
  type Track,
  type TriageStats,
} from "./api";
import { usePlayer } from "./player";

type AuthStatus = "unknown" | "authed" | "anon" | "error";
type Tab = "play" | "triage" | "events";

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

function Search({ deviceId }: { deviceId: string | null }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setResults(await searchTracks(q));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "search failed");
    } finally {
      setBusy(false);
    }
  };

  const onPlay = async (uri: string) => {
    if (!deviceId) {
      setErr("Player not ready yet — wait a moment.");
      return;
    }
    try {
      await playTrack(deviceId, uri);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "play failed");
    }
  };

  return (
    <section className="search">
      <form onSubmit={onSubmit}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tracks…"
        />
        <button type="submit" disabled={busy || !q.trim()}>
          Search
        </button>
      </form>
      {err && <p className="error">{err}</p>}
      <ul className="results">
        {results.map((t) => (
          <li key={t.uri}>
            <button onClick={() => onPlay(t.uri)} className="play">
              ▶
            </button>
            <span className="track">
              <strong>{t.name}</strong>
              <small>{t.artists.map((a) => a.name).join(", ")}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NowPlayingPanel({ player }: { player: PlayerHandle }) {
  const t = player.currentState?.track_window.current_track;
  const paused = player.currentState?.paused ?? true;
  return (
    <section className="now-playing">
      <p className="device">
        Device:{" "}
        <span className={player.ready ? "ok" : "warn"}>
          {player.ready ? `ready (${player.deviceId?.slice(0, 8)}…)` : "connecting…"}
        </span>
      </p>
      {t && (
        <div className="track-current">
          {t.album?.images?.[0] && <img src={t.album.images[0].url} alt="" width={64} height={64} />}
          <div>
            <strong>{t.name}</strong>
            <small>{t.artists.map((a) => a.name).join(", ")}</small>
            <small>{paused ? "paused" : "playing"}</small>
          </div>
        </div>
      )}
      <div className="controls">
        <button onClick={() => void player.player?.previousTrack()} disabled={!player.player}>⏮</button>
        <button
          onClick={() => void player.player?.togglePlay()}
          disabled={!player.player}
          className="primary"
        >
          {paused ? "▶" : "⏸"}
        </button>
        <button onClick={() => void player.player?.nextTrack()} disabled={!player.player}>⏭</button>
      </div>
      <Search deviceId={player.deviceId} />
    </section>
  );
}

function TriagePanel({ player }: { player: PlayerHandle }) {
  const [song, setSong] = useState<LikedSong | null>(null);
  const [source, setSource] = useState<"unrated" | "deferred" | undefined>(undefined);
  const [stats, setStats] = useState<TriageStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refreshStats = () => {
    fetchTriageStats().then(setStats).catch(() => {});
  };

  const loadNext = async () => {
    setErr(null);
    try {
      const { song, source } = await fetchNextTriage();
      setSong(song);
      setSource(source);
      if (song && player.deviceId) {
        await playTrack(player.deviceId, song.track_uri);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  };

  useEffect(() => {
    refreshStats();
    void loadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.deviceId]);

  const onSync = async () => {
    setSyncing(true);
    setErr(null);
    try {
      await syncLikedSongs();
      refreshStats();
      if (!song) await loadNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const onRate = async (rating: Rating) => {
    if (!song || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await rateTrack(song.track_uri, rating);
      refreshStats();
      await loadNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "rate failed");
    } finally {
      setBusy(false);
    }
  };

  const onReplay = async () => {
    if (!song || !player.deviceId) return;
    try {
      await playTrack(player.deviceId, song.track_uri);
    } catch {
      // ignore
    }
  };

  const artists: string[] = song ? JSON.parse(song.artists) : [];

  return (
    <section className="triage">
      <div className="triage-header">
        {stats && (
          <div className="stats">
            <span><strong>{stats.unrated}</strong> to triage</span>
            <span><strong>{stats.heavy_rotation}</strong> 🔥</span>
            <span><strong>{stats.reject}</strong> 🗑</span>
            <span><strong>{stats.defer}</strong> ⏳</span>
          </div>
        )}
        <button onClick={onSync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync Liked Songs"}
        </button>
      </div>

      {err && <p className="error">{err}</p>}

      {!song && (
        <div className="triage-empty">
          <p>{stats?.total === 0 ? "No liked songs synced yet — hit Sync." : "All caught up. ✨"}</p>
        </div>
      )}

      {song && (
        <>
          <div className="triage-card">
            {song.album_image_url && (
              <img src={song.album_image_url} alt="" className="triage-art" />
            )}
            <h2>{song.track_name}</h2>
            <p className="triage-artists">{artists.join(", ")}</p>
            <p className="triage-album">{song.album}</p>
            {source === "deferred" && <p className="triage-source">↩︎ Re-surfaced from defer</p>}
            <button onClick={onReplay} className="replay">↻ Replay</button>
          </div>

          <div className="triage-actions">
            <button
              onClick={() => onRate("reject")}
              disabled={busy}
              className="reject"
            >
              🗑 Reject
            </button>
            <button
              onClick={() => onRate("defer")}
              disabled={busy}
              className="defer"
            >
              ⏳ Defer
            </button>
            <button
              onClick={() => onRate("heavy_rotation")}
              disabled={busy}
              className="primary heavy"
            >
              🔥 Heavy Rotation
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
  const [tab, setTab] = useState<Tab>("triage");

  return (
    <>
      <header>
        <h1>Playlist Builder</h1>
        <button className="logout" onClick={onLogout}>Log out</button>
      </header>

      <nav className="tabs">
        <button onClick={() => setTab("triage")} className={tab === "triage" ? "active" : ""}>Triage</button>
        <button onClick={() => setTab("play")} className={tab === "play" ? "active" : ""}>Play</button>
        <button onClick={() => setTab("events")} className={tab === "events" ? "active" : ""}>Events</button>
      </nav>

      {tab === "triage" && <TriagePanel player={player} />}
      {tab === "play" && <NowPlayingPanel player={player} />}
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
