import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Game = { id: string; name: string };
type ScanSession = { id: string; code: string; created_at: string };
type Scan = { game_id: string; scanned_by: string; scanned_at: string };
type View = "collection" | "labels" | "session";

const storageKey = "tabletop-tracker-games";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

function configureSupabase(
  configuredUrl: string | undefined,
  configuredKey: string | undefined,
): { client: SupabaseClient | null; error: string | null } {
  if (!configuredUrl && !configuredKey) return { client: null, error: null };
  if (!configuredUrl || !configuredKey) {
    return {
      client: null,
      error: "Supabase configuration is incomplete. Set both the project URL and anon key.",
    };
  }

  try {
    const url = new URL(configuredUrl.trim());
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/rest/v1") {
      url.pathname = "";
    } else if (path) {
      throw new Error("Use the Supabase Project URL, not a dashboard or API endpoint URL.");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
      throw new Error("The Supabase Project URL must use HTTPS.");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("The Supabase Project URL must not include credentials, a query, or a fragment.");
    }
    return { client: createClient(url.origin, configuredKey.trim()), error: null };
  } catch (configurationError) {
    return {
      client: null,
      error: `Supabase configuration error: ${(configurationError as Error).message}`,
    };
  }
}

const supabaseConfiguration = configureSupabase(supabaseUrl, supabaseKey);
const supabase = supabaseConfiguration.client;

function readLocalGames(): Game[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (
      Array.isArray(stored) &&
      stored.every(
        (game) =>
          typeof game.id === "string" &&
          typeof game.name === "string",
      )
    ) {
      return stored as Game[];
    }
  } catch {
    console.warn("Could not read the locally saved game list.");
  }
  return [];
}

function makeUuid(): string {
  return crypto.randomUUID();
}

