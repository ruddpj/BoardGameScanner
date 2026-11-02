import { BarcodeFormat, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { DecodeHintType } from "@zxing/library";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Game = { id: string; name: string; copies: number };
type ScanSession = { id: string; code: string; created_at: string; saved_at?: string | null };
type Scan = { id: string; game_id: string; scanned_at: string };
type ScanPoint = { x: number; y: number };
type DetectedBarcode = {
  rawValue: string;
  cornerPoints?: ScanPoint[];
  boundingBox?: { x: number; y: number; width: number; height: number };
};
type NativeBarcodeDetector = { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> };
type NativeBarcodeDetectorConstructor = new(options?: { formats?: string[] }) => NativeBarcodeDetector;
type View = "collection" | "labels" | "session" | "past-sessions";
type FocusModeCapabilities = MediaTrackCapabilities & { focusMode?: string[] };
type FocusModeConstraintSet = MediaTrackConstraintSet & { focusMode?: ConstrainDOMString };
type FocusModeConstraints = MediaTrackConstraints & {
  focusMode?: ConstrainDOMString;
  advanced?: FocusModeConstraintSet[];
};

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

function isMissingCopiesColumn(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /column games\.copies does not exist/i.test(error.message ?? "")
  );
}

function isMissingSavedAtColumn(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /column scan_sessions\.saved_at does not exist/i.test(error.message ?? "")
  );
}

