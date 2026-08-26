"use client";

/* Local, already-optimized game assets intentionally use ordinary images so
   portrait crop geometry and mouth targeting share the exact rendered box. */
/* eslint-disable @next/next/no-img-element */

import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
} from "../lib/client/portrait-geometry";
import {
  createThrowSpin,
  NO_THROW_SPIN,
  type ThrowSpin,
} from "../lib/client/throw-motion";
import { getFeedReaction } from "../lib/feed-reactions";
import {
  getClearedPackHistory,
  getDisplayedClearedPackCount,
  type PackDefinition,
  type ReloadMechanicId,
  type ReloadWindow,
} from "../lib/packs";
import {
  advanceTripleSnap,
  evaluatePopLaunch,
  evaluateSpiralHold,
  getReloadVisualWindows,
  hasValidReloadInteractionConfig,
  isElapsedInWindow,
} from "../lib/reload-interactions";

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
  packsCleared: number;
  currentPack: PackDefinition;
  nextPack: PackDefinition;
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
    pack: PackDefinition;
    mechanic: ReloadMechanicId;
    durationMs: number;
    windows: readonly ReloadWindow[];
  };
};

type ReloadAttempt = "none" | "missed" | "perfect";

type ReloadGesture =
  | {
      kind: "spiral-hold";
      pointerId: number | null;
      startedElapsedMs: number;
    }
  | {
      kind: "pop-launch";
      pointerId: number | null;
      startedElapsedMs: number;
      startedAtClockMs: number;
      startY: number;
    };

type ReloadSession = ApiPackReloadStartResponse["reload"] & {
  startedAt: number;
  autoCompleteAtMs: number;
};

type ActiveReloadStyle = CSSProperties & {
  "--reload-progress": string;
  "--pack-accent": string;
  "--pack-accent-soft": string;
};

type SandwichFlightStyle = CSSProperties & {
  "--flight-duration": string;
  "--flight-spin-end": string;
  "--flight-spin-mid": string;
  "--flight-target-x": string;
  "--flight-target-y": string;
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
  tone: "info" | "success" | "error";
};

type FeedReaction = {
  id: number;
  message: string;
  x: number;
  y: number;
};

