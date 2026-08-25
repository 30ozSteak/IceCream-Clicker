"use client";

/* Local, already-optimized game assets intentionally use ordinary images so
   portrait crop geometry and mouth targeting share the exact rendered box. */
/* eslint-disable @next/next/no-img-element */

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
} from "../lib/client/portrait-geometry";

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

type DialogMode = "required" | "rename";

const numberFormatter = new Intl.NumberFormat("en-US");
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const nicknamePattern = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;
const placeholderRows = Array.from({ length: 10 }, (_, index) => index + 1);

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

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | null;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "stat-card stat-card-accent" : "stat-card"}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">
        {value === null ? "—" : numberFormatter.format(value)}
      </strong>
    </div>
  );
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
    return (
      <ol className="leader-list" aria-label="Leaderboard loading">
        {placeholderRows.map((rank) => (
          <li className="leader-row leader-row-loading" key={rank}>
            <span className="leader-rank">{rank}</span>
            <span className="leader-skeleton" />
            <span className="leader-skeleton leader-skeleton-score" />
          </li>
        ))}
      </ol>
    );
  }

  if (leaders.length === 0) {
    return (
      <div className="empty-leaderboard">
        <span className="empty-ribbon">First scoop</span>
        <strong>The leaderboard is wide open.</strong>
        <p>Feed the first sandwich and put your name on the board.</p>
      </div>
    );
  }

  return (
    <ol className="leader-list" aria-label="Top ten FatBoy feeders">
      {leaders.map((leader) => {
        const isCurrentPlayer = leader.displayName === currentDisplayName;
        return (
          <li
            className={`leader-row leader-row-${Math.min(leader.rank, 4)}${
              isCurrentPlayer ? " leader-row-current" : ""
            }`}
            key={`${leader.rank}-${leader.displayName}`}
            aria-current={isCurrentPlayer ? "true" : undefined}
          >
            <span className="leader-rank">{leader.rank}</span>
            <span className="leader-name" title={leader.displayName}>
              {leader.displayName}
              {isCurrentPlayer ? <small>You</small> : null}
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

function LeaderboardHeader({
  globalTotal,
  asOf,
}: {
  globalTotal: number | null;
  asOf: string | null;
}) {
  let updatedLabel = "Connecting…";
  if (asOf) {
    const updatedAt = new Date(asOf);
    if (!Number.isNaN(updatedAt.getTime())) {
      updatedLabel = `Updated ${timeFormatter.format(updatedAt)}`;
    }
  }

  return (
    <div className="leaderboard-heading">
      <div>
        <span className="eyebrow eyebrow-red">Live worldwide</span>
        <h2>Top feeders</h2>
      </div>
      <div className="leaderboard-total">
        <span>All time</span>
        <strong>
          {globalTotal === null ? "—" : numberFormatter.format(globalTotal)}
        </strong>
        <small>{updatedLabel}</small>
      </div>
    </div>
  );
}

function NicknameDialog({
  mode,
  value,
  error,
  saving,
  offline,
  onChange,
  onSubmit,
  onClose,
}: {
  mode: DialogMode;
  value: string;
  error: string | null;
  saving: boolean;
  offline: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const isRequired = mode === "required";

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal-card nickname-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nickname-title"
        aria-describedby="nickname-description"
      >
        <div className="modal-brand">
          <img
            src="/brand/fatboy-logo.png"
            alt="FatBoy"
            width="250"
            height="96"
          />
          <span>Feed Frenzy</span>
        </div>
        <span className="eyebrow eyebrow-red">
          {isRequired ? "Pick your player name" : "Change your name"}
        </span>
        <h2 id="nickname-title">
          {isRequired ? "Ready to feed the world?" : "Fresh name, same score."}
        </h2>
        <p id="nickname-description">
          Your progress stays on this browser. We’ll add a short tag so every
          name is unique on the leaderboard.
        </p>

        <form onSubmit={onSubmit} noValidate>
          <label htmlFor="nickname-input">Nickname</label>
          <div className="nickname-input-wrap">
            <input
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
              placeholder="Ice Cream Hero"
              disabled={saving}
            />
            <span aria-hidden="true">#••••</span>
          </div>
          <small id="nickname-hint">2–16 letters, numbers, and spaces</small>
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

          <div className="modal-actions">
            {isRequired ? null : (
              <button
                className="button button-ghost"
                type="button"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
            )}
            <button
              className="button button-primary"
              type="submit"
              disabled={saving || offline}
            >
              {saving ? "Saving…" : isRequired ? "Start feeding" : "Save name"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ResetDialog({
  resetting,
  error,
  offline,
  onCancel,
  onConfirm,
}: {
  resetting: boolean;
  error: string | null;
  offline: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal-card reset-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reset-title"
        aria-describedby="reset-description"
      >
        <span className="modal-warning" aria-hidden="true">
          !
        </span>
        <span className="eyebrow eyebrow-red">Reset progress</span>
        <h2 id="reset-title">Start over from zero?</h2>
        <p id="reset-description">
          This permanently removes your nickname and sandwich count from this
          browser. It cannot be undone.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {offline ? (
          <p className="form-error" role="status">
            Reconnect before resetting progress.
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            className="button button-ghost"
            type="button"
            onClick={onCancel}
            disabled={resetting}
            autoFocus
          >
            Keep playing
          </button>
          <button
            className="button button-danger"
            type="button"
            onClick={onConfirm}
            disabled={resetting || offline}
          >
            {resetting ? "Resetting…" : "Yes, reset everything"}
          </button>
        </div>
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
  const [leaderboardAsOf, setLeaderboardAsOf] = useState<string | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [streak, setStreak] = useState(0);
  const [isFeeding, setIsFeeding] = useState(false);
  const [geometry, setGeometry] = useState<CoverGeometry | null>(null);
  const [sandwichTarget, setSandwichTarget] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [missMarker, setMissMarker] = useState<{
    id: number;
    x: number;
    y: number;
  } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [nicknameMode, setNicknameMode] = useState<DialogMode | null>(null);
  const [nicknameInput, setNicknameInput] = useState("");
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [savingNickname, setSavingNickname] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const portraitImageRef = useRef<HTMLImageElement>(null);
  const feedLockRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const missTimerRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();

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
    setLeaderboardAsOf(data.asOf);
    setLeaderboardLoading(false);
  }, []);

  const loadEverything = useCallback(async () => {
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
  }, [applyLeaderboard]);

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
      setOffline(true);
      showNotice("You’re offline. Reconnect to keep feeding.", "error");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refreshLeaderboard, showNotice]);

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
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
      if (missTimerRef.current !== null) {
        window.clearTimeout(missTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleDialogEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (resetOpen && !resetting) {
        setResetOpen(false);
        setResetError(null);
        return;
      }

      if (nicknameMode === "rename" && !savingNickname) {
        setNicknameMode(null);
        setNicknameError(null);
      }
    };

    document.addEventListener("keydown", handleDialogEscape);
    return () => document.removeEventListener("keydown", handleDialogEscape);
  }, [nicknameMode, resetOpen, resetting, savingNickname]);

  const effectiveNicknameMode = useMemo<DialogMode | null>(() => {
    if (nicknameMode) {
      return nicknameMode;
    }
    if (!loading && game && !game.player.nickname) {
      return "required";
    }
    return null;
  }, [game, loading, nicknameMode]);

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

  const handleMiss = (event: ReactMouseEvent<HTMLDivElement>) => {
    const stageRect = event.currentTarget.getBoundingClientRect();
    const marker = {
      id: Date.now(),
      x: event.clientX - stageRect.left - event.currentTarget.clientLeft,
      y: event.clientY - stageRect.top - event.currentTarget.clientTop,
    };

    if (missTimerRef.current !== null) {
      window.clearTimeout(missTimerRef.current);
    }
    setMissMarker(marker);
    setStreak(0);
    showNotice("Missed! Aim for the pulsing mouth target.", "miss");
    missTimerRef.current = window.setTimeout(() => {
      setMissMarker((current) => (current?.id === marker.id ? null : current));
      missTimerRef.current = null;
    }, reducedMotion ? 300 : 800);
  };

  const resyncAfterFeedError = useCallback(
    async (fallbackGame: GameResponse) => {
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
    [applyLeaderboard],
  );

  const handleFeed = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      !game ||
      !displayPortrait ||
      !("mouth" in displayPortrait) ||
      feedLockRef.current ||
      offline
    ) {
      return;
    }

    feedLockRef.current = true;
    setIsFeeding(true);

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

    setSandwichTarget(target);
    setGame({
      ...snapshot,
      player: {
        ...snapshot.player,
        sandwichesFed: snapshot.player.sandwichesFed + 1,
      },
    });
    setGlobalTotal((current) => (current === null ? null : current + 1));
    setStreak(previousStreak + 1);
    setAnnouncement(
      `Sandwich fed. Your total is ${snapshot.player.sandwichesFed + 1}.`,
    );

    const feedRequest = requestJson<ApiGameResponse>("/api/feed", {
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
          return { ok: true as const, data: normalizeGameResponse(data) };
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

  const openRenameDialog = () => {
    setNicknameInput(game?.player.nickname ?? "");
    setNicknameError(null);
    setNicknameMode("rename");
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
      setNicknameMode(null);
      showNotice(
        game.player.nickname ? "Nickname updated." : "Welcome to Feed Frenzy!",
        "success",
      );
      void refreshLeaderboard().catch(() => undefined);
    } catch (error) {
      setNicknameError(getFriendlyError(error));
    } finally {
      setSavingNickname(false);
    }
  };

  const confirmReset = async () => {
    if (resetting) {
      return;
    }

    setResetting(true);
    setResetError(null);

    try {
      const response = await fetch("/api/player", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new ApiError(await readErrorMessage(response), response.status);
      }

      setResetOpen(false);
      setGame(null);
      setDisplayPortrait(null);
      setLeaders([]);
      setGlobalTotal(null);
      setLeaderboardAsOf(null);
      setStreak(0);
      setNicknameInput("");
      setNicknameMode(null);
      await loadEverything();
      showNotice("Progress reset. Your fresh start is ready.", "success");
    } catch (error) {
      setResetError(getFriendlyError(error));
    } finally {
      setResetting(false);
    }
  };

  const player = game?.player ?? null;
  const portrait = displayPortrait;
  const currentDisplayName = player?.displayName ?? null;
  const modalOpen = Boolean(effectiveNicknameMode || resetOpen);

  return (
    <div className="game-shell">
      <div className="background-scoop background-scoop-one" />
      <div className="background-scoop background-scoop-two" />

      <header
        className="site-header"
        inert={modalOpen ? true : undefined}
        aria-hidden={modalOpen ? true : undefined}
      >
        <a className="brand-lockup" href="#game" aria-label="FatBoy Feed Frenzy home">
          <img
            className="brand-logo"
            src="/brand/fatboy-logo.png"
            alt="FatBoy"
            width="250"
            height="96"
          />
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-game-name">Feed Frenzy</span>
        </a>

        <div className="player-controls">
          <div className="connection-status" role="status">
            <span
              className={offline ? "status-dot status-dot-offline" : "status-dot"}
            />
            {offline ? "Offline" : loading ? "Connecting" : isFeeding ? "Saving" : "Saved"}
          </div>
          <div className="player-identity">
            <span>Your player</span>
            <strong>{currentDisplayName ?? "Getting ready…"}</strong>
          </div>
          <button
            className="header-action"
            type="button"
            onClick={openRenameDialog}
            disabled={!player || isFeeding}
          >
            Rename
          </button>
          <button
            className="header-action header-action-danger"
            type="button"
            onClick={() => {
              setResetError(null);
              setResetOpen(true);
            }}
            disabled={!player || isFeeding}
          >
            Reset
          </button>
        </div>
      </header>

      {offline ? (
        <div className="offline-banner" role="status">
          You’re offline — reconnect to feed another sandwich.
        </div>
      ) : null}

      <main
        className="game-main"
        id="game"
        inert={modalOpen ? true : undefined}
        aria-hidden={modalOpen ? true : undefined}
      >
        <div className="play-layout">
          <section className="play-column" aria-labelledby="game-title">
            <div className="game-intro">
              <div>
                <span className="eyebrow">America’s #1 ice cream sandwich</span>
                <h1 id="game-title">Feed the world.</h1>
              </div>
              <p id="mouth-instructions">
                Tap the pulsing mouth, serve a FatBoy, meet someone new.
              </p>
            </div>

            <div className="stats-grid" aria-label="Game statistics">
              <StatCard
                label="You fed"
                value={player?.sandwichesFed ?? null}
                accent
              />
              <StatCard label="Everyone fed" value={globalTotal} />
              <StatCard label="Streak" value={streak} />
            </div>

            <div
              className={`portrait-stage${isFeeding ? " portrait-stage-feeding" : ""}`}
              ref={stageRef}
              onClick={handleMiss}
              aria-busy={loading || isFeeding}
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
                  <span className="loading-scoop" aria-hidden="true" />
                  <strong>Opening the freezer…</strong>
                  <span>Your first face is on the way.</span>
                </div>
              ) : null}

              {!loading && bootstrapError ? (
                <div className="stage-state stage-error" role="alert">
                  <span className="stage-state-icon" aria-hidden="true">
                    !
                  </span>
                  <strong>We hit a brain freeze.</strong>
                  <span>{bootstrapError}</span>
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={() => void loadEverything()}
                  >
                    Try again
                  </button>
                </div>
              ) : null}

              {portrait && "mouth" in portrait && !bootstrapError ? (
                <>
                  <div className="target-label" aria-hidden="true">
                    Target ready
                  </div>
                  <button
                    className="mouth-target"
                    style={mouthButtonStyle}
                    type="button"
                    onClick={handleFeed}
                    disabled={isFeeding || offline}
                    aria-label="Feed this person a FatBoy ice cream sandwich"
                    aria-describedby="mouth-instructions"
                  >
                    <span className="mouth-target-dot" aria-hidden="true" />
                    <span className="sr-only">Feed sandwich</span>
                  </button>
                </>
              ) : null}

              {sandwichTarget ? (
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

              {missMarker ? (
                <span
                  className="miss-marker"
                  style={{ left: missMarker.x, top: missMarker.y }}
                  aria-hidden="true"
                >
                  <span />
                </span>
              ) : null}

              {portrait ? (
                <div className="stage-instruction" aria-hidden="true">
                  <span className="instruction-pulse" />
                  Aim for the mouth
                </div>
              ) : null}
            </div>
          </section>

          <aside
            className="leaderboard-card leaderboard-desktop"
            aria-label="Leaderboard"
          >
            <LeaderboardHeader globalTotal={globalTotal} asOf={leaderboardAsOf} />
            <LeaderboardContents
              leaders={leaders}
              currentDisplayName={currentDisplayName}
              loading={leaderboardLoading}
            />
            <p className="leaderboard-note">
              Scores refresh every 10 seconds. Progress is saved on this browser.
            </p>
          </aside>

          <details className="leaderboard-card leaderboard-mobile">
            <summary>
              <span>
                <span className="eyebrow eyebrow-red">Live worldwide</span>
                <strong>Top feeders</strong>
              </span>
              <span className="mobile-global-total">
                {globalTotal === null ? "—" : numberFormatter.format(globalTotal)} fed
              </span>
              <span className="details-chevron" aria-hidden="true" />
            </summary>
            <div className="mobile-leaderboard-content">
              <LeaderboardContents
                leaders={leaders}
                currentDisplayName={currentDisplayName}
                loading={leaderboardLoading}
              />
              <p className="leaderboard-note">
                Scores refresh every 10 seconds. Progress is saved on this browser.
              </p>
            </div>
          </details>
        </div>
      </main>

      {notice ? (
        <div className={`game-toast game-toast-${notice.tone}`} role="status">
          {notice.message}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {effectiveNicknameMode ? (
        <NicknameDialog
          mode={effectiveNicknameMode}
          value={nicknameInput}
          error={nicknameError}
          saving={savingNickname}
          offline={offline}
          onChange={(value) => {
            setNicknameInput(value);
            setNicknameError(null);
          }}
          onSubmit={submitNickname}
          onClose={() => {
            setNicknameMode(null);
            setNicknameError(null);
          }}
        />
      ) : null}

      {resetOpen ? (
        <ResetDialog
          resetting={resetting}
          error={resetError}
          offline={offline}
          onCancel={() => {
            setResetOpen(false);
            setResetError(null);
          }}
          onConfirm={() => void confirmReset()}
        />
      ) : null}
    </div>
  );
}