function readLocalGames(): Game[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (
      Array.isArray(stored) &&
      stored.every(
        (game) =>
          typeof game.id === "string" &&
          typeof game.name === "string" &&
          (game.copies === undefined ||
            (Number.isInteger(game.copies) && game.copies >= 1)),
      )
    ) {
      return stored.map((game) => ({
        id: game.id,
        name: game.name,
        copies: game.copies ?? 1,
      }));
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
  const [copyDrafts, setCopyDrafts] = useState<Record<string, string>>({});
  const [copyCountsAvailable, setCopyCountsAvailable] = useState(true);
  const [session, setSession] = useState<ScanSession | null>(null);
  const [pastSessions, setPastSessions] = useState<ScanSession[]>([]);
  const [loadingPastSessions, setLoadingPastSessions] = useState(false);
  const [sessionHistoryAvailable, setSessionHistoryAvailable] = useState(true);
  const [sessionInput, setSessionInput] = useState("");
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [authOpen, setAuthOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [scans, setScans] = useState<Scan[]>([]);
  const [lastScan, setLastScan] = useState<{ gameName: string; alreadyScanned: boolean } | null>(null);
  const [detectedGame, setDetectedGame] = useState<Game | null>(null);
  const [detectedPoints, setDetectedPoints] = useState<ScanPoint[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraResolution, setCameraResolution] = useState("");
  const [addingScan, setAddingScan] = useState(false);
  const [manualUuid, setManualUuid] = useState("");
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [creatingSession, setCreatingSession] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const scanBusyRef = useRef(false);
  const frozenRef = useRef(false);
  const gamesRef = useRef(games);
  gamesRef.current = games;
  const scansByGame = useMemo(
    () => scans.reduce((counts, scan) => {
      counts.set(scan.game_id, (counts.get(scan.game_id) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()),
    [scans],
  );
  const totalCopies = games.reduce((total, game) => total + game.copies, 0);
  const highlightedQr = useMemo(() => {
    if (detectedPoints.length < 3) return null;
    const xs = detectedPoints.map((point) => point.x);
    const ys = detectedPoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const paddingX = Math.max((maxX - minX) * 0.22, 12);
    const paddingY = Math.max((maxY - minY) * 0.22, 12);
    return {
      x: minX - paddingX,
      y: minY - paddingY,
      width: maxX - minX + paddingX * 2,
      height: maxY - minY + paddingY * 2,
    };
  }, [detectedPoints]);
  const remaining = games.filter(
    (game) => (scansByGame.get(game.id) ?? 0) < game.copies,
  );
  const canManage = !supabase || Boolean(authUser);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (sessionError) throw sessionError;
        if (active) setAuthUser(data.session?.user ?? null);
      })
      .catch((sessionError: Error) => {
        if (active) setError(`Could not check sign-in status: ${sessionError.message}`);
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, authSession) => {
      setAuthUser(authSession?.user ?? null);
      setAuthReady(true);
      if (!authSession) setAuthOpen(false);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const refreshGames = useCallback(async () => {
    if (!supabase) {
      setLoadingGames(false);
      return;
    }
    const { data, error: loadError } = await supabase
      .from("games")
      .select("id, name, copies")
      .order("name");
    if (loadError && isMissingCopiesColumn(loadError)) {
      setCopyCountsAvailable(false);
      const { data: legacyData, error: legacyError } = await supabase
        .from("games")
        .select("id, name")
        .order("name");
      if (legacyError) throw legacyError;
      setGames((legacyData ?? []).map((game) => ({ ...game, copies: 1 })));
      return;
    }
    if (loadError) throw loadError;
    setCopyCountsAvailable(true);
    setGames(data ?? []);
  }, []);

  const refreshScans = useCallback(async (sessionId: string) => {
    if (!supabase) return;
    const { data, error: scanError } = await supabase
      .from("scans")
      .select("id, game_id, scanned_at")
      .eq("session_id", sessionId)
      .order("scanned_at", { ascending: false });
    if (scanError) throw scanError;
    setScans(data ?? []);
  }, []);

  const refreshPastSessions = useCallback(async () => {
    if (!supabase) return;
    setLoadingPastSessions(true);
    try {
      const { data, error: historyError } = await supabase
        .from("scan_sessions")
        .select("id, code, created_at, saved_at")
        .not("saved_at", "is", null)
        .order("saved_at", { ascending: false });
      if (historyError && isMissingSavedAtColumn(historyError)) {
        setSessionHistoryAvailable(false);
        setPastSessions([]);
        return;
      }
      if (historyError) throw historyError;
      setSessionHistoryAvailable(true);
      setPastSessions(data ?? []);
    } finally {
      setLoadingPastSessions(false);
    }
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
          event: "UPDATE",
          schema: "public",
          table: "scan_sessions",
          filter: `id=eq.${session.id}`,
        },
        (payload) => {
          const updatedSession = payload.new as Partial<ScanSession>;
          if (updatedSession.saved_at) {
            setSession((current) =>
              current?.id === session.id
                ? { ...current, saved_at: updatedSession.saved_at }
                : current,
            );
            setScannerOpen(false);
          }
        },
      )
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
    if (view !== "past-sessions" || !supabase) return;
    void refreshPastSessions().catch((historyError: Error) => {
      setError(`Could not load past sessions: ${historyError.message}`);
    });
  }, [refreshPastSessions, view]);

  useEffect(() => {
    if (!scannerOpen || !videoRef.current) return;
    const cameraVideoConstraints: FocusModeConstraints = {
      facingMode: { ideal: "environment" },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
      focusMode: { ideal: "continuous" },
    };
    let active = true;
    let nativeScanTimer: number | null = null;
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: cameraVideoConstraints,
        });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        cameraStreamRef.current = stream;
        videoRef.current!.srcObject = stream;
        await videoRef.current!.play();
        const videoTrack = stream.getVideoTracks()[0];
        const videoCapabilities = videoTrack && typeof videoTrack.getCapabilities === "function"
          ? videoTrack.getCapabilities()
          : undefined;
        const settings = videoTrack?.getSettings();
        setCameraResolution(settings?.width && settings.height
          ? `${settings.width} × ${settings.height}`
          : "");
        const focusModes = videoCapabilities as FocusModeCapabilities | undefined;
        if (videoTrack && focusModes?.focusMode?.includes("continuous")) {
          await videoTrack.applyConstraints({
            advanced: [{ focusMode: "continuous" }],
          } as FocusModeConstraints).catch((focusError: Error) => {
            if (active) setError(`Could not enable continuous autofocus: ${focusError.message}`);
          });
        }
        const acceptDetection = (rawValue: string, points: ScanPoint[] = []) => {
          if (!active || frozenRef.current) return;
          const decodedText = rawValue.trim().toLowerCase();
          const game = gamesRef.current.find((entry) => entry.id.toLowerCase() === decodedText) ?? null;
          if (!game) return;
          frozenRef.current = true;
          videoRef.current?.pause();
          setDetectedGame(game);
          setDetectedPoints(points);
        };
        const startZxingFallback = () => {
          const reader = new BrowserMultiFormatReader(new Map<DecodeHintType, boolean | BarcodeFormat[]>([
            [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
            [DecodeHintType.TRY_HARDER, true],
          ]), {
            delayBetweenScanAttempts: 100,
            delayBetweenScanSuccess: 100,
          });
          void reader.decodeFromVideoElement(videoRef.current!, (result) => {
            if (!result) return;
            acceptDetection(result.getText(), result.getResultPoints().map((point) => ({
              x: point.getX(),
              y: point.getY(),
            })));
          }).then((controls) => {
            if (active) {
              scannerControlsRef.current = controls;
              setCameraReady(true);
            } else {
              controls.stop();
            }
          }).catch((scanError: Error) => {
            if (active) setError(`Could not start continuous scanning: ${scanError.message}`);
          });
        };
        const NativeDetector = (window as Window & {
          BarcodeDetector?: NativeBarcodeDetectorConstructor;
        }).BarcodeDetector;
        if (NativeDetector) {
          try {
            const detector = new NativeDetector({ formats: ["qr_code"] });
            const scanNativeFrame = async () => {
              if (!active) return;
              if (!frozenRef.current && videoRef.current?.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
                try {
                  const barcodes = await detector.detect(videoRef.current);
                  for (const barcode of barcodes) {
                    const box = barcode.boundingBox;
                    const points = barcode.cornerPoints?.length
                      ? barcode.cornerPoints
                      : box
                        ? [
                            { x: box.x, y: box.y },
                            { x: box.x + box.width, y: box.y },
                            { x: box.x + box.width, y: box.y + box.height },
                            { x: box.x, y: box.y + box.height },
                          ]
                        : [];
                    acceptDetection(barcode.rawValue, points);
                    if (frozenRef.current) break;
                  }
                } catch (detectorError) {
                  if (active) {
                    setError(`Native QR scanner unavailable; using compatibility scanner: ${(detectorError as Error).message}`);
                    startZxingFallback();
                  }
                  return;
                }
              }
              if (active) nativeScanTimer = window.setTimeout(() => void scanNativeFrame(), 100);
            };
            setCameraReady(true);
            void scanNativeFrame();
          } catch (detectorError) {
            setError(`Native QR scanner unavailable; using compatibility scanner: ${(detectorError as Error).message}`);
            startZxingFallback();
          }
        } else {
          startZxingFallback();
        }
      } catch (cameraError) {
        if (active) setError(`Could not start camera: ${(cameraError as Error).message}`);
      }
    };
    void startCamera();
    return () => {
      active = false;
      setCameraReady(false);
      setCameraResolution("");
      setDetectedGame(null);
      setDetectedPoints([]);
      frozenRef.current = false;
      if (nativeScanTimer !== null) window.clearTimeout(nativeScanTimer);
      scannerControlsRef.current?.stop();
      scannerControlsRef.current = null;
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [scannerOpen]);

  async function addGames(names: string[]) {
    if (supabase && !authUser) {
      setAuthOpen(true);
      throw new Error("Sign in with Supabase to add games.");
    }
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
      .map((name) => ({ id: makeUuid(), name, copies: 1 }));
    if (!additions.length) {
      setNotice("Those games are already in your collection.");
      return;
    }
    if (supabase) {
      const { error: insertError } = await supabase.from("games").insert(additions);
      if (insertError && isMissingCopiesColumn(insertError)) {
        setCopyCountsAvailable(false);
        const { error: legacyInsertError } = await supabase
          .from("games")
          .insert(additions.map(({ id, name }) => ({ id, name })));
        if (legacyInsertError) throw legacyInsertError;
      } else if (insertError) {
        throw insertError;
      }
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
    if (supabase && !authUser) {
      setAuthOpen(true);
      return;
    }
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

  async function deletePastSession(pastSession: ScanSession) {
    if (!supabase || !authUser || !pastSession.saved_at) return;
    if (!window.confirm(`Permanently delete session ${pastSession.code} and its scan results?`)) return;
    setError("");
    try {
      const { error: deleteError } = await supabase
        .from("scan_sessions")
        .delete()
        .eq("id", pastSession.id)
        .not("saved_at", "is", null);
      if (deleteError) throw deleteError;
      setPastSessions((current) => current.filter((entry) => entry.id !== pastSession.id));
      setNotice(`Session ${pastSession.code} deleted.`);
    } catch (deleteError) {
      setError(`Could not delete session: ${(deleteError as Error).message}`);
    }
  }

  async function updateGameCopies(game: Game, copies: number) {
    if (supabase && !authUser) {
      setAuthOpen(true);
      return;
    }
    setError("");
    try {
      if (supabase) {
        const { error: updateError } = await supabase
          .from("games")
          .update({ copies })
          .eq("id", game.id);
        if (updateError) throw updateError;
      }
      setGames((current) =>
        current.map((entry) => (entry.id === game.id ? { ...entry, copies } : entry)),
      );
      setCopyDrafts((current) => {
        const remainingDrafts = { ...current };
        delete remainingDrafts[game.id];
        return remainingDrafts;
      });
      setNotice(`${game.name}: copy count updated to ${copies}.`);
    } catch (updateError) {
      setError(`Could not update copy count: ${(updateError as Error).message}`);
    }
  }

  async function createSession() {
    if (!supabase) return;
    if (!authUser) {
      setAuthOpen(true);
      return;
    }
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
      setLastScan(null);
      setView("session");
      setNotice("Session created. Share the four-letter code with your players.");
    } catch (createError) {
      setError(`Could not create session: ${(createError as Error).message}`);
    } finally {
      setCreatingSession(false);
    }
  }

  async function saveSession() {
    if (!supabase || !session || session.saved_at) return;
    if (!authUser) {
      setAuthOpen(true);
      return;
    }
    setError("");
    try {
      const savedAt = new Date().toISOString();
      const { data, error: saveError } = await supabase
        .from("scan_sessions")
        .update({ saved_at: savedAt })
        .eq("id", session.id)
        .is("saved_at", null)
        .select("id, code, created_at, saved_at")
        .maybeSingle();
      if (saveError) {
        if (isMissingSavedAtColumn(saveError)) {
          throw new Error("Run the updated Supabase schema to enable saving session history.");
        }
        throw saveError;
      }
      let savedSession = data;
      if (!savedSession) {
        const { data: existingSession, error: existingError } = await supabase
          .from("scan_sessions")
          .select("id, code, created_at, saved_at")
          .eq("id", session.id)
          .single();
        if (existingError) throw existingError;
        savedSession = existingSession;
      }
      setSession(savedSession);
      setScannerOpen(false);
      await refreshPastSessions();
      setNotice(`Session ${session.code} saved.`);
    } catch (saveError) {
      setError(`Could not save session: ${(saveError as Error).message}`);
    }
  }

  function openPastSession(pastSession: ScanSession) {
    setSession(pastSession);
    setLastScan(null);
    setView("session");
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true);
    setAuthError("");
    setError("");
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: authEmail.trim(),
        password: authPassword,
      });
      if (signInError) throw signInError;
      setAuthUser(data.user);
      setAuthPassword("");
      setAuthOpen(false);
      setAuthError("");
      setNotice("Signed in. Game management and session creation are enabled.");
    } catch (signInError) {
      setAuthError(`Could not sign in: ${(signInError as Error).message}`);
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    setError("");
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setError(`Could not sign out: ${signOutError.message}`);
      return;
    }
    setAuthUser(null);
    setNotice("Signed out. Visitors can still join and scan sessions.");
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
      let { data, error: joinError } = await supabase
        .from("scan_sessions")
        .select("id, code, created_at, saved_at")
        .eq("code", code)
        .maybeSingle();
      if (joinError && isMissingSavedAtColumn(joinError)) {
        setSessionHistoryAvailable(false);
        const legacyResult = await supabase
          .from("scan_sessions")
          .select("id, code, created_at")
          .eq("code", code)
          .maybeSingle();
        data = legacyResult.data
          ? { ...legacyResult.data, saved_at: null }
          : null;
        joinError = legacyResult.error;
      }
      if (joinError) throw joinError;
      if (!data) {
        setError("No active session found for that code.");
        return;
      }
      setSession(data);
      setLastScan(null);
      setView("session");
      setNotice(`Joined session ${data.code}.`);
    } catch (joinError) {
      setError(`Could not join session: ${(joinError as Error).message}`);
    }
  }

  async function recordScan(rawValue: string): Promise<boolean> {
    if (!supabase || !session || session.saved_at || scanBusyRef.current) return false;
    const id = rawValue.trim().toLowerCase();
    const game = games.find((entry) => entry.id.toLowerCase() === id);
    if (!game) {
      setError(`No game matches QR value "${rawValue}".`);
      return false;
    }
    const alreadyScanned = (scansByGame.get(game.id) ?? 0) > 0;
    scanBusyRef.current = true;
    setAddingScan(true);
    setError("");
    try {
      const { error: insertError } = await supabase.from("scans").insert({
        session_id: session.id,
        game_id: game.id,
      });
      if (insertError) throw insertError;
      setLastScan({ gameName: game.name, alreadyScanned });
      setNotice(alreadyScanned ? `${game.name} scanned again.` : `${game.name} scanned.`);
      setManualUuid("");
      await refreshScans(session.id);
      return true;
    } catch (scanError) {
      setError(`Could not save scan: ${(scanError as Error).message}`);
      return false;
    } finally {
      scanBusyRef.current = false;
      setAddingScan(false);
    }
  }

  async function addDetectedGame() {
    if (!detectedGame || addingScan) return;
    if (!(await recordScan(detectedGame.id))) return;
    try {
      await videoRef.current?.play();
    } catch (cameraError) {
      setError(`Could not resume camera after scan: ${(cameraError as Error).message}`);
      return;
    }
    frozenRef.current = false;
    setDetectedGame(null);
    setDetectedPoints([]);
  }

  async function changeSavedScanCount(game: Game, delta: number) {
    if (!supabase || !authUser || !session?.saved_at || scanBusyRef.current) return;
    const gameScans = scans.filter((scan) => scan.game_id === game.id);
    if (delta < 0 && !gameScans.length) return;
    scanBusyRef.current = true;
    setError("");
    try {
      if (delta > 0) {
        const { error: insertError } = await supabase.from("scans").insert(
          Array.from({ length: delta }, () => ({
            session_id: session.id,
            game_id: game.id,
          })),
        );
        if (insertError) throw insertError;
      } else {
        const { error: deleteError } = await supabase
          .from("scans")
          .delete()
          .eq("session_id", session.id)
          .eq("id", gameScans[0].id);
        if (deleteError) throw deleteError;
      }
      await refreshScans(session.id);
      setNotice(`${game.name} count updated.`);
    } catch (scanError) {
      setError(`Could not update saved session: ${(scanError as Error).message}`);
    } finally {
      scanBusyRef.current = false;
    }
  }

  async function removeGameFromSavedSession(game: Game) {
    if (!supabase || !authUser || !session?.saved_at || scanBusyRef.current) return;
    if (!window.confirm(`Remove all ${scansByGame.get(game.id) ?? 0} scans of "${game.name}" from this session?`)) return;
    scanBusyRef.current = true;
    setError("");
    try {
      const { error: deleteError } = await supabase
        .from("scans")
        .delete()
        .eq("session_id", session.id)
        .eq("game_id", game.id);
      if (deleteError) throw deleteError;
      await refreshScans(session.id);
      setNotice(`${game.name} removed from the session.`);
    } catch (scanError) {
      setError(`Could not remove game from saved session: ${(scanError as Error).message}`);
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
            color: { dark: "#000000", light: "#ffffff" },
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
          {supabase && authUser ? (
            <>
              <span className="account-email">{authUser.email}</span>
              <button className="button button-outline button-small" disabled={!authReady} onClick={() => void signOut()} type="button">Sign out</button>
            </>
          ) : supabase ? (
            <button className="button button-outline button-small" disabled={!authReady} onClick={() => setAuthOpen(true)} type="button">
              {authReady ? "Sign in" : "Checking…"}
            </button>
          ) : null}
        </div>
      </header>

      {authOpen && (
        <div className="auth-backdrop">
          <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <div className="auth-dialog-heading">
              <h2 id="auth-title">Admin sign in</h2>
              <button className="icon-button" aria-label="Close sign-in dialog" onClick={() => setAuthOpen(false)} type="button">×</button>
            </div>
            <p>Sign in to manage games or create and finish sessions. Joining and scanning do not require an account.</p>
            {authError && <p className="auth-error" role="alert">{authError}</p>}
            <form onSubmit={(event) => void signIn(event)}>
              <label htmlFor="auth-email">Email</label>
              <input autoComplete="username" id="auth-email" type="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} />
              <label htmlFor="auth-password">Password</label>
              <input autoComplete="current-password" id="auth-password" type="password" required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} />
              <button className="button button-primary full-width" disabled={authBusy || !authReady} type="submit">{authBusy ? "Signing in…" : "Sign in"}</button>
            </form>
          </section>
        </div>
      )}

      <main className="main-content">
        <nav className="tabs" aria-label="Main navigation">
          {([
            ["collection", "Games", games.length],
            ["labels", "QR codes", null],
            ["session", "Scan session", null],
            ["past-sessions", "Past sessions", pastSessions.length || null],
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
            {!copyCountsAvailable && (
              <div className="schema-warning" role="status">
                Copy counts are not enabled in the database yet. Run the updated{" "}
                <a href="https://github.com/ruddpj/BoardGameScanner/blob/main/supabase/schema.sql" target="_blank" rel="noreferrer">Supabase schema</a>
                {" "}to edit counts. Existing games remain available and default to one copy.
              </div>
            )}
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
                      {canManage ? <form className="copy-count-form" onSubmit={(event) => {
                        event.preventDefault();
                        const input = new FormData(event.currentTarget).get("copies");
                        const copies = Number(input);
                        if (!Number.isInteger(copies) || copies < 1) {
                          setError("Copy count must be a whole number greater than zero.");
                          return;
                        }
                        if (copies !== game.copies) void updateGameCopies(game, copies);
                      }}>
                        <label className="copy-count-label" htmlFor={`copies-${game.id}`}>Copies</label>
                        <input
                          id={`copies-${game.id}`}
                          aria-label={`Copies of ${game.name}`}
                          name="copies"
                          type="number"
                          min="1"
                          step="1"
                          disabled={!copyCountsAvailable || !canManage}
                          value={copyDrafts[game.id] ?? String(game.copies)}
                          onChange={(event) => setCopyDrafts((current) => ({
                            ...current,
                            [game.id]: event.target.value,
                          }))}
                        />
                        <button
                          className="button button-outline button-small"
                          disabled={!copyCountsAvailable || !canManage || (copyDrafts[game.id] ?? String(game.copies)) === String(game.copies)}
                          type="submit"
                        >Save</button>
                      </form> : <span className="copy-count-readonly" aria-label={`${game.copies} copies`}>{game.copies}×</span>}
                      {canManage ? (
                        <button className="icon-button" onClick={() => void removeGame(game)} title={`Remove ${game.name}`} type="button">×</button>
                      ) : <span className="game-row-spacer" aria-hidden="true" />}
                    </article>
                  ))
                )}
              </div>
              <aside className="add-panel">
                {canManage ? (
                  <>
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
                  </>
                ) : (
                  <div className="manage-prompt">
                    <h3>Manage games</h3>
                    <p>Sign in to add, edit, or remove games.</p>
                    <button className="button button-primary" onClick={() => setAuthOpen(true)} type="button">Sign in</button>
                  </div>
                )}
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
                    <strong className="qr-game-name">{game.name}</strong>
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

        {view === "past-sessions" && (
          <section className="workspace">
            <div className="section-heading">
              <h2>Past sessions <span className="heading-count">{pastSessions.length}</span></h2>
            </div>
            {!supabase ? (
              <div className="empty-state"><h3>Shared sessions need Supabase</h3></div>
            ) : !sessionHistoryAvailable ? (
              <div className="schema-warning" role="status">
                Session history is not enabled in the database yet. Run the updated{" "}
                <a href="https://github.com/ruddpj/BoardGameScanner/blob/main/supabase/schema.sql" target="_blank" rel="noreferrer">Supabase schema</a>
                {" "}to save and view past sessions.
              </div>
            ) : loadingPastSessions ? (
              <p className="muted">Loading sessions…</p>
            ) : pastSessions.length ? (
              <div className="past-session-list">
                {pastSessions.map((pastSession) => (
                  <article className="past-session-row" key={pastSession.id}>
                    <div className="past-session-code">{pastSession.code}</div>
                    <div className="past-session-info">
                      <strong>Saved session</strong>
                      <span>{pastSession.saved_at ? new Date(pastSession.saved_at).toLocaleString() : ""}</span>
                    </div>
                    <button className="button button-outline button-small" onClick={() => openPastSession(pastSession)} type="button">View</button>
                    {authUser && (
                      <button
                        className="button button-danger button-small"
                        onClick={() => void deletePastSession(pastSession)}
                        type="button"
                      >Delete</button>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state"><h3>No saved sessions</h3></div>
            )}
          </section>
        )}

        {view === "session" && (
          <section className="workspace">
            <div className="section-heading">
              <h2>Scan session</h2>
              {session && (
                <div className="session-actions">
                  {session.saved_at ? (
                    <span className="saved-badge">Saved {new Date(session.saved_at).toLocaleString()}</span>
                  ) : authUser ? (
                    <button className="button button-primary button-small" onClick={() => void saveSession()} type="button">Finish session</button>
                  ) : (
                    <button className="button button-outline button-small" onClick={() => setAuthOpen(true)} type="button">Sign in to finish</button>
                  )}
                  <button className="button button-outline button-small" onClick={() => { setSession(null); setScans([]); setView("past-sessions"); }} type="button">
                    {session.saved_at ? "Back to past sessions" : "Leave session"}
                  </button>
                </div>
              )}
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
                  {authUser ? (
                    <button className="button button-primary full-width" disabled={creatingSession || !authReady} onClick={() => void createSession()} type="button">{creatingSession ? "Creating…" : "Create session"}</button>
                  ) : (
                    <>
                      <p>Sign in to start a new session.</p>
                      <button className="button button-outline full-width" disabled={!authReady} onClick={() => setAuthOpen(true)} type="button">Sign in to create</button>
                    </>
                  )}
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
                  <div className="session-progress"><strong>{scans.length}<span> / {totalCopies}</span></strong><span>copies scanned</span></div>
                  <button className="button button-light button-small" onClick={() => {
                    void navigator.clipboard.writeText(session.code)
                      .then(() => setNotice("Session code copied."))
                      .catch((copyError: Error) => setError(`Could not copy code: ${copyError.message}`));
                  }} type="button">Copy code</button>
                </div>
                <div className="scanner-panel">
                  <div className="scanner-topline">
                    <div><h3>Scan a game</h3></div>
                  </div>
                  {session.saved_at ? (
                    <p className="saved-session-note">
                      {authUser
                        ? "Finished session. Adjust game counts below; signed-in managers can add or remove games."
                        : "This session is finished and read-only. Sign in to edit its games."}
                    </p>
                  ) : scannerOpen ? (
                    <>
                      <div className="camera-wrap">
                        <video ref={videoRef} className="camera-feed" muted playsInline />
                        {detectedGame && highlightedQr && videoRef.current?.videoWidth && videoRef.current.videoHeight && (
                          <svg
                            className="qr-highlight"
                            viewBox={`0 0 ${videoRef.current.videoWidth} ${videoRef.current.videoHeight}`}
                            preserveAspectRatio="xMidYMid meet"
                            aria-hidden="true"
                          >
                            <rect
                              x={highlightedQr.x}
                              y={highlightedQr.y}
                              width={highlightedQr.width}
                              height={highlightedQr.height}
                              rx="12"
                            />
                            <polygon points={detectedPoints.map((point) => `${point.x},${point.y}`).join(" ")} />
                            {detectedPoints.map((point, index) => (
                              <circle key={index} cx={point.x} cy={point.y} r="18" />
                            ))}
                          </svg>
                        )}
                        <button className="button button-light button-small camera-close" onClick={() => setScannerOpen(false)} type="button">Stop camera</button>
                      </div>
                      <p className="camera-tip">
                        {cameraReady
                          ? detectedGame
                            ? `Image frozen${cameraResolution ? ` at ${cameraResolution}` : ""}. Confirm the highlighted QR, then add it.`
                            : `Scanning continuously${cameraResolution ? ` at ${cameraResolution}` : ""}. Keep the code in view until it is recognized.`
                          : "Starting camera…"}
                      </p>
                      <button
                        className={`button scan-add-button${detectedGame ? " scan-add-ready" : ""}`}
                        disabled={!cameraReady || !detectedGame || addingScan}
                        onClick={() => void addDetectedGame()}
                        type="button"
                      >
                        {addingScan ? "Adding…" : detectedGame ? `Add ${detectedGame.name}` : "Waiting for QR code"}
                      </button>
                    </>
                  ) : <button className="button button-primary" disabled={!games.length} onClick={() => setScannerOpen(true)} type="button">Open camera</button>}
                  {lastScan && (
                    <div className={`scan-confirmation ${lastScan.alreadyScanned ? "scan-confirmation-repeat" : ""}`} role="status">
                      <span className="scan-confirmation-icon">✓</span>
                      <span>{lastScan.alreadyScanned ? "Additional copy logged" : "QR scanned"}: <strong>{lastScan.gameName}</strong></span>
                    </div>
                  )}
                  {!session.saved_at && <form className="manual-scan" onSubmit={(event) => { event.preventDefault(); void recordScan(manualUuid); }}>
                    <label htmlFor="manual-uuid">Or enter a game UUID</label>
                    <div className="input-action"><input id="manual-uuid" placeholder="Paste UUID here" value={manualUuid} onChange={(event) => setManualUuid(event.target.value)} /><button className="button button-outline button-small" disabled={!manualUuid.trim()} type="submit">Mark found</button></div>
                  </form>}
                </div>
                <div className="scan-lists">
                  <div>
                    <div className="list-heading"><h3>Still on the shelf</h3><span className="list-count remaining-count">{remaining.length}</span></div>
                    {remaining.length ? <ul className="scan-list">{remaining.map((game) => {
                      const remainingCopies = game.copies - (scansByGame.get(game.id) ?? 0);
                      return <li key={game.id}><span className="scan-status pending" /><span>{game.name}<small>{remainingCopies} of {game.copies} copies remaining</small></span></li>;
                    })}</ul> : <p className="list-empty">No unscanned games.</p>}
                  </div>
                  <div>
                    <div className="list-heading"><h3>{session.saved_at && authUser ? "Session games" : "Found"}</h3><span className="list-count found-count">{scans.length}</span></div>
                    {(session.saved_at && authUser ? games : games.filter((game) => scansByGame.has(game.id))).length ? <ul className="scan-list">{(session.saved_at && authUser ? games : games.filter((game) => scansByGame.has(game.id))).map((game) => {
                      const scannedCopies = scansByGame.get(game.id) ?? 0;
                      return <li className={session.saved_at && authUser ? "session-game-row" : ""} key={game.id}>
                        <span className={`scan-status ${scannedCopies ? "found" : "pending"}`}>{scannedCopies ? "✓" : ""}</span>
                        <span className="session-game-name">{game.name}<small>{scannedCopies} scan{scannedCopies === 1 ? "" : "s"} logged · {game.copies} listed {game.copies === 1 ? "copy" : "copies"}</small></span>
                        {session.saved_at && authUser && (
                          <div className="session-game-actions" aria-label={`${game.name} scan count`}>
                            <button
                              className="button button-outline button-small"
                              disabled={!scannedCopies}
                              onClick={() => void changeSavedScanCount(game, -1)}
                              title="Remove one scan"
                              type="button"
                            >−</button>
                            <button
                              className="button button-outline button-small"
                              onClick={() => void changeSavedScanCount(game, 1)}
                              title="Add one scan"
                              type="button"
                            >+</button>
                            {scannedCopies > 0 && (
                              <button
                                className="button button-danger button-small"
                                onClick={() => void removeGameFromSavedSession(game)}
                                type="button"
                              >Remove</button>
                            )}
                          </div>
                        )}
                      </li>;
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
