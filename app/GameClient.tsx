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
    <div className="plain-dialog-backdrop" role="presentation">
      <section
        className="plain-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nickname-title"
        aria-describedby="nickname-description"
      >
        <p className="plain-kicker">FatBoy Feed Frenzy</p>
        <h2 id="nickname-title">
          {isRequired ? "Choose a name." : "Change your name."}
        </h2>
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
              {saving ? "saving…" : isRequired ? "start" : "save"}
            </button>
            {isRequired ? null : (
              <button
                className="text-action"
                type="button"
                onClick={onClose}
                disabled={saving}
              >
                cancel
              </button>
            )}
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
    <div className="plain-dialog-backdrop" role="presentation">
      <section
        className="plain-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reset-title"
        aria-describedby="reset-description"
      >
        <p className="plain-kicker">Reset progress</p>
        <h2 id="reset-title">Start over?</h2>
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
        <div className="plain-actions">
          <button
            className="text-action"
            type="button"
            onClick={onCancel}
            disabled={resetting}
            autoFocus
          >
            cancel
          </button>
          <button
            className="text-action"
            type="button"
            onClick={onConfirm}
            disabled={resetting || offline}
          >
            {resetting ? "resetting…" : "reset everything"}
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
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [streak, setStreak] = useState(0);
  const [isFeeding, setIsFeeding] = useState(false);
  const [isOpeningPack, setIsOpeningPack] = useState(false);
  const [geometry, setGeometry] = useState<CoverGeometry | null>(null);
  const [sandwichTarget, setSandwichTarget] = useState<{
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
  const packLockRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
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

  const handleMiss = () => {
    if (game?.player.sandwichesRemaining === 0 || isOpeningPack) {
      return;
    }
    setStreak(0);
    showNotice("Miss. Click the mouth.", "miss");
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
      game.player.sandwichesRemaining === 0 ||
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
        sandwichesRemaining: Math.max(
          0,
          snapshot.player.sandwichesRemaining - 1,
        ),
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

  const handleOpenPack = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      !game ||
      game.player.sandwichesRemaining > 0 ||
      packLockRef.current ||
      offline
    ) {
      return;
    }

    packLockRef.current = true;
    setIsOpeningPack(true);
    const snapshot = game;

    try {
      const result = normalizeGameResponse(
        await requestJson<ApiGameResponse>("/api/pack", {
          method: "POST",
          body: JSON.stringify({
            expectedScoreVersion: snapshot.player.scoreVersion,
          }),
        }),
      );
      setGame(result);
      setDisplayPortrait(result.round.current);
      showNotice("Fresh pack opened. Six sandwiches ready!", "success");
    } catch (error) {
      try {
        const synced = await fetchGame();
        setGame(synced);
        setDisplayPortrait(synced.round.current);
        if (synced.player.sandwichesRemaining > 0) {
          showNotice("Fresh pack opened. Six sandwiches ready!", "success");
        } else {
          showNotice(getFriendlyError(error), "error");
        }
      } catch {
        setGame(snapshot);
        setDisplayPortrait(snapshot.round.current);
        showNotice(getFriendlyError(error), "error");
      }
    } finally {
      setIsOpeningPack(false);
      packLockRef.current = false;
    }
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
      setStreak(0);
      setIsOpeningPack(false);
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
  const packEmpty = player?.sandwichesRemaining === 0;

  return (
    <div className="game-shell">
      <div
        className="game-scene"
        inert={modalOpen ? true : undefined}
        aria-hidden={modalOpen ? true : undefined}
      >
        <main
          className={`portrait-stage${isFeeding ? " portrait-stage-feeding" : ""}${packEmpty ? " portrait-stage-pack-empty" : ""}`}
          id="game"
          ref={stageRef}
          onClick={handleMiss}
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
              aria-label="Feed this person a FatBoy ice cream sandwich"
              aria-describedby="mouth-instructions"
            >
              <span className="sr-only">Feed sandwich</span>
            </button>
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

          {packEmpty && !isFeeding && !bootstrapError ? (
            <section
              className={`pack-reload${isOpeningPack ? " pack-reload-opening" : ""}`}
              aria-labelledby="pack-reload-title"
              aria-describedby="pack-reload-description"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="pack-reload-copy">
                <p>Pack empty</p>
                <h2 id="pack-reload-title">Open a fresh six-pack.</h2>
                <span id="pack-reload-description">
                  Click the box to reload your sandwiches.
                </span>
              </div>
              <button
                className="pack-box-button"
                type="button"
                onClick={handleOpenPack}
                disabled={isOpeningPack || offline}
                aria-label="Open a new six-pack of FatBoy ice cream sandwiches"
              >
                <img
                  src="/brand/fatboy-vanilla-6-pack.webp"
                  alt=""
                  width="2048"
                  height="2048"
                  draggable={false}
                  aria-hidden="true"
                />
                <span>{isOpeningPack ? "opening…" : "click to open"}</span>
              </button>
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
              <span>Feed Frenzy</span>
            </h1>
            <p className="game-instruction" id="mouth-instructions">
              {packEmpty
                ? "pack empty · click the box"
                : `click the mouth · ${player?.sandwichesRemaining ?? 6} left in pack`}
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
              <dd>
                {player ? `${player.sandwichesRemaining}/6` : "—"}
              </dd>
            </div>
            <div>
              <dt>streak</dt>
              <dd>{numberFormatter.format(streak)}</dd>
            </div>
          </dl>
        </header>

        <aside className="leaderboard-plain" aria-label="Leaderboard">
          <p className="overlay-label">Top feeders</p>
          <LeaderboardContents
            leaders={leaders}
            currentDisplayName={currentDisplayName}
            loading={leaderboardLoading}
          />
        </aside>

        <footer className="overlay-bottom">
          <div className="player-line">
            <span>{currentDisplayName ?? "getting ready…"}</span>
            <button
              className="text-action"
              type="button"
              onClick={openRenameDialog}
              disabled={!player || isFeeding || isOpeningPack}
            >
              rename
            </button>
            <span aria-hidden="true">·</span>
            <button
              className="text-action"
              type="button"
              onClick={() => {
                setResetError(null);
                setResetOpen(true);
              }}
              disabled={!player || isFeeding || isOpeningPack}
            >
              reset
            </button>
          </div>
          <p className="save-state" role="status">
            {offline
              ? "offline"
              : loading
                ? "connecting"
                : isFeeding
                  ? "saving"
                  : isOpeningPack
                    ? "opening pack"
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
