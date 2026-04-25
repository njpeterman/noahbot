import { useEffect, useState } from "react";
import { exchangeCodeForTokens, login, logout } from "./auth";
import { fetchEvents, playTrack, searchTracks, type StoredEvent, type Track } from "./api";
import { usePlayer } from "./player";

type AuthStatus = "unknown" | "authed" | "anon" | "error";

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
          autoFocus
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

function NowPlaying() {
  const { deviceId, ready, currentState, player } = usePlayer();
  const t = currentState?.track_window.current_track;
  const paused = currentState?.paused ?? true;
  return (
    <section className="now-playing">
      <p className="device">
        Device: <span className={ready ? "ok" : "warn"}>{ready ? `ready (${deviceId?.slice(0, 8)}…)` : "connecting…"}</span>
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
        <button onClick={() => void player?.previousTrack()} disabled={!player}>⏮</button>
        <button
          onClick={() => void player?.togglePlay()}
          disabled={!player}
          className="primary"
        >
          {paused ? "▶" : "⏸"}
        </button>
        <button onClick={() => void player?.nextTrack()} disabled={!player}>⏭</button>
      </div>
      <Search deviceId={deviceId} />
    </section>
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
      <header>
        <h1>Playlist Builder</h1>
        {authStatus === "authed" && (
          <button
            className="logout"
            onClick={async () => {
              await logout();
              refreshAuth();
            }}
          >
            Log out
          </button>
        )}
      </header>

      {authStatus === "unknown" && <p>Loading…</p>}
      {authStatus === "error" && <p className="error">Could not reach API. Is the backend running?</p>}
      {authStatus === "anon" && (
        <section className="login">
          <p>Connect Spotify to start.</p>
          <button className="primary" onClick={() => void login()}>
            Log in with Spotify
          </button>
        </section>
      )}
      {authStatus === "authed" && (
        <>
          <NowPlaying />
          <EventLog />
        </>
      )}
    </main>
  );
}