const numberFormatter = new Intl.NumberFormat("en-US");
const nicknamePattern = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;
const FATBOY_THROW_DURATION_MS = 800;
const FATBOY_REDUCED_MOTION_DURATION_MS = 420;

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
  const windowsAreValid =
    Array.isArray(reload?.windows) &&
    reload.windows.every(
      (window, index) =>
        Number.isFinite(window.startMs) &&
        window.startMs >= 0 &&
        Number.isFinite(window.endMs) &&
        window.endMs > window.startMs &&
        window.endMs <= reload.durationMs &&
        (index === 0 ||
          reload.windows[index - 1].endMs < window.startMs),
    );
  if (
    !reload ||
    typeof reload.token !== "string" ||
    reload.token.length === 0 ||
    !reload.pack ||
    typeof reload.pack.id !== "string" ||
    typeof reload.pack.name !== "string" ||
    !Number.isSafeInteger(reload.pack.quantity) ||
    reload.pack.quantity <= 0 ||
    reload.mechanic !== reload.pack.reload?.id ||
    !Number.isFinite(reload.durationMs) ||
    reload.durationMs <= 0 ||
    reload.durationMs !== reload.pack.reload.durationMs ||
    !windowsAreValid ||
    reload.windows.length !== reload.pack.reload.windows.length ||
    reload.windows.some(
      (window, index) =>
        window.startMs !== reload.pack.reload.windows[index]?.startMs ||
        window.endMs !== reload.pack.reload.windows[index]?.endMs,
    ) ||
    !hasValidReloadInteractionConfig(reload.pack.reload)
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

function getReloadSuccessMessage(player: Player, quickOpen = false) {
  const prefix = quickOpen ? "Quick open!" : `${player.currentPack.shortName} opened.`;
  return `${prefix} ${numberFormatter.format(player.sandwichesRemaining)} treats ready.`;
}

function getAccessibleReloadShortcut(
  mechanic: ReloadMechanicId | null | undefined,
) {
  if (mechanic === "triple-snap") {
    return "Screen-reader shortcut: activate this box three times right away; no timed cue is needed.";
  }
  if (mechanic === "spiral-hold" || mechanic === "pop-launch") {
    return "Screen-reader shortcut: activate this box twice right away; no timed cue is needed.";
  }
  return "";
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

function ClearedBoxStack({ count }: { count: number }) {
  if (count <= 0) {
    return null;
  }

  const boxes = getClearedPackHistory(count);

  return (
    <aside
      className="cleared-boxes"
      aria-label={`${numberFormatter.format(count)} empty ${count === 1 ? "box" : "boxes"} cleared`}
    >
      <p className="cleared-boxes-heading" aria-hidden="true">
        <strong>{numberFormatter.format(count)}</strong>
        <span>{count === 1 ? "box cleared" : "boxes cleared"}</span>
      </p>
      <ol
        className="cleared-boxes-list"
        aria-label="Cleared box history"
        tabIndex={count > 10 ? 0 : undefined}
      >
        {boxes.map((pack, index) => {
          const ordinal = index + 1;
          return (
            <li
              className={`cleared-box${index === boxes.length - 1 ? " cleared-box-newest" : ""}`}
              key={`${pack.id}-${ordinal}`}
            >
              <img
                src={pack.imageSrc}
                alt=""
                width="1200"
                height="1200"
                loading={index > 5 ? "lazy" : "eager"}
                decoding="async"
                draggable={false}
                aria-hidden="true"
              />
              <span className="cleared-box-stamp" aria-hidden="true">
                empty
              </span>
              <span className="sr-only">
                Cleared box {numberFormatter.format(ordinal)}: {pack.name}.
              </span>
            </li>
          );
        })}
      </ol>
    </aside>
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
        <p className="plain-dialog-kicker">One-thumb feed frenzy</p>
        <h2 id="nickname-title">Feed the crowd.</h2>
        <p id="nickname-description">
          Tap the FatBoy at the bottom and it flies straight to the mouth.
          Empty three boxes to unlock the 12-pack.
        </p>

        <ol className="onboarding-loop" aria-label="How to play">
          <li>
            <strong>1</strong>
            <span>Tap FatBoy</span>
          </li>
          <li>
            <strong>2</strong>
            <span>Feed faces</span>
          </li>
          <li>
            <strong>3</strong>
            <span>Clear boxes</span>
          </li>
        </ol>

        <form onSubmit={onSubmit} noValidate>
          <label className="plain-name-label" htmlFor="nickname-input">
            Choose your feeder name
          </label>
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
              {saving ? "saving…" : "let’s feed"}
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
  const [gameInfoOpen, setGameInfoOpen] = useState(false);
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
  const [reloadGestureKind, setReloadGestureKind] = useState<
    ReloadGesture["kind"] | null
  >(null);
  const [tripleSnapStep, setTripleSnapStep] = useState(0);
  const [accessibleReloadPending, setAccessibleReloadPending] = useState(false);
  const [threeProjectileReady, setThreeProjectileReady] = useState(false);
  const [shotUsesThree, setShotUsesThree] = useState(false);
  const [throwSpin, setThrowSpin] = useState<ThrowSpin>(NO_THROW_SPIN);
  const [geometry, setGeometry] = useState<CoverGeometry | null>(null);
  const [sandwichTarget, setSandwichTarget] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [feedReaction, setFeedReaction] = useState<FeedReaction | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [urgentAnnouncement, setUrgentAnnouncement] = useState("");
  const [nicknameInput, setNicknameInput] = useState("");
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [savingNickname, setSavingNickname] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const portraitImageRef = useRef<HTMLImageElement>(null);
  const hudTriggerRef = useRef<HTMLButtonElement | null>(null);
  const packButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusPackAfterFeedRef = useRef(false);
  const feedLockRef = useRef(false);
  const packLockRef = useRef(false);
  const reloadSessionRef = useRef<ReloadSession | null>(null);
  const reloadAttemptRef = useRef<ReloadAttempt>("none");
  const reloadGestureRef = useRef<ReloadGesture | null>(null);
  const tripleSnapStepRef = useRef(0);
  const reloadCueRef = useRef<string | null>(null);
  const accessibleReloadStepRef = useRef(0);
  const accessibleReloadPendingRef = useRef(false);
  const reloadFrameRef = useRef<number | null>(null);
  const reloadGenerationRef = useRef(0);
  const reactionIdRef = useRef(0);
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
    reloadGestureRef.current = null;
    tripleSnapStepRef.current = 0;
    reloadCueRef.current = null;
    accessibleReloadStepRef.current = 0;
    accessibleReloadPendingRef.current = false;
    packLockRef.current = false;
  }, []);

  const resetReloadState = useCallback(() => {
    cancelReloadWork();
    setReloadSession(null);
    setReloadElapsedMs(0);
    setReloadAttempt("none");
    setReloadGestureKind(null);
    setTripleSnapStep(0);
    setAccessibleReloadPending(false);
    setUrgentAnnouncement("");
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
    if (!feedReaction) {
      return;
    }

    const reactionTimer = window.setTimeout(
      () => {
        setFeedReaction((current) =>
          current?.id === feedReaction.id ? null : current,
        );
      },
      reducedMotion ? 650 : 1_050,
    );
    return () => window.clearTimeout(reactionTimer);
  }, [feedReaction, reducedMotion]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        (!leaderboardOpen && !gameInfoOpen)
      ) {
        return;
      }

      setLeaderboardOpen(false);
      setGameInfoOpen(false);
      window.requestAnimationFrame(() => hudTriggerRef.current?.focus());
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [gameInfoOpen, leaderboardOpen]);

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
    focusPackAfterFeedRef.current =
      snapshot.player.sandwichesRemaining === 1 &&
      document.activeElement === event.currentTarget;
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

    setFeedReaction(null);
    setThrowSpin(createThrowSpin());
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

    await delay(
      reducedMotion
        ? FATBOY_REDUCED_MOTION_DURATION_MS
        : FATBOY_THROW_DURATION_MS,
    );
    reactionIdRef.current += 1;
    const reactionId = reactionIdRef.current;
    setFeedReaction({
      id: reactionId,
      message: getFeedReaction(snapshot.player.sandwichesFed + 1),
      ...target,
    });
    setDisplayPortrait(snapshot.round.next);
    setSandwichTarget(null);

    const result = await feedRequest;
    if (result.ok) {
      setGame(result.data);
      setDisplayPortrait(result.data.round.current);
    } else {
      focusPackAfterFeedRef.current = false;
      setFeedReaction((current) =>
        current?.id === reactionId ? null : current,
      );
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
        const quickOpen = reloadAttemptRef.current === "perfect";
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
        showNotice(getReloadSuccessMessage(result.player, quickOpen), "success");
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
              "The quick-open timing slipped. The box will finish automatically.",
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
            showNotice(getReloadSuccessMessage(synced.player), "success");
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
    reloadGestureRef.current = null;
    tripleSnapStepRef.current = 0;
    reloadCueRef.current = null;
    accessibleReloadStepRef.current = 0;
    accessibleReloadPendingRef.current = false;
    setReloadAttempt("none");
    setReloadGestureKind(null);
    setTripleSnapStep(0);
    setAccessibleReloadPending(false);
    setUrgentAnnouncement("");
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
      const accessibleShortcut = getAccessibleReloadShortcut(session.mechanic);
      setAnnouncement(
        `Reload started. ${session.pack.reload.instruction}${accessibleShortcut ? ` ${accessibleShortcut}` : ""}`,
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
            showNotice(getReloadSuccessMessage(synced.player), "success");
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

      if (
        accessibleReloadPendingRef.current &&
        reloadSession.windows.some((window) =>
          isElapsedInWindow(elapsedMs, window),
        )
      ) {
        accessibleReloadPendingRef.current = false;
        setAccessibleReloadPending(false);
        reloadAttemptRef.current = "perfect";
        setReloadAttempt("perfect");
        setReloadGestureKind(null);
        setAnnouncement("Accessible quick-open ready. Opening the box now.");
        reloadFrameRef.current = null;
        void finishPackReload(reloadSession);
        return;
      }

      if (
        reloadAttemptRef.current === "none" &&
        accessibleReloadStepRef.current === 0 &&
        !accessibleReloadPendingRef.current
      ) {
        const definition = reloadSession.pack.reload;
        const gesture = reloadGestureRef.current;
        let missedMessage: string | null = null;
        let activeCue: string | null = null;

        if (definition.id === "spiral-hold") {
          if (gesture?.kind === "spiral-hold") {
            const releaseWindow = definition.windows[0];
            if (releaseWindow && isElapsedInWindow(elapsedMs, releaseWindow)) {
              activeCue = "GLAZE active. Release now.";
            }
            if (
              elapsedMs - gesture.startedElapsedMs > definition.maxHoldMs ||
              (releaseWindow && elapsedMs > releaseWindow.endMs)
            ) {
              missedMessage =
                "The GLAZE release passed. This box will finish automatically.";
            }
          } else {
            if (isElapsedInWindow(elapsedMs, definition.pressWindow)) {
              activeCue = "CATCH active. Press and hold now.";
            } else if (elapsedMs > definition.pressWindow.endMs) {
              missedMessage =
                "The CATCH window passed. This box will finish automatically.";
            }
          }
        } else if (definition.id === "triple-snap") {
          const targetBeat = definition.beats[tripleSnapStepRef.current];
          if (targetBeat) {
            if (isElapsedInWindow(elapsedMs, targetBeat)) {
              activeCue = `Chocolate snap ${tripleSnapStepRef.current + 1} active. Activate now.`;
            } else if (elapsedMs > targetBeat.endMs) {
              missedMessage =
                "A chocolate snap passed. This box will finish automatically.";
            }
          }
        } else if (definition.id === "pop-launch") {
          if (gesture?.kind === "pop-launch") {
            const releaseWindow = definition.windows[0];
            if (releaseWindow && isElapsedInWindow(elapsedMs, releaseWindow)) {
              activeCue =
                "PARTY active. Swipe up or press Arrow Up now.";
            }
            if (
              elapsedMs - gesture.startedElapsedMs > definition.maxGestureMs ||
              (releaseWindow && elapsedMs > releaseWindow.endMs)
            ) {
              missedMessage =
                "The PARTY ring passed. This box will finish automatically.";
            }
          } else {
            if (isElapsedInWindow(elapsedMs, definition.launchWindow)) {
              activeCue = "LAUNCH active. Press now.";
            } else if (elapsedMs > definition.launchWindow.endMs) {
              missedMessage =
                "The LAUNCH window passed. This box will finish automatically.";
            }
          }
        }

        if (activeCue && reloadCueRef.current !== activeCue) {
          reloadCueRef.current = activeCue;
          setUrgentAnnouncement(activeCue);
        }

        if (missedMessage) {
          reloadGestureRef.current = null;
          setReloadGestureKind(null);
          reloadAttemptRef.current = "missed";
          setReloadAttempt("missed");
          setAnnouncement(missedMessage);
        }
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

  const currentReloadElapsed = (session: ReloadSession) =>
    reducedMotion
      ? reloadElapsedMs
      : Math.max(0, performance.now() - session.startedAt);

  const clearReloadGesture = () => {
    reloadGestureRef.current = null;
    accessibleReloadStepRef.current = 0;
    accessibleReloadPendingRef.current = false;
    setReloadGestureKind(null);
    setAccessibleReloadPending(false);
  };

  const missQuickOpen = (message: string) => {
    clearReloadGesture();
    reloadAttemptRef.current = "missed";
    setReloadAttempt("missed");
    setAnnouncement(message);
  };

  const completeQuickOpen = (session: ReloadSession, message: string) => {
    clearReloadGesture();
    reloadAttemptRef.current = "perfect";
    setReloadAttempt("perfect");
    setAnnouncement(message);
    void finishPackReload(session);
  };

  const beginTimedGesture = (
    session: ReloadSession,
    pointerId: number | null,
    startY: number,
  ) => {
    const definition = session.pack.reload;
    const elapsedMs = currentReloadElapsed(session);
    setReloadElapsedMs(Math.min(elapsedMs, session.durationMs));

    if (definition.id === "spiral-hold") {
      if (!isElapsedInWindow(elapsedMs, definition.pressWindow)) {
        missQuickOpen(
          "The churro spiral missed CATCH. This box will finish automatically.",
        );
        return false;
      }
      reloadGestureRef.current = {
        kind: "spiral-hold",
        pointerId,
        startedElapsedMs: elapsedMs,
      };
      setReloadGestureKind("spiral-hold");
      setAnnouncement("CATCH locked. Keep holding, then release on GLAZE.");
      return true;
    }

    if (definition.id === "pop-launch") {
      if (!isElapsedInWindow(elapsedMs, definition.launchWindow)) {
        missQuickOpen(
          "The pop missed LAUNCH. This box will finish automatically.",
        );
        return false;
      }
      reloadGestureRef.current = {
        kind: "pop-launch",
        pointerId,
        startedElapsedMs: elapsedMs,
        startedAtClockMs: performance.now(),
        startY,
      };
      setReloadGestureKind("pop-launch");
      setAnnouncement(
        pointerId === null
          ? "Pop armed. Press Arrow Up when PARTY lights."
          : "Pop armed. Swipe upward when PARTY lights.",
      );
      return true;
    }

    return false;
  };

  const finishTimedGesture = (
    session: ReloadSession,
    endY: number,
    keyboardLaunch = false,
  ) => {
    const gesture = reloadGestureRef.current;
    const definition = session.pack.reload;
    if (!gesture) {
      return;
    }

    const elapsedMs = currentReloadElapsed(session);
    setReloadElapsedMs(Math.min(elapsedMs, session.durationMs));

    if (gesture.kind === "spiral-hold" && definition.id === "spiral-hold") {
      if (
        evaluateSpiralHold(
          gesture.startedElapsedMs,
          elapsedMs,
          definition,
        )
      ) {
        completeQuickOpen(
          session,
          "Churro spiral glazed. Opening the box now.",
        );
      } else {
        missQuickOpen(
          "The GLAZE release missed. This box will finish automatically.",
        );
      }
      return;
    }

    if (gesture.kind === "pop-launch" && definition.id === "pop-launch") {
      const completed = evaluatePopLaunch(
        {
          startElapsedMs: gesture.startedElapsedMs,
          endElapsedMs: elapsedMs,
          startY: gesture.startY,
          endY: keyboardLaunch
            ? gesture.startY - definition.minTravelPx
            : endY,
          gestureDurationMs: performance.now() - gesture.startedAtClockMs,
        },
        definition,
      );
      if (completed) {
        completeQuickOpen(
          session,
          "Birthday pop launched through PARTY. Opening the box now.",
        );
      } else {
        missQuickOpen(
          "The pop missed the PARTY ring. This box will finish automatically.",
        );
      }
    }
  };

  const handleAccessibleReloadActivation = (session: ReloadSession) => {
    const definition = session.pack.reload;
    if (
      definition.id !== "spiral-hold" &&
      definition.id !== "triple-snap" &&
      definition.id !== "pop-launch"
    ) {
      return false;
    }

    if (accessibleReloadPendingRef.current) {
      setAnnouncement(
        "Accessible quick-open sequence complete. Waiting for the safe opening cue.",
      );
      return true;
    }

    const requiredSteps = definition.id === "triple-snap" ? 3 : 2;
    const nextStep = Math.min(
      requiredSteps,
      accessibleReloadStepRef.current + 1,
    );
    accessibleReloadStepRef.current = nextStep;

    if (definition.id === "triple-snap") {
      tripleSnapStepRef.current = nextStep;
      setTripleSnapStep(nextStep);
    } else {
      setReloadGestureKind(definition.id);
    }

    if (nextStep === requiredSteps) {
      accessibleReloadPendingRef.current = true;
      setAccessibleReloadPending(true);
      setAnnouncement(
        "Accessible quick-open sequence complete. The box will open at the next safe cue.",
      );
    } else {
      setAnnouncement(
        `Accessible quick-open step ${nextStep} of ${requiredSteps} recorded. Activate the box again right away.`,
      );
    }
    return true;
  };

  const attemptTripleSnap = (session: ReloadSession) => {
    const definition = session.pack.reload;
    if (definition.id !== "triple-snap") {
      return;
    }

    const elapsedMs = currentReloadElapsed(session);
    setReloadElapsedMs(Math.min(elapsedMs, session.durationMs));
    const result = advanceTripleSnap(
      tripleSnapStepRef.current,
      elapsedMs,
      definition,
    );
    if (result.status === "progress") {
      tripleSnapStepRef.current = result.nextStep;
      setTripleSnapStep(result.nextStep);
      setAnnouncement(
        `Chocolate snap ${result.nextStep} of ${definition.beats.length}. Get ready for the next beat.`,
      );
    } else if (result.status === "perfect") {
      tripleSnapStepRef.current = result.nextStep;
      setTripleSnapStep(result.nextStep);
      completeQuickOpen(
        session,
        "All three chocolate snaps landed. Opening the box now.",
      );
    } else {
      missQuickOpen(
        "A chocolate snap missed its beat. This box will finish automatically.",
      );
    }
  };

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
    if (session.mechanic === "hands-off") {
      setAnnouncement("Hands off. The caramel pour will open this box automatically.");
      return;
    }
    if (reloadAttemptRef.current !== "none") {
      setAnnouncement(
        "Your quick-open attempt is already used. The box will finish automatically.",
      );
      return;
    }

    const definition = session.pack.reload;
    if (event.detail === 0 && handleAccessibleReloadActivation(session)) {
      return;
    }
    if (definition.id === "spiral-hold" || definition.id === "pop-launch") {
      setAnnouncement(definition.instruction);
      return;
    }

    if (definition.id === "triple-snap") {
      attemptTripleSnap(session);
      return;
    }

    const elapsedMs = currentReloadElapsed(session);
    setReloadElapsedMs(Math.min(elapsedMs, session.durationMs));

    if (session.windows.some((window) => isElapsedInWindow(elapsedMs, window))) {
      completeQuickOpen(session, "Quick-open timing locked. Opening the box now.");
      return;
    }

    missQuickOpen(
      "Quick-open timing missed. The box will finish automatically.",
    );
  };

  const handlePackPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const session = reloadSessionRef.current;
    if (
      event.button !== 0 ||
      !session ||
      reloadAttemptRef.current !== "none" ||
      accessibleReloadStepRef.current > 0 ||
      packLockRef.current ||
      (session.mechanic !== "spiral-hold" && session.mechanic !== "pop-launch")
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (!beginTimedGesture(session, event.pointerId, event.clientY)) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      setAnnouncement("Keep the pointer over the box until the release cue.");
    }
  };

  const handlePackPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const gesture = reloadGestureRef.current;
    if (gesture?.kind === "pop-launch" && gesture.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handlePackPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const gesture = reloadGestureRef.current;
    const session = reloadSessionRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !session) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released when the browser sends pointerup.
    }
    finishTimedGesture(session, event.clientY);
  };

  const handlePackPointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const gesture = reloadGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    missQuickOpen(
      "The quick-open gesture was interrupted. This box will finish automatically.",
    );
  };

  const handlePackKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const session = reloadSessionRef.current;
    if (
      !session ||
      reloadAttemptRef.current !== "none" ||
      accessibleReloadStepRef.current > 0 ||
      packLockRef.current
    ) {
      return;
    }
    const definition = session.pack.reload;
    const activationKey = event.key === " " || event.key === "Enter";

    if (definition.id === "triple-snap" && activationKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        attemptTripleSnap(session);
      }
      return;
    }

    if (definition.id === "spiral-hold" && activationKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !reloadGestureRef.current) {
        beginTimedGesture(session, null, 0);
      }
      return;
    }

    if (definition.id !== "pop-launch") {
      return;
    }
    if (activationKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !reloadGestureRef.current) {
        beginTimedGesture(session, null, 0);
      }
      return;
    }
    if (
      event.key === "ArrowUp" &&
      reloadGestureRef.current?.kind === "pop-launch" &&
      reloadGestureRef.current.pointerId === null
    ) {
      event.preventDefault();
      event.stopPropagation();
      finishTimedGesture(session, 0, true);
    }
  };

  const handlePackKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const session = reloadSessionRef.current;
    const gesture = reloadGestureRef.current;
    const activationKey = event.key === " " || event.key === "Enter";
    if (!session || !activationKey || !gesture || gesture.pointerId !== null) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (gesture.kind === "spiral-hold") {
      finishTimedGesture(session, 0);
    }
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
  const hudPanelOpen = gameInfoOpen || leaderboardOpen;
  const saveStateLabel = offline
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
              : "saved";
  const packEmpty = player?.sandwichesRemaining === 0;
  const clearedBoxesVisible = player
    ? getDisplayedClearedPackCount(
        player.packsCleared,
        player.sandwichesRemaining,
      )
    : 0;
  const reloadPack =
    reloadSession?.pack ?? player?.nextPack ?? player?.currentPack ?? null;
  const reloadMechanic = reloadSession?.mechanic ?? reloadPack?.reload.id ?? null;
  const reloadProgress = reloadSession
    ? Math.min(100, Math.max(0, (reloadElapsedMs / reloadSession.durationMs) * 100))
    : 0;
  const reloadVisualWindows = reloadSession
    ? getReloadVisualWindows(reloadSession.pack.reload)
    : [];
  const activeVisualWindowIndex = reloadVisualWindows.findIndex((window) =>
    isElapsedInWindow(reloadElapsedMs, window),
  );
  const reloadInActiveWindow = Boolean(
    reloadSession &&
      reloadAttempt === "none" &&
      reloadSession.windows.some((window) =>
        isElapsedInWindow(reloadElapsedMs, window),
      ),
  );
  const reloadMeterStyle: ActiveReloadStyle | undefined = reloadSession
    ? {
        "--reload-progress": `${reloadProgress}%`,
        "--pack-accent": reloadSession.pack.accent,
        "--pack-accent-soft": reloadSession.pack.accentSoft,
      }
    : undefined;
  const reloadThemeStyle = reloadPack
    ? ({
        "--pack-accent": reloadPack.accent,
        "--pack-accent-soft": reloadPack.accentSoft,
      } as CSSProperties)
    : undefined;
  const handsOffReload = reloadMechanic === "hands-off";
  const expectedVisualWindowIndex = reloadSession
    ? reloadSession.mechanic === "triple-snap"
      ? tripleSnapStep
      : reloadSession.mechanic === "spiral-hold" ||
          reloadSession.mechanic === "pop-launch"
        ? reloadGestureKind
          ? 1
          : 0
        : activeVisualWindowIndex
    : -1;
  const reloadActionReady = Boolean(
    reloadSession &&
      reloadAttempt === "none" &&
      activeVisualWindowIndex >= 0 &&
      activeVisualWindowIndex === expectedVisualWindowIndex,
  );
  const reloadSecondsRemaining = reloadSession
    ? Math.min(
        3,
        Math.max(
          0,
          Math.ceil((reloadSession.durationMs - reloadElapsedMs) / 1_000),
        ),
      )
    : 0;
  const reloadInteractionPrompt = reloadSession
    ? reloadAttempt === "perfect"
      ? "quick open!"
      : reloadAttempt === "missed"
        ? "timing missed · auto finishing"
        : accessibleReloadPending
          ? "sequence complete · opening on cue"
        : reloadSession.mechanic === "hands-off"
          ? "hands off · settling"
          : reloadSession.mechanic === "spiral-hold"
            ? reloadGestureKind === "spiral-hold"
              ? reloadActionReady
                ? "glaze · release now!"
                : "keep holding for glaze"
              : reloadActionReady
                ? "catch · press now!"
                : "watch for catch"
            : reloadSession.mechanic === "triple-snap"
              ? reloadActionReady
                ? `snap ${Math.min(3, tripleSnapStep + 1)} now!`
                : `watch for snap ${Math.min(3, tripleSnapStep + 1)}`
              : reloadSession.mechanic === "pop-launch"
                ? reloadGestureKind === "pop-launch"
                  ? reloadActionReady
                    ? "party · swipe up!"
                    : "pop armed · wait for party"
                  : reloadActionReady
                    ? "launch · press now!"
                    : "watch for launch"
                : reloadInActiveWindow
                  ? "open now!"
                  : "watch the timer"
    : null;
  const reloadReadout = reloadAttempt === "missed"
    ? "AUTO"
    : reloadMechanic === "spiral-hold" && reloadSession
      ? reloadActionReady
        ? reloadGestureKind
          ? "GLAZE"
          : "CATCH"
        : reloadGestureKind
          ? "HOLD"
          : `${Math.round(reloadProgress)}%`
      : reloadMechanic === "triple-snap" && reloadSession
        ? reloadActionReady
          ? "SNAP"
          : `${tripleSnapStep}/3`
        : reloadMechanic === "pop-launch" && reloadSession
          ? reloadActionReady
            ? reloadGestureKind
              ? "UP!"
              : "GO"
            : reloadGestureKind
              ? "ARMED"
              : `${Math.round(reloadProgress)}%`
          : reloadInActiveWindow
            ? "OPEN"
            : reloadMechanic === "countdown" && reloadSession
              ? String(reloadSecondsRemaining)
              : `${Math.round(reloadProgress)}%`;
  const convergeWindow = reloadSession?.windows[0] ?? null;
  const convergeMidpointMs = convergeWindow
    ? (convergeWindow.startMs + convergeWindow.endMs) / 2
    : reloadSession?.durationMs ?? 1;
  const convergeProgress = reloadSession
    ? Math.min(100, (reloadElapsedMs / convergeMidpointMs) * 100)
    : 0;
  const boxesUntilUnlock = player
    ? Math.max(0, 3 - player.packsCleared)
    : 0;
  const twelvePackUnlocked = Boolean(
    player?.packsCleared === 3 && reloadPack?.id === "vanilla-12",
  );
  const reloadAccessibleShortcut = getAccessibleReloadShortcut(
    reloadPack?.reload.id,
  );
  const reloadEyebrow = twelvePackUnlocked
    ? "New · 12-pack unlocked"
    : boxesUntilUnlock > 0
      ? `${boxesUntilUnlock} box${boxesUntilUnlock === 1 ? "" : "es"} to the 12-pack`
      : reloadPack
        ? `${reloadPack.quantity}-count · ${reloadPack.reload.label}`
        : "Next box";
  const reloadButtonLabel = isCompletingReload
    ? reloadAttempt === "perfect"
      ? "Quick-open timing registered. Opening the box."
      : "Opening the reloaded box."
    : isStartingReload
      ? `Starting ${reloadPack?.reload.label ?? "the reload"}.`
      : reloadSession
        ? handsOffReload
          ? `${reloadPack?.name ?? "The box"} is opening automatically.`
          : reloadAttempt === "missed"
            ? "Quick-open timing missed. The box will finish automatically."
            : accessibleReloadPending
              ? "Accessible quick-open sequence complete. Waiting for the safe opening cue."
            : reloadSession.mechanic === "spiral-hold"
              ? reloadGestureKind
                ? "Keep holding, then release when GLAZE is active."
                : "Press and hold when CATCH is active."
              : reloadSession.mechanic === "triple-snap"
                ? `Chocolate snap ${Math.min(3, tripleSnapStep + 1)} of 3. Activate on its beat.`
                : reloadSession.mechanic === "pop-launch"
                  ? reloadGestureKind
                    ? "Swipe upward when PARTY is active. Keyboard players: press Arrow Up."
                    : "Press when LAUNCH is active to arm the pop."
            : reloadInActiveWindow
              ? "Quick-open window active. Activate now."
              : reloadPack?.reload.instruction ?? "Watch the reload timer."
        : `Start ${reloadPack?.reload.label ?? "the next box reload"}.`;
  const reloadDescription = isCompletingReload
    ? `Opening ${reloadPack?.name ?? "your next box"}.`
    : isStartingReload
      ? `Starting the ${reloadPack?.reload.label ?? "reload"} timer.`
      : reloadSession
        ? handsOffReload
          ? "No second click needed. Let the slow caramel pour finish on its own."
          : reloadAttempt === "missed"
            ? "Quick-open timing missed. Your full box will still open automatically."
            : accessibleReloadPending
              ? "Accessible quick-open sequence complete. The box will open automatically at the next safe cue."
            : reloadSession.mechanic === "pop-launch"
              ? `${reloadPack?.reload.instruction ?? "Launch the pop."} Keyboard: press Space or Enter on LAUNCH, then Arrow Up on PARTY. Screen-reader shortcut: activate twice right away; no timed cue is needed.`
              : reloadSession.mechanic === "spiral-hold"
                ? `${reloadPack?.reload.instruction ?? "Hold for the spiral."} Keyboard: hold Space or Enter, then release on GLAZE. Screen-reader shortcut: activate twice right away; no timed cue is needed.`
                : reloadSession.mechanic === "triple-snap"
                  ? `${reloadPack?.reload.instruction ?? "Snap the chocolate beats."} Screen-reader shortcut: activate three times right away; no timed cue is needed.`
                  : reloadPack?.reload.instruction ?? "Watch the timer for your opening."
        : reloadPack
          ? `${reloadPack.quantity} treats inside. ${reloadPack.reload.instruction}${reloadAccessibleShortcut ? ` ${reloadAccessibleShortcut}` : ""}`
          : "Start the next box reload.";
  const reloadMeterValueText = reloadAttempt === "perfect"
    ? "Quick-open timing registered. Opening the box."
    : reloadAttempt === "missed"
      ? "Quick-open timing missed. Reload will finish automatically."
      : handsOffReload
        ? `Slow pour in progress, ${Math.round(reloadProgress)} percent.`
        : reloadInteractionPrompt
          ? `${reloadInteractionPrompt}, ${Math.round(reloadProgress)} percent.`
          : `${reloadPack?.reload.label ?? "Reload"}, ${Math.round(reloadProgress)} percent.`;
  const packQuantity = player?.currentPack.quantity ?? 0;
  const packProgress = player
    ? Math.max(
        0,
        Math.min(packQuantity, packQuantity - player.sandwichesRemaining),
      )
    : 0;
  const showFeedTutorial = Boolean(
    player && player.packsCleared === 0 && player.sandwichesFed < 2,
  );
  const showMouthCue = showFeedTutorial && !isFeeding && !feedReaction;
  const canLaunch = Boolean(
    player &&
      portrait &&
      "mouth" in portrait &&
      !bootstrapError &&
      !packEmpty,
  );
  const showLauncher = Boolean(
    player && !bootstrapError && (!packEmpty || isFeeding),
  );
  const launcherGoal = boxesUntilUnlock > 0
    ? `${boxesUntilUnlock} box${boxesUntilUnlock === 1 ? "" : "es"} to the 12-pack`
    : player
      ? `Next box · ${player.nextPack.shortName}`
      : "Clear boxes · unlock flavors";

  useEffect(() => {
    if (!focusPackAfterFeedRef.current || !packEmpty || isFeeding) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      packButtonRef.current?.focus();
      focusPackAfterFeedRef.current = false;
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [isFeeding, packEmpty]);

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
          inert={hudPanelOpen ? true : undefined}
          aria-hidden={hudPanelOpen ? true : undefined}
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
              className={`mouth-target${showMouthCue ? " mouth-target-tutorial" : ""}`}
              style={mouthButtonStyle}
              type="button"
              onClick={handleFeed}
              disabled={isFeeding || offline}
              tabIndex={-1}
              aria-hidden="true"
            >
              {showMouthCue ? (
                <span className="mouth-target-label" aria-hidden="true">
                  feed here
                </span>
              ) : null}
            </button>
          ) : null}

          <FatboyProjectile
            idle={showLauncher && !sandwichTarget}
            target={shotUsesThree ? sandwichTarget : null}
            flightDurationMs={
              reducedMotion
                ? FATBOY_REDUCED_MOTION_DURATION_MS
                : FATBOY_THROW_DURATION_MS
            }
            onReadyChange={setThreeProjectileReady}
            reducedMotion={reducedMotion}
            spin={throwSpin}
          />
          {sandwichTarget && !shotUsesThree ? (
            <span
              className="sandwich-flight fatboy-sandwich-illustration"
              style={
                {
                  left: sandwichTarget.x,
                  top: sandwichTarget.y,
                  "--flight-duration": `${FATBOY_THROW_DURATION_MS}ms`,
                  "--flight-spin-end": `${8 + throwSpin.zTurns * 360}deg`,
                  "--flight-spin-mid": `${throwSpin.zTurns * 216}deg`,
                  "--flight-target-x": `${sandwichTarget.x}px`,
                  "--flight-target-y": `${sandwichTarget.y}px`,
                } as SandwichFlightStyle
              }
              aria-hidden="true"
            >
              <i />
            </span>
          ) : null}

          {feedReaction ? (
            <strong
              className={`feed-reaction${feedReaction.id % 2 === 0 ? " feed-reaction-tilt-right" : ""}`}
              key={feedReaction.id}
              style={{
                left: `clamp(100px, ${feedReaction.x}px, calc(100% - 100px))`,
                top: `max(96px, ${feedReaction.y}px)`,
              }}
              aria-hidden="true"
            >
              {feedReaction.message}
            </strong>
          ) : null}

          {showLauncher && player ? (
            <button
              className={`fatboy-launcher${isFeeding ? " fatboy-launcher-feeding" : ""}${showFeedTutorial ? " fatboy-launcher-tutorial" : ""}${isFeeding || offline || !canLaunch ? " fatboy-launcher-disabled" : ""}`}
              type="button"
              onClick={handleFeed}
              aria-disabled={isFeeding || offline || !canLaunch}
              aria-label={
                isFeeding && !sandwichTarget
                  ? packEmpty
                    ? "Box cleared. Getting the next box ready."
                    : `Getting the next FatBoy. ${player.sandwichesRemaining} left in this box.`
                  : `Throw FatBoy. ${player.sandwichesRemaining} ${player.sandwichesRemaining === 1 ? "sandwich" : "sandwiches"} left in this box.`
              }
              aria-describedby="mouth-instructions"
            >
              <span className="fatboy-launcher-prompt" aria-hidden="true">
                {isFeeding ? (
                  <strong>
                    {sandwichTarget
                      ? "Tossing…"
                      : packEmpty
                        ? "Box cleared!"
                        : "Getting next…"}
                  </strong>
                ) : null}
                <span>{launcherGoal}</span>
              </span>
              {!threeProjectileReady ? (
                <span
                  className="fatboy-sandwich-illustration fatboy-launcher-placeholder"
                  aria-hidden="true"
                >
                  <i />
                </span>
              ) : null}
              <span className="fatboy-launcher-count" aria-hidden="true">
                <strong>{player.sandwichesRemaining}</strong>
                <span>left</span>
              </span>
              <span className="fatboy-launcher-pips" aria-hidden="true">
                {Array.from({ length: packQuantity }, (_, index) => (
                  <i
                    className={
                      index < player.sandwichesRemaining
                        ? "fatboy-launcher-pip-ready"
                        : undefined
                    }
                    key={index}
                  />
                ))}
              </span>
            </button>
          ) : null}

          {packEmpty &&
          reloadPack &&
          !isFeeding &&
          !bootstrapError ? (
            <section
              className={`pack-reload pack-reload-${reloadMechanic ?? "precision"}${isCompletingReload ? " pack-reload-opening" : ""}${twelvePackUnlocked ? " pack-reload-unlocked" : ""}`}
              aria-labelledby="pack-reload-title"
              aria-describedby="pack-reload-description"
              onClick={(event) => event.stopPropagation()}
              style={reloadThemeStyle}
            >
              <div className="pack-mobile-summary" aria-hidden="true">
                <strong>Box cleared!</strong>
                <span>
                  {boxesUntilUnlock > 0
                    ? `${boxesUntilUnlock} more to the 12-pack`
                    : `${reloadPack.shortName} unlocked`}
                </span>
              </div>
              <div className="pack-reload-copy">
                <p>{reloadEyebrow}</p>
                <h2 id="pack-reload-title">{reloadPack.name}</h2>
                <div className="pack-reload-meta" aria-hidden="true">
                  <strong>{reloadPack.quantity}</strong>
                  <span>treats</span>
                  <i />
                  <span>{reloadPack.reload.label}</span>
                </div>
                <span id="pack-reload-description">
                  {reloadDescription}
                </span>
              </div>
              <div className="pack-reload-control">
                <button
                  ref={packButtonRef}
                  className={`pack-box-button${reloadGestureKind ? " pack-box-button-interacting" : ""}`}
                  type="button"
                  onClick={handleOpenPack}
                  onPointerDown={handlePackPointerDown}
                  onPointerMove={handlePackPointerMove}
                  onPointerUp={handlePackPointerUp}
                  onPointerCancel={handlePackPointerCancel}
                  onKeyDown={handlePackKeyDown}
                  onKeyUp={handlePackKeyUp}
                  disabled={
                    isStartingReload ||
                    isCompletingReload ||
                    accessibleReloadPending ||
                    offline ||
                    Boolean(
                      reloadSession &&
                        (handsOffReload || reloadAttempt !== "none"),
                    )
                  }
                  aria-label={reloadButtonLabel}
                  aria-describedby="pack-reload-description"
                  aria-keyshortcuts={
                    reloadMechanic === "pop-launch"
                      ? "Space Enter ArrowUp"
                      : reloadMechanic === "spiral-hold"
                        ? "Space Enter"
                        : undefined
                  }
                >
                  <img
                    src={reloadPack.imageSrc}
                    alt=""
                    width="1200"
                    height="1200"
                    draggable={false}
                    aria-hidden="true"
                  />
                  <span className="pack-quantity-badge" aria-hidden="true">
                    <strong>{reloadPack.quantity}</strong>
                    <span>ready</span>
                  </span>
                  <span className="pack-box-label">
                    {isCompletingReload
                      ? "opening…"
                      : isStartingReload
                        ? "starting…"
                        : reloadSession
                          ? reloadInteractionPrompt
                          : `start ${reloadPack.reload.label}`}
                  </span>
                </button>

                {reloadSession && reloadMeterStyle ? (
                  <div
                    className={`active-reload-meter active-reload-meter-${reloadSession.mechanic}${reloadActionReady ? " active-reload-meter-ready" : ""}${reloadGestureKind ? " active-reload-meter-interacting" : ""}${reloadAttempt === "perfect" ? " active-reload-meter-perfect" : ""}${reloadAttempt === "missed" ? " active-reload-meter-missed" : ""}`}
                    role="progressbar"
                    aria-label={`${reloadPack.reload.label} progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(reloadProgress)}
                    aria-valuetext={reloadMeterValueText}
                    style={reloadMeterStyle}
                  >
                    <span className="active-reload-fill" aria-hidden="true" />
                    {reloadVisualWindows.map((window, index) => (
                      <span
                        className={`active-reload-zone${isElapsedInWindow(reloadElapsedMs, window) ? " active-reload-zone-live" : ""}${reloadSession.mechanic === "triple-snap" && index < tripleSnapStep ? " active-reload-zone-complete" : ""}${(reloadSession.mechanic === "spiral-hold" || reloadSession.mechanic === "pop-launch") && index === 0 && reloadGestureKind ? " active-reload-zone-complete" : ""}`}
                        key={`${window.startMs}-${window.endMs}`}
                        style={{
                          left: `${(window.startMs / reloadSession.durationMs) * 100}%`,
                          width: `${((window.endMs - window.startMs) / reloadSession.durationMs) * 100}%`,
                        }}
                        aria-hidden="true"
                      >
                        <i>{index + 1}</i>
                      </span>
                    ))}
                    {reloadSession.mechanic === "converge" ? (
                      <>
                        <span
                          className="active-reload-indicator active-reload-indicator-left"
                          style={{ left: `${convergeProgress / 2}%` }}
                          aria-hidden="true"
                        />
                        <span
                          className="active-reload-indicator active-reload-indicator-right"
                          style={{ left: `${100 - convergeProgress / 2}%` }}
                          aria-hidden="true"
                        />
                      </>
                    ) : (
                      <span
                        className="active-reload-indicator"
                        aria-hidden="true"
                      />
                    )}
                    <strong className="active-reload-readout" aria-hidden="true">
                      {reloadReadout}
                    </strong>
                    <span
                      className="active-reload-zone-label"
                      aria-hidden="true"
                    >
                      {reloadAttempt === "perfect"
                        ? "opening early"
                        : reloadAttempt === "missed"
                          ? "auto finish"
                          : handsOffReload
                            ? "hands off"
                            : reloadInteractionPrompt ?? "quick open"}
                    </span>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
          <ClearedBoxStack count={clearedBoxesVisible} />
        </main>

        <header
          className="overlay-top"
          inert={hudPanelOpen ? true : undefined}
          aria-hidden={hudPanelOpen ? true : undefined}
        >
          <div className="brand-stack">
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
                  ? "getting the box ready"
                  : reloadSession
                    ? reloadInteractionPrompt ?? "watch the timer"
                    : `${reloadPack?.quantity ?? 0} treats · tap the box`
                : "Click the person’s mouth"}
            </p>
          </div>
          <div
            className={`play-status${isFeeding ? " play-status-scoring" : ""}`}
            aria-label={
              player
                ? `${player.sandwichesFed} people fed. ${packProgress} of ${packQuantity} sandwiches used in this box.`
                : "Game status loading"
            }
          >
            <span>
              <small>fed</small>
              <strong>
                {player ? numberFormatter.format(player.sandwichesFed) : "—"}
              </strong>
            </span>
            <span>
              <small>box</small>
              <strong>
                {player ? `${packProgress}/${packQuantity}` : "—"}
              </strong>
            </span>
          </div>
        </header>

        <footer
          className={`overlay-bottom${packEmpty ? " overlay-bottom-pack-empty" : ""}`}
          inert={hudPanelOpen ? true : undefined}
          aria-hidden={hudPanelOpen ? true : undefined}
        >
          <div className="footer-left">
            <p className="player-line">
              <span>{currentDisplayName ?? "getting ready…"}</span>
            </p>
          </div>

          <nav className="hud-controls" aria-label="Game menu">
            <button
              className="hud-control"
              type="button"
              onClick={(event) => {
                hudTriggerRef.current = event.currentTarget;
                setLeaderboardOpen(false);
                setGameInfoOpen(true);
              }}
              disabled={
                !player || isFeeding || isOpeningPack || Boolean(reloadSession)
              }
              aria-expanded={gameInfoOpen}
              aria-controls="game-info-panel"
              aria-label={`View game stats. Your score is ${player?.sandwichesFed ?? 0}.`}
            >
              <span>stats</span>
              <strong>
                {player ? numberFormatter.format(player.sandwichesFed) : "—"}
              </strong>
            </button>
            <button
              className="hud-control hud-control-ranks"
              type="button"
              onClick={(event) => {
                hudTriggerRef.current = event.currentTarget;
                setGameInfoOpen(false);
                setLeaderboardOpen(true);
              }}
              disabled={
                !player || isFeeding || isOpeningPack || Boolean(reloadSession)
              }
              aria-expanded={leaderboardOpen}
              aria-controls="leaderboard-panel"
            >
              <span>top</span>
              <strong>ranks</strong>
            </button>
          </nav>

          <p
            className={`save-state${offline ? " save-state-offline" : ""}`}
            role="status"
          >
            <span aria-hidden="true" />
            {saveStateLabel}
          </p>
        </footer>

        {offline ? (
          <p className="offline-plain" role="status">
            offline — reconnect to play
          </p>
        ) : null}
      </div>

      {hudPanelOpen ? (
        <div className="hud-panel-backdrop">
          <section
            className="hud-panel"
            id={gameInfoOpen ? "game-info-panel" : "leaderboard-panel"}
            role="dialog"
            aria-modal="true"
            aria-labelledby="hud-panel-title"
          >
            <header className="hud-panel-header">
              <div>
                <p>{gameInfoOpen ? "Your game" : "Leaderboard"}</p>
                <h2 id="hud-panel-title">
                  {gameInfoOpen
                    ? currentDisplayName ?? "Getting ready…"
                    : "Top feeders"}
                </h2>
              </div>
              <button
                className="hud-panel-close"
                type="button"
                onClick={() => {
                  setGameInfoOpen(false);
                  setLeaderboardOpen(false);
                  window.requestAnimationFrame(() =>
                    hudTriggerRef.current?.focus(),
                  );
                }}
                autoFocus
              >
                <span aria-hidden="true">×</span>
                <span className="sr-only">Close panel</span>
              </button>
            </header>

            {gameInfoOpen ? (
              <>
                <dl className="hud-stats" aria-label="Game statistics">
                  <div>
                    <dt>you</dt>
                    <dd>
                      {player
                        ? numberFormatter.format(player.sandwichesFed)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>everyone</dt>
                    <dd>
                      {globalTotal === null
                        ? "—"
                        : numberFormatter.format(globalTotal)}
                    </dd>
                  </div>
                  <div>
                    <dt>pack</dt>
                    <dd>
                      {player
                        ? `${player.sandwichesRemaining}/${player.currentPack.quantity}`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>streak</dt>
                    <dd>{numberFormatter.format(streak)}</dd>
                  </div>
                </dl>

                <div className="challenge-card">
                  <span>Next goal</span>
                  <strong>
                    {boxesUntilUnlock > 0
                      ? `Clear ${boxesUntilUnlock} more ${boxesUntilUnlock === 1 ? "box" : "boxes"} for the 12-pack`
                      : `Next up: ${player?.nextPack.shortName ?? "a new flavor"}`}
                  </strong>
                </div>

                <dl className="game-details">
                  <div>
                    <dt>Current box</dt>
                    <dd>{player?.currentPack.shortName ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Boxes cleared</dt>
                    <dd>
                      {player
                        ? numberFormatter.format(player.packsCleared)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{saveStateLabel}</dd>
                  </div>
                </dl>

                <div className="about-game">
                  <a
                    href="https://www.mistakes.party/"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Visit mistakes.party (opens in a new tab)"
                  >
                    mistakes.party
                  </a>
                  <p>
                    Made for humor. Not affiliated with, endorsed by, or
                    sponsored by any real brand, but I wouldn&apos;t mind it.
                  </p>
                </div>
              </>
            ) : (
              <div className="leaderboard-sheet">
                <p className="leaderboard-total">
                  {globalTotal === null
                    ? "Scores from every player"
                    : `${numberFormatter.format(globalTotal)} treats shared`}
                </p>
                <LeaderboardContents
                  leaders={leaders}
                  currentDisplayName={currentDisplayName}
                  loading={leaderboardLoading}
                />
              </div>
            )}
          </section>
        </div>
      ) : null}

      {notice ? (
        <div className="game-toast" role="status">
          {notice.message}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {urgentAnnouncement}
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