function App() {
  const [view, setView] = useState<View>("collection");
  const [games, setGames] = useState<Game[]>(readLocalGames);
  const [loadingGames, setLoadingGames] = useState(Boolean(supabase));
  const [error, setError] = useState(supabaseConfiguration.error ?? "");
  const [notice, setNotice] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [bulkInput, setBulkInput] = useState("");
  const [session, setSession] = useState<ScanSession | null>(null);
  const [sessionInput, setSessionInput] = useState("");
  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem("tabletop-tracker-player") ?? "",
  );
  const [scans, setScans] = useState<Scan[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualUuid, setManualUuid] = useState("");
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [creatingSession, setCreatingSession] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const scanBusyRef = useRef(false);
  const scannedIds = useMemo(
    () => new Set(scans.map((scan) => scan.game_id)),
    [scans],
  );
  const remaining = games.filter((game) => !scannedIds.has(game.id));

  const refreshGames = useCallback(async () => {
    if (!supabase) {
      setLoadingGames(false);
      return;
    }
    const { data, error: loadError } = await supabase
      .from("games")
      .select("id, name")
      .order("name");
    if (loadError) throw loadError;
    setGames(data ?? []);
  }, []);

  const refreshScans = useCallback(async (sessionId: string) => {
    if (!supabase) return;
    const { data, error: scanError } = await supabase
      .from("scans")
      .select("game_id, scanned_by, scanned_at")
      .eq("session_id", sessionId)
      .order("scanned_at", { ascending: false });
    if (scanError) throw scanError;
    setScans(data ?? []);
  }, []);

  useEffect(() => {
    void refreshGames()
      .catch((loadError: Error) => setError(`Could not load games: ${loadError.message}`))
      .finally(() => setLoadingGames(false));
  }, [refreshGames]);

  useEffect(() => {
    if (supabase) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(games));
    } catch {
      setError("Could not save games in this browser.");
    }
  }, [games]);

  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("games-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "games" }, () => {
        void refreshGames().catch((loadError: Error) => setError(loadError.message));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refreshGames]);

  useEffect(() => {
    if (!supabase || !session) {
      setScans([]);
      return;
    }
    void refreshScans(session.id).catch((scanError: Error) => setError(scanError.message));
    const channel = supabase
      .channel(`session-${session.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "scans",
          filter: `session_id=eq.${session.id}`,
        },
        () => {
          void refreshScans(session.id).catch((scanError: Error) => setError(scanError.message));
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refreshScans, session]);

  useEffect(() => {
    if (!scannerOpen || !videoRef.current) return;
    const reader = new BrowserMultiFormatReader();
    let active = true;
    void reader
      .decodeFromVideoDevice(undefined, videoRef.current, (result) => {
        if (result && active && !scanBusyRef.current) {
          void recordScan(result.getText());
        }
      })
      .then((controls) => {
        if (active) scannerControlsRef.current = controls;
        else controls.stop();
      })
      .catch((cameraError: Error) => {
        if (active) setError(`Could not start camera: ${cameraError.message}`);
      });
    return () => {
      active = false;
      scannerControlsRef.current?.stop();
      scannerControlsRef.current = null;
    };
  }, [scannerOpen]);

  async function addGames(names: string[]) {
    const normalized = [
      ...new Map(
        names
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => [name.toLocaleLowerCase(), name]),
      ).values(),
    ];
    if (!normalized.length) return;
    const existing = new Set(games.map((game) => game.name.toLocaleLowerCase()));
    const additions = normalized
      .filter((name) => !existing.has(name.toLocaleLowerCase()))
      .map((name) => ({ id: makeUuid(), name }));
    if (!additions.length) {
      setNotice("Those games are already in your collection.");
      return;
    }
    if (supabase) {
      const { error: insertError } = await supabase.from("games").insert(additions);
      if (insertError) throw insertError;
      await refreshGames();
    } else {
      setGames((current) =>
        [...current, ...additions].sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
    setNotice(`${additions.length} game${additions.length === 1 ? "" : "s"} added.`);
  }

  async function addSingleGame(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await addGames([nameInput]);
      setNameInput("");
    } catch (insertError) {
      setError(`Could not add game: ${(insertError as Error).message}`);
    }
  }

  async function addBulkGames(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await addGames(bulkInput.split(/\r?\n/));
      setBulkInput("");
    } catch (insertError) {
      setError(`Could not add games: ${(insertError as Error).message}`);
    }
  }

  async function removeGame(game: Game) {
    if (!window.confirm(`Remove "${game.name}" from the collection?`)) return;
    setError("");
    try {
      if (supabase) {
        const { error: deleteError } = await supabase.from("games").delete().eq("id", game.id);
        if (deleteError) throw deleteError;
      }
      setGames((current) => current.filter((entry) => entry.id !== game.id));
      setNotice(`${game.name} removed.`);
    } catch (deleteError) {
      setError(`Could not remove game: ${(deleteError as Error).message}`);
    }
  }

  async function createSession() {
    if (!supabase) return;
    setCreatingSession(true);
    setError("");
    try {
      let created: ScanSession | null = null;
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        const code = Array.from({ length: 4 }, () =>
          String.fromCharCode(65 + crypto.getRandomValues(new Uint8Array(1))[0] % 26),
        ).join("");
        const { data, error: createError } = await supabase
          .from("scan_sessions")
          .insert({ code })
          .select("id, code, created_at")
          .single();
        if (!createError) {
          created = data;
        } else if (createError.code !== "23505") {
          throw createError;
        }
      }
      if (!created) throw new Error("Could not generate a unique join code. Please try again.");
      setSession(created);
      setView("session");
      setNotice("Session created. Share the four-letter code with your players.");
    } catch (createError) {
      setError(`Could not create session: ${(createError as Error).message}`);
    } finally {
      setCreatingSession(false);
    }
  }

  async function joinSession(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setError("");
    const code = sessionInput.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      setError("Enter a four-letter session code.");
      return;
    }
    try {
      const { data, error: joinError } = await supabase
        .from("scan_sessions")
        .select("id, code, created_at")
        .eq("code", code)
        .maybeSingle();
      if (joinError) throw joinError;
      if (!data) {
        setError("No active session found for that code.");
        return;
      }
      setSession(data);
      setView("session");
      setNotice(`Joined session ${data.code}.`);
    } catch (joinError) {
      setError(`Could not join session: ${(joinError as Error).message}`);
    }
  }

  async function recordScan(rawValue: string) {
    if (!supabase || !session) return;
    const id = rawValue.trim().toLowerCase();
    const game = games.find((entry) => entry.id.toLowerCase() === id);
    if (!game) {
      setError(`No game matches QR value "${rawValue}".`);
      return;
    }
    if (scannedIds.has(game.id)) {
      setNotice(`${game.name} has already been scanned in this session.`);
      return;
    }
    scanBusyRef.current = true;
    setError("");
    try {
      const { error: insertError } = await supabase.from("scans").upsert(
        {
          session_id: session.id,
          game_id: game.id,
          scanned_by: playerName.trim() || "Player",
        },
        { onConflict: "session_id,game_id", ignoreDuplicates: true },
      );
      if (insertError) throw insertError;
      await refreshScans(session.id);
      setNotice(`${game.name} scanned.`);
      setManualUuid("");
    } catch (scanError) {
      setError(`Could not save scan: ${(scanError as Error).message}`);
    } finally {
      scanBusyRef.current = false;
    }
  }

  async function prepareQrCodes() {
    setError("");
    try {
      const entries = await Promise.all(
        games.map(async (game) => [
          game.id,
          await QRCode.toDataURL(game.id, {
            width: 240,
            margin: 2,
            color: { dark: "#183c34", light: "#ffffff" },
          }),
        ] as const),
      );
      setQrImages(Object.fromEntries(entries));
    } catch (qrError) {
      setError(`Could not create QR labels: ${(qrError as Error).message}`);
    }
  }

  useEffect(() => {
    if (view === "labels" && Object.keys(qrImages).length !== games.length) {
      void prepareQrCodes();
    }
  }, [view, games, qrImages]);

  function savePlayerName(value: string) {
    setPlayerName(value);
    localStorage.setItem("tabletop-tracker-player", value);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={() => setView("collection")} aria-label="BoardGameScanner home">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}logo-white.png`} alt="" />
          <span>BoardGameScanner</span>
        </a>
        <div className="topbar-right">
          <span className={`connection-pill ${supabase ? "connected" : "local"}`}>
            <span className="status-dot" />
            {supabase ? "Cloud connected" : "Local mode"}
          </span>
        </div>
      </header>

      <main className="main-content">
        <nav className="tabs" aria-label="Main navigation">
          {([
            ["collection", "Games", games.length],
            ["labels", "QR codes", null],
            ["session", "Scan session", null],
          ] as const).map(([id, label, count]) => (
            <button
              className={`tab ${view === id ? "active" : ""}`}
              key={id}
              onClick={() => setView(id)}
              type="button"
            >
              {label}
              {count !== null && <span className="tab-count">{count}</span>}
            </button>
          ))}
        </nav>

        {(error || notice) && (
          <div className={`feedback ${error ? "feedback-error" : "feedback-success"}`} role={error ? "alert" : "status"}>
            <span>{error || notice}</span>
            <button type="button" aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}>×</button>
          </div>
        )}

        {view === "collection" && (
          <section className="workspace">
            <div className="section-heading">
              <div>
                <h2>Games <span className="heading-count">{games.length}</span></h2>
              </div>
              {loadingGames && <span className="muted">Loading…</span>}
            </div>
            <div className="collection-layout">
              <div className="game-list">
                {games.length === 0 && !loadingGames ? (
                  <div className="empty-state">
                    <h3>No games</h3>
                  </div>
                ) : (
                  games.map((game, index) => (
                    <article className="game-row" key={game.id}>
                      <div className={`game-initial initial-${index % 5}`}>{game.name.trim()[0]?.toUpperCase() ?? "?"}</div>
                      <div className="game-info">
                        <strong>{game.name}</strong>
                        <span>UUID · {game.id.slice(0, 8)}…</span>
                      </div>
                      <button className="icon-button" onClick={() => void removeGame(game)} title={`Remove ${game.name}`} type="button">×</button>
                    </article>
                  ))
                )}
              </div>
              <aside className="add-panel">
                <div className="panel-title"><h3>Add games</h3></div>
                <form onSubmit={(event) => void addSingleGame(event)}>
                  <label htmlFor="game-name">Game name</label>
                  <div className="input-action">
                    <input id="game-name" maxLength={120} placeholder="e.g. Catan" value={nameInput} onChange={(event) => setNameInput(event.target.value)} />
                    <button className="button button-green button-small" disabled={!nameInput.trim()} type="submit">Add</button>
                  </div>
                </form>
                <div className="form-divider"><span>OR</span></div>
                <form onSubmit={(event) => void addBulkGames(event)}>
                  <label htmlFor="bulk-games">One game per line</label>
                  <textarea id="bulk-games" placeholder={"Wingspan\nTicket to Ride\nAzul"} rows={5} value={bulkInput} onChange={(event) => setBulkInput(event.target.value)} />
                  <button className="button button-outline full-width" disabled={!bulkInput.trim()} type="submit">Add games <span>↗</span></button>
                </form>
              </aside>
            </div>
          </section>
        )}

        {view === "labels" && (
          <section className="workspace">
            <div className="section-heading">
              <h2>QR codes <span className="heading-count">{games.length}</span></h2>
              <button className="button button-primary button-small" disabled={!games.length} onClick={() => window.print()} type="button">Print</button>
            </div>
            {games.length === 0 ? (
              <div className="empty-state"><h3>No games</h3><button className="button button-primary" onClick={() => setView("collection")} type="button">Add games</button></div>
            ) : (
              <div className="qr-grid">
                {games.map((game) => (
                  <article className="qr-card" key={game.id}>
                    {qrImages[game.id] ? <img src={qrImages[game.id]} alt={`QR code for ${game.name}`} /> : <div className="qr-placeholder">Creating code…</div>}
                    <strong>{game.name}</strong>
                    <code>{game.id}</code>
                    <button className="button button-outline button-small" disabled={!qrImages[game.id]} onClick={() => {
                      const link = document.createElement("a");
                      link.href = qrImages[game.id];
                      link.download = `${game.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-qr.png`;
                      link.click();
                    }} type="button">Download PNG</button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {view === "session" && (
          <section className="workspace">
            <div className="section-heading">
              <h2>Scan session</h2>
              {session && <button className="button button-outline button-small" onClick={() => { setSession(null); setScans([]); }} type="button">Leave session</button>}
            </div>
            {!supabase ? (
              <div className="empty-state">
                <h3>Shared sessions need Supabase</h3>
                <a className="button button-primary" href="https://github.com/ruddpj/BoardGameScanner#set-up-shared-scanning" target="_blank" rel="noreferrer">Setup guide</a>
              </div>
            ) : !session ? (
              <div className="session-options">
                <article className="session-card">
                  <h3>Create a session</h3>
                  <button className="button button-primary full-width" disabled={creatingSession} onClick={() => void createSession()} type="button">{creatingSession ? "Creating…" : "Create session"}</button>
                </article>
                <article className="session-card">
                  <h3>Join a session</h3>
                  <form onSubmit={(event) => void joinSession(event)}>
                    <label htmlFor="session-code">Session code</label>
                    <input className="code-input" id="session-code" maxLength={4} placeholder="ABCD" value={sessionInput} onChange={(event) => setSessionInput(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
                    <button className="button button-outline full-width" disabled={sessionInput.length !== 4} type="submit">Join session</button>
                  </form>
                </article>
              </div>
            ) : (
              <div className="session-board">
                <div className="session-banner">
                  <div><div className="session-label">Session code</div><div className="session-code">{session.code.split("").map((letter, index) => <span key={`${letter}-${index}`}>{letter}</span>)}</div></div>
                  <div className="session-progress"><strong>{scans.length}<span> / {games.length}</span></strong><span>scanned</span></div>
                  <button className="button button-light button-small" onClick={() => {
                    void navigator.clipboard.writeText(session.code)
                      .then(() => setNotice("Session code copied."))
                      .catch((copyError: Error) => setError(`Could not copy code: ${copyError.message}`));
                  }} type="button">Copy code</button>
                </div>
                <div className="scanner-panel">
                  <div className="scanner-topline">
                    <div><h3>Scan a game</h3></div>
                    <div className="player-field"><label htmlFor="player-name">YOUR NAME</label><input id="player-name" maxLength={40} placeholder="Player" value={playerName} onChange={(event) => savePlayerName(event.target.value)} /></div>
                  </div>
                  {scannerOpen ? (
                    <div className="camera-wrap">
                      <video ref={videoRef} className="camera-feed" muted playsInline />
                      <button className="button button-light button-small camera-close" onClick={() => setScannerOpen(false)} type="button">Stop camera</button>
                    </div>
                  ) : <button className="button button-primary" disabled={!games.length} onClick={() => setScannerOpen(true)} type="button">Open camera</button>}
                  <form className="manual-scan" onSubmit={(event) => { event.preventDefault(); void recordScan(manualUuid); }}>
                    <label htmlFor="manual-uuid">Or enter a game UUID</label>
                    <div className="input-action"><input id="manual-uuid" placeholder="Paste UUID here" value={manualUuid} onChange={(event) => setManualUuid(event.target.value)} /><button className="button button-outline button-small" disabled={!manualUuid.trim()} type="submit">Mark found</button></div>
                  </form>
                </div>
                <div className="scan-lists">
                  <div>
                    <div className="list-heading"><h3>Still on the shelf</h3><span className="list-count remaining-count">{remaining.length}</span></div>
                    {remaining.length ? <ul className="scan-list">{remaining.map((game) => <li key={game.id}><span className="scan-status pending" /><span>{game.name}</span></li>)}</ul> : <p className="list-empty">No unscanned games.</p>}
                  </div>
                  <div>
                    <div className="list-heading"><h3>Found</h3><span className="list-count found-count">{scans.length}</span></div>
                    {scans.length ? <ul className="scan-list">{scans.map((scan) => {
                      const game = games.find((entry) => entry.id === scan.game_id);
                      return game ? <li key={scan.game_id}><span className="scan-status found">✓</span><span>{game.name}<small> by {scan.scanned_by}</small></span></li> : null;
                    })}</ul> : <p className="list-empty">No scans yet.</p>}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
