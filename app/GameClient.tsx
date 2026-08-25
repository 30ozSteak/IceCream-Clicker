"use client";

/* Local, already-optimized game assets intentionally use ordinary images so
   portrait crop geometry and mouth targeting share the exact rendered box. */
/* eslint-disable @next/next/no-img-element */

import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  calculateCoverGeometry,
  type CoverGeometry,
  normalizedImagePointToStage,
  stagePointToNormalizedImage,
} from "../lib/client/portrait-geometry";

const FatboyProjectile = dynamic(
  () =>
    import("./FatboyProjectile").then((module) => module.FatboyProjectile),
  { ssr: false },
);

type MouthTarget = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};

type Portrait = {
  id: string;
  src: string;
  alt: string;
  mouth: MouthTarget;
};

type PortraitPreview = Omit<Portrait, "mouth">;

type Player = {
  nickname: string | null;
  publicTag: string;
  displayName: string;
  sandwichesFed: number;
  sandwichesRemaining: number;
  scoreVersion: number;
};

type Round = {
  current: Portrait;
  next: PortraitPreview;
  token: string;
};

type GameResponse = {
  player: Player;
  round: Round;
};

type Leader = {
  rank: number;
  displayName: string;
  sandwichesFed: number;
};

type LeaderboardResponse = {
  leaders: Leader[];
  globalTotal: number;
  asOf: string;
};

type ApiGameResponse = {
  player: Player;
  round:
    | {
        current: Portrait;
        next: PortraitPreview;
        token: string;
      }
    | {
        currentPortrait: Portrait;
        nextPortrait: PortraitPreview;
        roundToken: string;
        expiresAtMs?: number;
      };
};

type FeedOutcome = "hit" | "miss";

type ApiFeedResponse = ApiGameResponse & {
  outcome: FeedOutcome;
};

type ApiPackReloadStartResponse = {
  reload: {
    token: string;
    durationMs: number;
    activeStartMs: number;
    activeEndMs: number;
  };
};

type ReloadAttempt = "none" | "missed" | "perfect";

type ReloadSession = ApiPackReloadStartResponse["reload"] & {
  startedAt: number;
  autoCompleteAtMs: number;
};

type ActiveReloadStyle = CSSProperties & {
  "--reload-progress": string;
  "--reload-zone-start": string;
  "--reload-zone-width": string;
};

type ApiLeaderboardResponse = {
  leaders: Array<{
    rank?: number;
    position?: number;
    displayName: string;
    publicTag?: string;
    sandwichesFed: number;
  }>;
  globalTotal: number;
  asOf?: string;
  generatedAtMs?: number;
  cachedUntilMs?: number;
};

type Notice = {
  message: string;
  tone: "info" | "success" | "miss" | "error";
};

type SandwichSplat = {
  id: number;
  x: number;
  y: number;
};

const numberFormatter = new Intl.NumberFormat("en-US");
const nicknamePattern = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function normalizeNickname(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function validateNickname(value: string) {
  const normalized = normalizeNickname(value);

  const characterCount = Array.from(normalized).length;
  if (characterCount < 2 || characterCount > 16) {
    return "Use 2–16 letters, numbers, and spaces.";
  }

  if (!nicknamePattern.test(normalized)) {
    return "Use letters, numbers, and single spaces only.";
  }

  return null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function readErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: string };
      message?: string;
    };
    if (body.message) {
      return body.message;
    }
    if (typeof body.error === "string") {
      return body.error;
    }
    return body.error?.message ?? "That request could not be completed.";
  } catch {
    return "That request could not be completed.";
  }
}

function normalizeGameResponse(data: ApiGameResponse): GameResponse {
  if ("current" in data.round) {
    return {
      player: data.player,
      round: {
        current: data.round.current,
        next: data.round.next,
        token: data.round.token,
      },
    };
  }

  return {
    player: data.player,
    round: {
      current: data.round.currentPortrait,
      next: data.round.nextPortrait,
      token: data.round.roundToken,
    },
  };
}

function normalizeFeedResponse(data: ApiFeedResponse): {
  game: GameResponse;
  outcome: FeedOutcome;
} {
  if (data.outcome !== "hit" && data.outcome !== "miss") {
    throw new Error("The throw response did not include a valid outcome.");
  }

  return {
    game: normalizeGameResponse(data),
    outcome: data.outcome,
  };
}

function createReloadSession(
  data: ApiPackReloadStartResponse,
  requestStartedAt: number,
  responseReceivedAt: number,
): ReloadSession {
  const { reload } = data;
  if (
    !reload ||
    typeof reload.token !== "string" ||
    reload.token.length === 0 ||
    !Number.isFinite(reload.durationMs) ||
    reload.durationMs <= 0 ||
    !Number.isFinite(reload.activeStartMs) ||
    reload.activeStartMs < 0 ||
    !Number.isFinite(reload.activeEndMs) ||
    reload.activeEndMs <= reload.activeStartMs ||
    reload.activeEndMs > reload.durationMs
  ) {
    throw new Error("The reload response did not include valid timing data.");
  }

  const roundTripMs = Math.max(0, responseReceivedAt - requestStartedAt);
  const estimatedElapsedMs = Math.min(reload.durationMs, roundTripMs / 2);
  return {
    ...reload,
    startedAt: responseReceivedAt - estimatedElapsedMs,
    autoCompleteAtMs: reload.durationMs,
  };
}

