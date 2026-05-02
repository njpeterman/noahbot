import { useEffect, useMemo, useRef, useState } from "react";
import { exchangeCodeForTokens, login, logout } from "./auth";
import {
  adoptPlaylist,
  buildPlaylist,
  fetchEvents,
  fetchLyrics,
  fetchTriageStats,
  playTrackUris,
  rateTrack,
  syncLikedSongs,
  type AdoptRating,
  type LyricsResponse,
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

type SyncedLine = { time_ms: number; text: string };

const LRC_TIMESTAMP_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

function parseLrc(lrc: string): SyncedLine[] {
  const lines: SyncedLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    LRC_TIMESTAMP_RE.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let lastIdx = 0;
    while ((match = LRC_TIMESTAMP_RE.exec(raw)) !== null) {
      const m = Number(match[1]);
      const s = Number(match[2]);
      const fracStr = match[3] ?? "0";
      const frac = Number(fracStr.padEnd(3, "0").slice(0, 3));
      stamps.push((m * 60 + s) * 1000 + frac);
      lastIdx = match.index + match[0].length;
    }
    if (stamps.length === 0) continue;
    const text = raw.slice(lastIdx).trim();
    for (const t of stamps) lines.push({ time_ms: t, text });
  }
  lines.sort((a, b) => a.time_ms - b.time_ms);
  return lines;
}

function findCurrentLineIdx(lines: SyncedLine[], position_ms: number): number {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.time_ms <= position_ms) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function LyricsPanel({
  trackUri,
  trackName,
  artists,
  album,
  durationMs,
  positionMs,
}: {
  trackUri: string;
  trackName: string;
  artists: string[];
  album: string | null;
  durationMs: number | null;
  positionMs: number;
}) {
  const [data, setData] = useState<LyricsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoading(true);
    fetchLyrics({
      track_uri: trackUri,
      track_name: trackName,
      artists,
      album,
      duration_ms: durationMs,
    })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ found: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trackUri]);

  const synced = useMemo<SyncedLine[] | null>(() => {
    if (!data || !data.found || !data.synced || !data.synced_lyrics) return null;
    return parseLrc(data.synced_lyrics);
  }, [data]);

  const currentIdx = synced ? findCurrentLineIdx(synced, positionMs) : -1;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    if (currentIdx < 0) return;
    const el = lineRefs.current[currentIdx];
    const container = containerRef.current;
    if (!el || !container) return;
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const target =
      container.scrollTop +
      (elRect.top - containerRect.top) -
      container.clientHeight / 2 +
      el.clientHeight / 2;
    container.scrollTo({ top: target, behavior: "smooth" });
  }, [currentIdx]);

  if (loading && !data) {
    return <div className="lyrics-panel lyrics-status">Loading lyrics…</div>;
  }
  if (!data || !data.found) return null;

  if (synced) {
    return (
      <div className="lyrics-panel" ref={containerRef}>
        {synced.map((line, i) => (
          <div
            key={i}
            ref={(el) => {
              lineRefs.current[i] = el;
            }}
            className={`lyrics-line${i === currentIdx ? " current" : ""}`}
          >
            {line.text || " "}
          </div>
        ))}
      </div>
    );
  }

  if (data.plain_lyrics) {
    return (
      <div className="lyrics-panel lyrics-plain">
        {data.plain_lyrics.split(/\r?\n/).map((line, i) => (
          <div key={i} className="lyrics-line">
            {line || " "}
          </div>
        ))}
      </div>
    );
  }

  return null;
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
  const [adoptAs, setAdoptAs] = useState<AdoptRating>("heavy_rotation");
  const [err, setErr] = useState<string | null>(null);

  const paused = player.currentState?.paused ?? true;
  const duration = player.currentState?.duration ?? 0;
  const sdkTrack = player.currentState?.track_window.current_track ?? null;
  const sdkUri = sdkTrack?.uri ?? null;
  const sdkLinkedFromUri =
    (sdkTrack as { linked_from?: { uri?: string } } | null)?.linked_from?.uri ?? null;
  const current =
    queue.find((t) => t.track_uri === sdkUri || (sdkLinkedFromUri ? t.track_uri === sdkLinkedFromUri : false)) ??
    null;
  const display = current
    ? {
        name: current.track_name,
        artists: (JSON.parse(current.artists) as string[]).join(", "),
        album: current.album ?? "",
        image: current.album_image_url,
        rating: current.rating,
        inQueue: true,
      }
    : sdkTrack
      ? {
          name: sdkTrack.name,
          artists: sdkTrack.artists.map((a) => a.name).join(", "),
          album: sdkTrack.album?.name ?? "",
          image: sdkTrack.album?.images?.[0]?.url ?? null,
          rating: null as Rating | null,
          inQueue: false,
        }
      : null;

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
      const { adopted, removed_from_hr } = await adoptPlaylist(adoptInput.trim(), adoptAs);
      setAdoptInput("");
      setAdoptOpen(false);
      refreshStats();
      const label = adoptAs === "heavy_rotation" ? "Heavy Rotation" : "Reject";
      const extra = removed_from_hr > 0 ? ` (${removed_from_hr} removed from Heavy Rotation playlist)` : "";
      alert(`Adopted ${adopted} tracks as ${label}.${extra}`);
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
          <select
            value={adoptAs}
            onChange={(e) => setAdoptAs(e.target.value as AdoptRating)}
            disabled={adopting}
            className="adopt-as"
          >
            <option value="heavy_rotation">as Heavy Rotation</option>
            <option value="reject">as Reject</option>
          </select>
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

      {display && (
        <>
          <div className="triage-card">
            {display.image && (
              <img src={display.image} alt="" className="triage-art" />
            )}
            <h2>{display.name}</h2>
            <p className="triage-artists">{display.artists}</p>
            <p className="triage-album">{display.album}</p>
            {display.rating === "heavy_rotation" && (
              <p className="triage-source">🔥 In Heavy Rotation</p>
            )}
            {!display.inQueue && (
              <p className="triage-source">↳ Spotify autoplay (not in your queue)</p>
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

          {display.inQueue && display.rating !== "heavy_rotation" && (
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

          {sdkUri && sdkTrack && (
            <LyricsPanel
              trackUri={sdkUri}
              trackName={sdkTrack.name}
              artists={sdkTrack.artists.map((a) => a.name)}
              album={sdkTrack.album?.name ?? null}
              durationMs={duration || null}
              positionMs={position}
            />
          )}

          <div className="queue-meta">
            {current
              ? `${queue.findIndex((t) => t.track_uri === current.track_uri) + 1} / ${queue.length}`
              : `— / ${queue.length}`}
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