function getReloadSuccessMessage(treats: number) {
  if (treats === 7) {
    return "Perfect reload! Bonus treat added — seven ready.";
  }
  return `Fresh pack opened. ${numberFormatter.format(treats)} treats ready!`;
}

function normalizeLeaderboardResponse(
  data: ApiLeaderboardResponse,
): LeaderboardResponse {
  return {
    leaders: data.leaders.map((leader, index) => ({
      rank: leader.rank ?? leader.position ?? index + 1,
      displayName: leader.displayName,
      sandwichesFed: leader.sandwichesFed,
    })),
    globalTotal: data.globalTotal,
    asOf:
      data.asOf ??
      new Date(data.generatedAtMs ?? Date.now()).toISOString(),
  };
}

async function fetchGame() {
  const data = await requestJson<ApiGameResponse>("/api/game", {
    cache: "no-store",
  });
  return normalizeGameResponse(data);
}

async function fetchLeaderboard() {
  const data = await requestJson<ApiLeaderboardResponse>("/api/leaderboard", {
    cache: "no-store",
  });
  return normalizeLeaderboardResponse(data);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  return (await response.json()) as T;
}

function getFriendlyError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }

  return "We couldn’t reach the game. Check your connection and try again.";
}

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return reducedMotion;
}

function LeaderboardContents({
  leaders,
  currentDisplayName,
  loading,
}: {
  leaders: Leader[];
  currentDisplayName: string | null;
  loading: boolean;
}) {
  if (loading) {
    return <p className="leaderboard-status">Loading…</p>;
  }

  if (leaders.length === 0) {
    return <p className="leaderboard-status">No scores yet.</p>;
  }

  return (
    <ol className="leader-list" aria-label="Top ten FatBoy feeders">
      {leaders.map((leader) => {
        const isCurrentPlayer = leader.displayName === currentDisplayName;
        return (
          <li
            className={isCurrentPlayer ? "leader-row leader-row-current" : "leader-row"}
            key={`${leader.rank}-${leader.displayName}`}
            aria-current={isCurrentPlayer ? "true" : undefined}
          >
            <span className="leader-rank">{leader.rank}</span>
            <span className="leader-name" title={leader.displayName}>
              {leader.displayName}
            </span>
            <strong className="leader-score">
              {numberFormatter.format(leader.sandwichesFed)}
            </strong>
          </li>
        );
      })}
    </ol>
  );
}

function NicknameDialog({
  value,
  error,
  saving,
  offline,
  onChange,
  onSubmit,
}: {
  value: string;
  error: string | null;
  saving: boolean;
  offline: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="plain-dialog-backdrop" role="presentation">
      <section
        className="plain-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nickname-title"
        aria-describedby="nickname-description"
      >
        <h2 id="nickname-title">Choose a name.</h2>
        <p id="nickname-description">
          Progress stays on this browser. We’ll add a four-character tag.
        </p>

        <form onSubmit={onSubmit} noValidate>
          <label className="sr-only" htmlFor="nickname-input">Nickname</label>
          <input
            className="plain-name-input"
            id="nickname-input"
            name="nickname"
            type="text"
            value={value}
            onChange={(event) =>
              onChange(Array.from(event.target.value).slice(0, 24).join(""))
            }
            minLength={2}
            maxLength={24}
            pattern="[\p{L}\p{N} ]+"
            autoComplete="nickname"
            autoCapitalize="words"
            autoFocus
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "nickname-error" : "nickname-hint"}
            placeholder="Your nickname"
            disabled={saving}
          />
          <small id="nickname-hint">
            {saving ? "Saving…" : "2–16 letters, numbers, and spaces · press Enter"}
          </small>
          {error ? (
            <p className="form-error" id="nickname-error" role="alert">
              {error}
            </p>
          ) : null}
          {offline ? (
            <p className="form-error" role="status">
              Reconnect to save your nickname.
            </p>
          ) : null}

          <div className="plain-actions">
            <button
              className="text-action"
              type="submit"
              disabled={saving || offline}
            >
              {saving ? "saving…" : "start"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function GameClient() {
  const [game, setGame] = useState<GameResponse | null>(null);
  const [displayPortrait, setDisplayPortrait] = useState<
    Portrait | PortraitPreview | null
  >(null);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [globalTotal, setGlobalTotal] = useState<number | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [streak, setStreak] = useState(0);
  const [isFeeding, setIsFeeding] = useState(false);
  const [isStartingReload, setIsStartingReload] = useState(false);
  const [isCompletingReload, setIsCompletingReload] = useState(false);
  const [reloadSession, setReloadSession] = useState<ReloadSession | null>(null);
  const [reloadElapsedMs, setReloadElapsedMs] = useState(0);
  const [reloadAttempt, setReloadAttempt] = useState<ReloadAttempt>("none");
  const [threeProjectileReady, setThreeProjectileReady] = useState(false);
  const [shotUsesThree, setShotUsesThree] = useState(false);
  const [geometry, setGeometry] = useState<CoverGeometry | null>(null);
  const [sandwichTarget, setSandwichTarget] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [sandwichSplat, setSandwichSplat] = useState<SandwichSplat | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [nicknameInput, setNicknameInput] = useState("");
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [savingNickname, setSavingNickname] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const portraitImageRef = useRef<HTMLImageElement>(null);
  const feedLockRef = useRef(false);
  const packLockRef = useRef(false);
  const reloadSessionRef = useRef<ReloadSession | null>(null);
  const reloadAttemptRef = useRef<ReloadAttempt>("none");
  const reloadFrameRef = useRef<number | null>(null);
  const reloadGenerationRef = useRef(0);
  const splatIdRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const isOpeningPack = isStartingReload || isCompletingReload;

  const cancelReloadWork = useCallback(() => {
    reloadGenerationRef.current += 1;
    if (reloadFrameRef.current !== null) {
      window.cancelAnimationFrame(reloadFrameRef.current);
      reloadFrameRef.current = null;
    }
    reloadSessionRef.current = null;
    reloadAttemptRef.current = "none";
    packLockRef.current = false;
  }, []);

  const resetReloadState = useCallback(() => {
    cancelReloadWork();
    setReloadSession(null);
    setReloadElapsedMs(0);
    setReloadAttempt("none");
    setIsStartingReload(false);
    setIsCompletingReload(false);
  }, [cancelReloadWork]);

  const showNotice = useCallback((message: string, tone: Notice["tone"]) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }

    setNotice({ message, tone });
    setAnnouncement(message);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2600);
  }, []);

  const applyLeaderboard = useCallback((data: LeaderboardResponse) => {
    setLeaders(data.leaders);
    setGlobalTotal(data.globalTotal);
    setLeaderboardLoading(false);
  }, []);

  const loadEverything = useCallback(async () => {
    resetReloadState();
    setLoading(true);
    setBootstrapError(null);
    setLeaderboardLoading(true);

    const [gameResult, leaderboardResult] = await Promise.allSettled([
      fetchGame(),
      fetchLeaderboard(),
    ]);

    if (gameResult.status === "fulfilled") {
      setGame(gameResult.value);
      setDisplayPortrait(gameResult.value.round.current);
      setNicknameInput(gameResult.value.player.nickname ?? "");
      setLoading(false);
    } else {
      setBootstrapError(getFriendlyError(gameResult.reason));
      setLoading(false);
    }

    if (leaderboardResult.status === "fulfilled") {
      applyLeaderboard(leaderboardResult.value);
    } else {
      setLeaderboardLoading(false);
    }

    setOffline(!window.navigator.onLine);
  }, [applyLeaderboard, resetReloadState]);

  const refreshLeaderboard = useCallback(async () => {
    const data = await fetchLeaderboard();
    applyLeaderboard(data);
  }, [applyLeaderboard]);

  const recalculateGeometry = useCallback(() => {
    const stage = stageRef.current;
    const image = portraitImageRef.current;
    if (!stage || !image || image.naturalWidth === 0 || image.naturalHeight === 0) {
      return;
    }

    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    setGeometry(
      calculateCoverGeometry(
        stageWidth,
        stageHeight,
        image.naturalWidth,
        image.naturalHeight,
      ),
    );
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadEverything();
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadEverything]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (window.navigator.onLine) {
        void refreshLeaderboard().catch(() => undefined);
      }
    }, 10_000);

    return () => window.clearInterval(interval);
  }, [refreshLeaderboard]);

  useEffect(() => {
    const handleOnline = () => {
      resetReloadState();
      setOffline(false);
      showNotice("Back online. Your game is synced.", "success");
      void Promise.allSettled([
        fetchGame().then((data) => {
          setGame(data);
          setDisplayPortrait(data.round.current);
        }),
        refreshLeaderboard(),
      ]);
    };
    const handleOffline = () => {
      resetReloadState();
      setOffline(true);
      showNotice("You’re offline. Reconnect to keep feeding.", "error");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refreshLeaderboard, resetReloadState, showNotice]);

  useEffect(() => {
    const nextPortrait = game?.round.next;
    if (!nextPortrait?.src) {
      return;
    }

    const preloadedPortrait = new window.Image();
    preloadedPortrait.decoding = "async";
    preloadedPortrait.src = nextPortrait.src;
  }, [game?.round.next]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const resizeObserver = new ResizeObserver(recalculateGeometry);
    resizeObserver.observe(stage);
    const geometryFrame = window.requestAnimationFrame(() => {
      setGeometry(null);
      recalculateGeometry();
    });
    return () => {
      window.cancelAnimationFrame(geometryFrame);
      resizeObserver.disconnect();
    };
  }, [displayPortrait?.id, recalculateGeometry]);

  useEffect(() => {
    return () => {
      cancelReloadWork();
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, [cancelReloadWork]);

  useEffect(() => {
    if (!sandwichSplat) {
      return;
    }

    const splatTimer = window.setTimeout(
      () => {
        setSandwichSplat((current) =>
          current?.id === sandwichSplat.id ? null : current,
        );
      },
      reducedMotion ? 650 : 1_150,
    );
    return () => window.clearTimeout(splatTimer);
  }, [reducedMotion, sandwichSplat]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLeaderboardOpen(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);

  const mouthButtonStyle = useMemo<CSSProperties | undefined>(() => {
    if (!displayPortrait) {
      return undefined;
    }

    if (!("mouth" in displayPortrait)) {
      return undefined;
    }

    const { mouth } = displayPortrait;
    if (!geometry) {
      return {
        left: `${mouth.cx * 100}%`,
        top: `${mouth.cy * 100}%`,
        width: `max(44px, ${mouth.rx * 200}%)`,
        height: `max(44px, ${mouth.ry * 200}%)`,
      };
    }

    const center = normalizedImagePointToStage(geometry, mouth.cx, mouth.cy);
    return {
      left: center.x,
      top: center.y,
      width: Math.max(44, mouth.rx * 2 * geometry.renderedWidth),
      height: Math.max(44, mouth.ry * 2 * geometry.renderedHeight),
    };
  }, [displayPortrait, geometry]);

  const resyncAfterFeedError = useCallback(
    async (fallbackGame: GameResponse) => {
      resetReloadState();
      const [gameResult, leaderboardResult] = await Promise.allSettled([
        fetchGame(),
        fetchLeaderboard(),
      ]);

      if (gameResult.status === "fulfilled") {
        setGame(gameResult.value);
        setDisplayPortrait(gameResult.value.round.current);
      } else {
        setGame(fallbackGame);
        setDisplayPortrait(fallbackGame.round.current);
      }

      if (leaderboardResult.status === "fulfilled") {
        applyLeaderboard(leaderboardResult.value);
      }
    },
    [applyLeaderboard, resetReloadState],
  );

  const handleMiss = async (event: ReactMouseEvent<HTMLElement>) => {
    if (
      !game ||
      !displayPortrait ||
      !("mouth" in displayPortrait) ||
      game.player.sandwichesRemaining === 0 ||
      feedLockRef.current ||
      isOpeningPack ||
      offline
    ) {
      return;
    }

    const stageBounds = event.currentTarget.getBoundingClientRect();
    if (stageBounds.width <= 0 || stageBounds.height <= 0) {
      return;
    }

    const target = {
      x: Math.min(stageBounds.width, Math.max(0, event.clientX - stageBounds.left)),
      y: Math.min(stageBounds.height, Math.max(0, event.clientY - stageBounds.top)),
    };
    const clickPoint = geometry
      ? stagePointToNormalizedImage(geometry, target.x, target.y)
      : {
          x: target.x / stageBounds.width,
          y: target.y / stageBounds.height,
        };

    feedLockRef.current = true;
    setIsFeeding(true);
    setShotUsesThree(threeProjectileReady);

    const snapshot = game;
    const previousStreak = streak;
    const clickedPortrait = displayPortrait;

    setSandwichSplat(null);
    setSandwichTarget(target);
    setGame({
      ...snapshot,
      player: {
        ...snapshot.player,
        sandwichesRemaining: Math.max(
          0,
          snapshot.player.sandwichesRemaining - 1,
        ),
      },
    });
    setStreak(0);
    setAnnouncement("FatBoy tossed toward the portrait.");

    const missRequest = requestJson<ApiFeedResponse>("/api/feed", {
      method: "POST",
      body: JSON.stringify({
        roundToken: snapshot.round.token,
        portraitId: clickedPortrait.id,
        x: clickPoint.x,
        y: clickPoint.y,
      }),
    }).then(
      (data) => {
        try {
          return { ok: true as const, data: normalizeFeedResponse(data) };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
      (error: unknown) => ({ ok: false as const, error }),
    );

    await delay(reducedMotion ? 40 : 210);
    setSandwichTarget(null);
    splatIdRef.current += 1;
    setSandwichSplat({ ...target, id: splatIdRef.current });

    const result = await missRequest;
    if (result.ok && result.data.outcome === "miss") {
      setGame(result.data.game);
      setDisplayPortrait(result.data.game.round.current);
      showNotice("Splat! Sandwich spent — no point.", "miss");
    } else {
      const error = result.ok
        ? new Error("The server returned the wrong throw outcome.")
        : result.error;
      setSandwichSplat(null);
      setGame(snapshot);
      setDisplayPortrait(snapshot.round.current);
      setStreak(previousStreak);
      showNotice(getFriendlyError(error), "error");
      await resyncAfterFeedError(snapshot);
    }

    setIsFeeding(false);
    feedLockRef.current = false;
  };

  const handleFeed = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      !game ||
      !displayPortrait ||
      !("mouth" in displayPortrait) ||
      game.player.sandwichesRemaining === 0 ||
      feedLockRef.current ||
      offline
    ) {
      return;
    }

    feedLockRef.current = true;
    setIsFeeding(true);
    setShotUsesThree(threeProjectileReady);

    const snapshot = game;
    const previousGlobalTotal = globalTotal;
    const previousStreak = streak;
    const clickedPortrait = displayPortrait;
    // The rendered control is intentionally at least 44×44px for touch and
    // keyboard access, which can be larger than a face landmark on small
    // screens. Treat the whole control as the mouth target and submit its
    // server-owned center so every visible button activation is valid.
    const clickPoint = {
      x: clickedPortrait.mouth.cx,
      y: clickedPortrait.mouth.cy,
    };
    const stageWidth = stageRef.current?.clientWidth ?? 0;
    const stageHeight = stageRef.current?.clientHeight ?? 0;
    const target = geometry
      ? normalizedImagePointToStage(
          geometry,
          clickedPortrait.mouth.cx,
          clickedPortrait.mouth.cy,
        )
      : {
          x: stageWidth * clickedPortrait.mouth.cx,
          y: stageHeight * clickedPortrait.mouth.cy,
        };

    setSandwichSplat(null);
    setSandwichTarget(target);
    setGame({
      ...snapshot,
      player: {
        ...snapshot.player,
        sandwichesFed: snapshot.player.sandwichesFed + 1,
        sandwichesRemaining: Math.max(
          0,
          snapshot.player.sandwichesRemaining - 1,
        ),
      },
    });
    setGlobalTotal((current) => (current === null ? null : current + 1));
    setStreak(previousStreak + 1);
    setAnnouncement(
      `FatBoy tossed. Your total is ${snapshot.player.sandwichesFed + 1}.`,
    );

    const feedRequest = requestJson<ApiFeedResponse>("/api/feed", {
      method: "POST",
      body: JSON.stringify({
        roundToken: snapshot.round.token,
        portraitId: clickedPortrait.id,
        x: clickPoint.x,
        y: clickPoint.y,
      }),
    }).then(
      (data) => {
        try {
          const normalized = normalizeFeedResponse(data);
          if (normalized.outcome !== "hit") {
            throw new Error("The server returned the wrong throw outcome.");
          }
          return { ok: true as const, data: normalized.game };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
      (error: unknown) => ({ ok: false as const, error }),
    );

    await delay(reducedMotion ? 40 : 210);
    setDisplayPortrait(snapshot.round.next);
    setSandwichTarget(null);

    const result = await feedRequest;
    if (result.ok) {
      setGame(result.data);
      setDisplayPortrait(result.data.round.current);
    } else {
      setGame(snapshot);
      setDisplayPortrait(snapshot.round.current);
      setGlobalTotal(previousGlobalTotal);
      setStreak(previousStreak);
      showNotice(getFriendlyError(result.error), "error");
      await resyncAfterFeedError(snapshot);
    }

    setIsFeeding(false);
    feedLockRef.current = false;
  };

  const finishPackReload = useCallback(
    async (session: ReloadSession) => {
      const currentSession = reloadSessionRef.current;
      if (
        !game ||
        offline ||
        packLockRef.current ||
        currentSession?.token !== session.token
      ) {
        return;
      }

      const generation = reloadGenerationRef.current;
      const snapshot = game;
      packLockRef.current = true;
      setIsCompletingReload(true);
      if (reloadFrameRef.current !== null) {
        window.cancelAnimationFrame(reloadFrameRef.current);
        reloadFrameRef.current = null;
      }

      try {
        const result = normalizeGameResponse(
          await requestJson<ApiGameResponse>("/api/pack", {
            method: "POST",
            body: JSON.stringify({
              action: "complete",
              reloadToken: session.token,
            }),
          }),
        );
        if (reloadGenerationRef.current !== generation) {
          return;
        }

        resetReloadState();
        setGame(result);
        setDisplayPortrait(result.round.current);
        showNotice(
          getReloadSuccessMessage(result.player.sandwichesRemaining),
          "success",
        );
      } catch (error) {
        if (reloadGenerationRef.current !== generation) {
          return;
        }

        if (error instanceof ApiError && error.status === 425) {
          const elapsedMs = Math.max(0, performance.now() - session.startedAt);
          const retrySession = {
            ...session,
            autoCompleteAtMs: Math.max(
              session.durationMs,
              session.autoCompleteAtMs,
              elapsedMs + 180,
            ),
          };
          const attemptedPerfect = reloadAttemptRef.current === "perfect";
          if (attemptedPerfect) {
            reloadAttemptRef.current = "missed";
            setReloadAttempt("missed");
            setAnnouncement(
              "Bonus timing missed. The pack will finish reloading normally.",
            );
          } else {
            setAnnouncement("The pack needs another moment to finish reloading.");
          }
          reloadSessionRef.current = retrySession;
          setReloadSession(retrySession);
          setReloadElapsedMs(Math.min(elapsedMs, session.durationMs));
          setIsCompletingReload(false);
          packLockRef.current = false;
          return;
        }

        try {
          const synced = await fetchGame();
          if (reloadGenerationRef.current !== generation) {
            return;
          }
          resetReloadState();
          setGame(synced);
          setDisplayPortrait(synced.round.current);
          if (synced.player.sandwichesRemaining > 0) {
            showNotice(
              getReloadSuccessMessage(synced.player.sandwichesRemaining),
              "success",
            );
          } else {
            showNotice(getFriendlyError(error), "error");
          }
        } catch {
          if (reloadGenerationRef.current !== generation) {
            return;
          }
          resetReloadState();
          setGame(snapshot);
          setDisplayPortrait(snapshot.round.current);
          showNotice(getFriendlyError(error), "error");
        }
      }
    },
    [game, offline, resetReloadState, showNotice],
  );

  const startPackReload = useCallback(async () => {
    if (
      !game ||
      game.player.sandwichesRemaining !== 0 ||
      offline ||
      packLockRef.current ||
      reloadSessionRef.current
    ) {
      return;
    }

    const generation = reloadGenerationRef.current;
    const requestStartedAt = performance.now();
    packLockRef.current = true;
    reloadAttemptRef.current = "none";
    setReloadAttempt("none");
    setReloadElapsedMs(0);
    setIsStartingReload(true);
    setAnnouncement("Starting pack reload.");

    try {
      const response = await requestJson<ApiPackReloadStartResponse>("/api/pack", {
        method: "POST",
        body: JSON.stringify({
          action: "start",
          expectedScoreVersion: game.player.scoreVersion,
        }),
      });
      const responseReceivedAt = performance.now();
      if (reloadGenerationRef.current !== generation) {
        return;
      }

      const session = createReloadSession(
        response,
        requestStartedAt,
        responseReceivedAt,
      );
      reloadSessionRef.current = session;
      setReloadSession(session);
      setReloadElapsedMs(
        Math.min(session.durationMs, responseReceivedAt - session.startedAt),
      );
      setAnnouncement(
        "Reload started. Activate the box again when the marker enters the striped bonus zone.",
      );
    } catch (error) {
      if (reloadGenerationRef.current === generation) {
        try {
          const synced = await fetchGame();
          if (reloadGenerationRef.current !== generation) {
            return;
          }
          setGame(synced);
          setDisplayPortrait(synced.round.current);
          if (synced.player.sandwichesRemaining > 0) {
            showNotice(
              getReloadSuccessMessage(synced.player.sandwichesRemaining),
              "success",
            );
          } else {
            showNotice(getFriendlyError(error), "error");
          }
        } catch {
          showNotice(getFriendlyError(error), "error");
        }
      }
    } finally {
      if (reloadGenerationRef.current === generation) {
        setIsStartingReload(false);
        packLockRef.current = false;
      }
    }
  }, [game, offline, showNotice]);

  useEffect(() => {
    if (!reloadSession || isCompletingReload) {
      return;
    }

    let lastPaintAt = Number.NEGATIVE_INFINITY;
    const tick = (now: number) => {
      if (reloadSessionRef.current?.token !== reloadSession.token) {
        return;
      }

      const elapsedMs = Math.max(0, now - reloadSession.startedAt);
      if (!reducedMotion || now - lastPaintAt >= 100) {
        setReloadElapsedMs(Math.min(elapsedMs, reloadSession.durationMs));
        lastPaintAt = now;
      }

      if (elapsedMs >= reloadSession.autoCompleteAtMs) {
        setReloadElapsedMs(reloadSession.durationMs);
        reloadFrameRef.current = null;
        void finishPackReload(reloadSession);
        return;
      }

      reloadFrameRef.current = window.requestAnimationFrame(tick);
    };

    reloadFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (reloadFrameRef.current !== null) {
        window.cancelAnimationFrame(reloadFrameRef.current);
        reloadFrameRef.current = null;
      }
    };
  }, [finishPackReload, isCompletingReload, reducedMotion, reloadSession]);

  const handleOpenPack = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      !game ||
      game.player.sandwichesRemaining !== 0 ||
      packLockRef.current ||
      offline
    ) {
      return;
    }

    const session = reloadSessionRef.current;
    if (!session) {
      void startPackReload();
      return;
    }
    if (reloadAttemptRef.current !== "none") {
      setAnnouncement(
        "Your bonus timing attempt is already used. The pack will finish reloading automatically.",
      );
      return;
    }

    const elapsedMs = reducedMotion
      ? reloadElapsedMs
      : Math.max(0, performance.now() - session.startedAt);
    setReloadElapsedMs(Math.min(elapsedMs, session.durationMs));
    if (elapsedMs >= session.activeStartMs && elapsedMs <= session.activeEndMs) {
      reloadAttemptRef.current = "perfect";
      setReloadAttempt("perfect");
      setAnnouncement("Perfect timing registered. Opening the bonus pack.");
      void finishPackReload(session);
      return;
    }

    reloadAttemptRef.current = "missed";
    setReloadAttempt("missed");
    setAnnouncement(
      "Bonus timing missed. The pack will finish reloading normally.",
    );
  };

  const submitNickname = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!game || savingNickname) {
      return;
    }

    const normalized = normalizeNickname(nicknameInput);
    const validationError = validateNickname(normalized);
    if (validationError) {
      setNicknameError(validationError);
      return;
    }

    setSavingNickname(true);
    setNicknameError(null);

    try {
      const result = await requestJson<Player | { player: Player }>(
        "/api/player",
        {
          method: "PATCH",
          body: JSON.stringify({ nickname: normalized }),
        },
      );
      const returnedPlayer = "player" in result ? result.player : result;
      const nextPlayer = {
        ...game.player,
        ...returnedPlayer,
        nickname: returnedPlayer.nickname ?? normalized,
      };
      if (!returnedPlayer.displayName) {
        nextPlayer.displayName = `${normalized} #${game.player.publicTag}`;
      }
      setGame({ ...game, player: nextPlayer });
      setNicknameInput(normalized);
      showNotice("Welcome!", "success");
      void refreshLeaderboard().catch(() => undefined);
    } catch (error) {
      setNicknameError(getFriendlyError(error));
    } finally {
      setSavingNickname(false);
    }
  };

  const player = game?.player ?? null;
  const portrait = displayPortrait;
  const currentDisplayName = player?.displayName ?? null;
  const nicknameRequired = Boolean(!loading && game && !game.player.nickname);
  const packEmpty = player?.sandwichesRemaining === 0;
  const reloadProgress = reloadSession
    ? Math.min(100, Math.max(0, (reloadElapsedMs / reloadSession.durationMs) * 100))
    : 0;
  const reloadInActiveWindow = Boolean(
    reloadSession &&
      reloadAttempt === "none" &&
      reloadElapsedMs >= reloadSession.activeStartMs &&
      reloadElapsedMs <= reloadSession.activeEndMs,
  );
  const reloadMeterStyle: ActiveReloadStyle | undefined = reloadSession
    ? {
        "--reload-progress": `${reloadProgress}%`,
        "--reload-zone-start": `${(reloadSession.activeStartMs / reloadSession.durationMs) * 100}%`,
        "--reload-zone-width": `${((reloadSession.activeEndMs - reloadSession.activeStartMs) / reloadSession.durationMs) * 100}%`,
      }
    : undefined;
  const reloadButtonLabel = isCompletingReload
    ? reloadAttempt === "perfect"
      ? "Perfect reload registered. Opening the bonus pack."
      : "Opening the reloaded pack."
    : isStartingReload
      ? "Starting the pack reload."
      : reloadSession
        ? reloadAttempt === "missed"
          ? "Bonus timing missed. The pack will reload automatically."
          : reloadInActiveWindow
            ? "Bonus window active. Activate now for one bonus treat."
            : "Reloading. Activate again when the marker enters the striped bonus zone."
        : "Start reloading a new FatBoy pack.";
  const reloadDescription = isCompletingReload
    ? "Opening your reloaded pack."
    : isStartingReload
      ? "Starting the reload timer."
      : reloadSession
        ? reloadAttempt === "missed"
          ? "Timing missed. Your normal pack will finish reloading automatically."
          : "Click the box again when the marker enters the striped gold zone for one bonus treat."
        : "Click once to start reloading. Click again in the striped gold zone for one bonus treat; otherwise the pack reloads normally.";
  const reloadMeterValueText = reloadAttempt === "perfect"
    ? "Perfect timing registered. Opening the pack."
    : reloadAttempt === "missed"
      ? "Bonus timing missed. Reload will finish automatically."
      : reloadInActiveWindow
        ? "Bonus window. Activate the box now."
        : `Reloading, ${Math.round(reloadProgress)} percent.`;

  return (
    <div className="game-shell">
      <div
        className="game-scene"
        inert={nicknameRequired ? true : undefined}
        aria-hidden={nicknameRequired ? true : undefined}
      >
        <main
          className={`portrait-stage${isFeeding ? " portrait-stage-feeding" : ""}${packEmpty ? " portrait-stage-pack-empty" : ""}`}
          id="game"
          ref={stageRef}
          onClick={(event) => void handleMiss(event)}
          aria-busy={loading || isFeeding || isOpeningPack}
        >
          {portrait ? (
            <img
              className="portrait-photo"
              key={portrait.id}
              ref={portraitImageRef}
              src={portrait.src}
              alt={portrait.alt}
              width="768"
              height="768"
              draggable={false}
              onLoad={recalculateGeometry}
            />
          ) : null}

          {loading ? (
            <div className="stage-state" role="status">
              <strong>Loading…</strong>
            </div>
          ) : null}

          {!loading && bootstrapError ? (
            <div className="stage-state" role="alert">
              <strong>Something went wrong.</strong>
              <span>{bootstrapError}</span>
              <button
                className="text-action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void loadEverything();
                }}
              >
                try again
              </button>
            </div>
          ) : null}

          {portrait && "mouth" in portrait && !bootstrapError && !packEmpty ? (
            <button
              className="mouth-target"
              style={mouthButtonStyle}
              type="button"
              onClick={handleFeed}
              disabled={isFeeding || offline}
              aria-label="Throw a 3D FatBoy ice cream sandwich to this person"
              aria-describedby="mouth-instructions"
            >
              <span className="sr-only">Feed sandwich</span>
            </button>
          ) : null}

          <FatboyProjectile
            target={shotUsesThree ? sandwichTarget : null}
            onReadyChange={setThreeProjectileReady}
            reducedMotion={reducedMotion}
          />
          {sandwichTarget && !shotUsesThree ? (
            <img
              className="sandwich-flight"
              src="/brand/vanilla-sandwich.webp"
              alt=""
              width="700"
              height="420"
              style={{ left: sandwichTarget.x, top: sandwichTarget.y }}
              aria-hidden="true"
            />
          ) : null}

          {sandwichSplat ? (
            <div
              className="sandwich-splat"
              key={sandwichSplat.id}
              style={{ left: sandwichSplat.x, top: sandwichSplat.y }}
              aria-hidden="true"
            >
              <span className="sandwich-splat-cream" />
              <img
                src="/brand/vanilla-sandwich.webp"
                alt=""
                width="700"
                height="420"
                draggable={false}
              />
            </div>
          ) : null}

          {packEmpty && !isFeeding && !sandwichSplat && !bootstrapError ? (
            <section
              className={`pack-reload${isCompletingReload ? " pack-reload-opening" : ""}`}
              aria-labelledby="pack-reload-title"
              aria-describedby="pack-reload-description"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="pack-reload-copy">
                <p>
                  {reloadAttempt === "perfect"
                    ? "Perfect reload"
                    : reloadAttempt === "missed"
                      ? "Standard reload"
                      : reloadSession
                        ? "Active reload"
                        : "Pack empty"}
                </p>
                <h2 id="pack-reload-title">Reload a fresh pack.</h2>
                <span id="pack-reload-description">
                  {reloadDescription}
                </span>
              </div>
              <div className="pack-reload-control">
                <button
                  className="pack-box-button"
                  type="button"
                  onClick={handleOpenPack}
                  disabled={isStartingReload || isCompletingReload || offline}
                  aria-label={reloadButtonLabel}
                  aria-describedby="pack-reload-description"
                >
                  <img
                    src="/brand/fatboy-vanilla-6-pack.webp"
                    alt=""
                    width="2048"
                    height="2048"
                    draggable={false}
                    aria-hidden="true"
                  />
                  <span className="pack-box-label">
                    {isCompletingReload
                      ? "opening…"
                      : isStartingReload
                        ? "starting…"
                        : reloadSession
                          ? reloadAttempt === "perfect"
                            ? "perfect reload!"
                            : reloadAttempt === "missed"
                              ? "timing missed · reloading"
                              : reloadInActiveWindow
                                ? "now! · +1 treat"
                                : "click in stripes · +1 treat"
                          : "click to reload"}
                  </span>
                </button>

                {reloadSession && reloadMeterStyle ? (
                  <div
                    className={`active-reload-meter${reloadInActiveWindow ? " active-reload-meter-ready" : ""}${reloadAttempt === "perfect" ? " active-reload-meter-perfect" : ""}${reloadAttempt === "missed" ? " active-reload-meter-missed" : ""}`}
                    role="progressbar"
                    aria-label="Pack reload progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(reloadProgress)}
                    aria-valuetext={reloadMeterValueText}
                    style={reloadMeterStyle}
                  >
                    <span className="active-reload-zone" aria-hidden="true" />
                    <span
                      className="active-reload-indicator"
                      aria-hidden="true"
                    />
                    <span
                      className="active-reload-zone-label"
                      aria-hidden="true"
                    >
                      {reloadAttempt === "perfect"
                        ? "+1 locked"
                        : reloadAttempt === "missed"
                          ? "bonus missed"
                          : reloadInActiveWindow
                            ? "+1 now"
                            : "+1 bonus"}
                    </span>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </main>

        <header className="overlay-top">
          <div>
            <h1 className="brand-lockup">
              <img
                className="brand-logo"
                src="/brand/fatboy-logo.png"
                alt="FatBoy"
                width="450"
                height="130"
              />
            </h1>
            <p className="game-instruction" id="mouth-instructions">
              {packEmpty
                ? isStartingReload
                  ? "pack empty · starting reload"
                  : reloadSession
                    ? reloadAttempt === "missed"
                      ? "standard reload · finishing automatically"
                      : "active reload · click in the stripes"
                    : "pack empty · click the box"
                : `tap the mouth · toss a 3D FatBoy · ${player?.sandwichesRemaining ?? 6} left`}
            </p>
          </div>
          <dl className="stats-line" aria-label="Game statistics">
            <div>
              <dt>you</dt>
              <dd>{player ? numberFormatter.format(player.sandwichesFed) : "—"}</dd>
            </div>
            <div>
              <dt>everyone</dt>
              <dd>{globalTotal === null ? "—" : numberFormatter.format(globalTotal)}</dd>
            </div>
            <div>
              <dt>pack</dt>
              <dd>{player ? `${player.sandwichesRemaining} left` : "—"}</dd>
            </div>
            <div>
              <dt>streak</dt>
              <dd>{numberFormatter.format(streak)}</dd>
            </div>
          </dl>
        </header>

        <aside
          className="leaderboard-plain"
          id="leaderboard-panel"
          aria-labelledby="leaderboard-heading"
          hidden={!leaderboardOpen}
        >
          <p className="overlay-label" id="leaderboard-heading">
            Top feeders
          </p>
          <LeaderboardContents
            leaders={leaders}
            currentDisplayName={currentDisplayName}
            loading={leaderboardLoading}
          />
        </aside>

        <footer className="overlay-bottom">
          <div className="footer-left">
            <div className="player-line">
              <span>{currentDisplayName ?? "getting ready…"}</span>
              <button
                className="text-action"
                type="button"
                onClick={() => setLeaderboardOpen((open) => !open)}
                disabled={
                  !player || isFeeding || isOpeningPack || Boolean(reloadSession)
                }
                aria-expanded={leaderboardOpen}
                aria-controls="leaderboard-panel"
              >
                leaderboard
              </button>
            </div>
            <p className="site-disclaimer">
              <a
                href="https://www.mistakes.party/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Visit mistakes.party (opens in a new tab)"
              >
                mistakes.party
              </a>
              <span aria-hidden="true"> · </span>
              <span>
                This game is made for humor and is not affiliated with,
                endorsed by, or sponsored by any real brand.
              </span>
            </p>
          </div>
          <p className="save-state" role="status">
            {offline
              ? "offline"
              : loading
                ? "connecting"
                : isFeeding
                  ? "saving"
                  : isCompletingReload
                    ? "opening pack"
                    : isStartingReload
                      ? "starting reload"
                      : reloadSession
                        ? "reloading"
                        : "saved"}
          </p>
        </footer>

        {offline ? (
          <p className="offline-plain" role="status">
            offline — reconnect to play
          </p>
        ) : null}
      </div>

      {notice ? (
        <div className="game-toast" role="status">
          {notice.message}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {nicknameRequired ? (
        <NicknameDialog
          value={nicknameInput}
          error={nicknameError}
          saving={savingNickname}
          offline={offline}
          onChange={(value) => {
            setNicknameInput(value);
            setNicknameError(null);
          }}
          onSubmit={submitNickname}
        />
      ) : null}
    </div>
  );
}
