"use client";

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FEEDERS,
  FRENZY_DURATION_MS,
  FRENZY_MULTIPLIER,
  type Progress,
  SUGAR_RUSH_DURATION_MS,
  SUGAR_RUSH_MULTIPLIER,
  UNLOCK_BRAIN_FREEZE,
  appetiteFor,
  currentFlavor,
  feederCost,
  hasUnlock,
  idleRate,
  nextUnlock,
  isBigEater,
  tapUpgradeCost,
  tapValue,
} from "../lib/economy";
import { getFeedReaction } from "../lib/feed-reactions";
import { formatAmount, formatRate } from "../lib/number-format";
import { PORTRAITS, type Portrait } from "../lib/portraits";
import { BonusLayer } from "./game/BonusLayer";
import { ShopSheet } from "./game/ShopSheet";
import { Stage, type StageHandle } from "./game/Stage";
import { useGameEngine } from "./game/useGameEngine";

type Player = {
  nickname: string | null;
  publicTag: string;
  displayName: string;
  sandwichesFed: number;
};

type Leader = {
  rank: number;
  displayName: string;
  sandwichesFed: number;
};

type ApiLeaderboardResponse = {
  leaders: Array<{
    rank?: number;
    position?: number;
    displayName: string;
    sandwichesFed: number;
  }>;
  globalTotal: number;
};

type HudPanel = "stats" | "ranks" | null;

type FlavorStyle = CSSProperties & {
  "--flavor-accent": string;
  "--flavor-accent-soft": string;
};

const nicknamePattern = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;
const STORAGE_PREFIX = "icecream-clicker.progress.v1.";

const LOCAL_GUEST: Player = {
  nickname: "Guest",
  publicTag: "LOCL",
  displayName: "Guest (this device only)",
  sandwichesFed: 0,
};

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

async function fetchPlayer() {
  const data = await requestJson<{ player: Player }>("/api/game", {
    cache: "no-store",
  });
  return data.player;
}

async function fetchLeaderboard() {
  const data = await requestJson<ApiLeaderboardResponse>("/api/leaderboard", {
    cache: "no-store",
  });
  return {
    leaders: data.leaders.map((leader, index) => ({
      rank: leader.rank ?? leader.position ?? index + 1,
      displayName: leader.displayName,
      sandwichesFed: leader.sandwichesFed,
    })),
    globalTotal: data.globalTotal,
  };
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

/** Each player meets the customers in their own fixed order. */
function shufflePortraits(seed: string): readonly Portrait[] {
  let state = 2166136261;
  for (const character of seed) {
    state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  }
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
  const order: Portrait[] = [...PORTRAITS];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

function canAffordSomething(progress: Progress) {
  if (progress.scoops >= tapUpgradeCost(progress.tapLevel)) {
    return true;
  }
  const unlock = nextUnlock(progress);
  if (unlock && progress.scoops >= unlock.cost) {
    return true;
  }
  return FEEDERS.some(
    (_, index) => progress.scoops >= feederCost(index, progress.feeders[index]),
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
    return <p className="leaderboard-status">Loading…</p>;
  }
  if (leaders.length === 0) {
    return <p className="leaderboard-status">No scores yet.</p>;
  }

  return (
    <ol className="leader-list" aria-label="Top ten feeders">
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
              {formatAmount(leader.sandwichesFed)}
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
        <p className="plain-dialog-kicker">One-thumb feed frenzy</p>
        <h2 id="nickname-title">Feed the crowd.</h2>
        <p id="nickname-description">
          Tap anywhere to feed the customer. Fill them up, spend your scoops on
          helpers, and keep the line moving.
        </p>

        <ol className="onboarding-loop" aria-label="How to play">
          <li>
            <strong>1</strong>
            <span>Tap to feed</span>
          </li>
          <li>
            <strong>2</strong>
            <span>Fill customers</span>
          </li>
          <li>
            <strong>3</strong>
            <span>Buy helpers</span>
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
  const [player, setPlayer] = useState<Player | null>(null);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [globalTotal, setGlobalTotal] = useState<number | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [hudPanel, setHudPanel] = useState<HudPanel>(null);
  const [shopOpen, setShopOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [nicknameInput, setNicknameInput] = useState("");
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [savingNickname, setSavingNickname] = useState(false);

  const stageHandleRef = useRef<StageHandle | null>(null);
  const hudTriggerRef = useRef<HTMLButtonElement | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2_600);
  }, []);

  const nicknameRequired = Boolean(player && !player.nickname);
  const engine = useGameEngine(
    player?.nickname ? `${STORAGE_PREFIX}${player.publicTag}` : null,
    player?.sandwichesFed ?? 0,
    {
      onServed: (served) => {
        stageHandleRef.current?.celebrate(
          served.bigEater ? "Big eater down!" : getFeedReaction(served.customer),
          served.bonus,
        );
      },
      onMilestone: (milestone) => {
        showNotice(
          `${formatAmount(milestone.goal)} fed! +${formatAmount(milestone.reward)} scoops`,
        );
      },
      onBigEaterEscaped: () => {
        showNotice("Still hungry! Stock up in the shop and try again.");
      },
      onAwayEarnings: (amount) => {
        showNotice(`Your helpers fed ${formatAmount(amount)} while you were away.`);
      },
      onFrenzy: () => {
        showNotice(`Brain Freeze! Everything ×${FRENZY_MULTIPLIER}`);
      },
    },
  );
  const {
    progress,
    bigEaterRemainingMs,
    boosts,
    tap,
    claimBonus,
    buyTapUpgrade,
    buyFeeder,
    buyUnlock,
  } = engine;

  const catchBonus = useCallback(
    (kind: Parameters<typeof claimBonus>[0], x: number, y: number) => {
      const result = claimBonus(kind);
      if (result) {
        stageHandleRef.current?.popText(result.label, x, y, result.tone);
        if (typeof navigator.vibrate === "function") {
          navigator.vibrate(result.tone === "boost" ? [20, 40, 20] : 15);
        }
      }
    },
    [claimBonus],
  );

  const refreshLeaderboard = useCallback(async () => {
    const data = await fetchLeaderboard();
    setLeaders(data.leaders);
    setGlobalTotal(data.globalTotal);
    setLeaderboardLoading(false);
  }, []);

  const loadEverything = useCallback(async () => {
    setLoading(true);
    setBootstrapError(null);
    setLocalOnly(false);

    const [playerResult] = await Promise.allSettled([
      fetchPlayer(),
      refreshLeaderboard().catch(() => setLeaderboardLoading(false)),
    ]);

    if (playerResult.status === "fulfilled") {
      setPlayer(playerResult.value);
      setNicknameInput(playerResult.value.nickname ?? "");
    } else if (
      playerResult.reason instanceof ApiError &&
      playerResult.reason.status === 503
    ) {
      // The game runs on the device, so a missing or sleeping database only
      // costs the leaderboard, not the session.
      setPlayer(LOCAL_GUEST);
      setLocalOnly(true);
    } else {
      setBootstrapError(getFriendlyError(playerResult.reason));
    }
    setLoading(false);
    setOffline(!window.navigator.onLine);
  }, [refreshLeaderboard]);

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
      void refreshLeaderboard().catch(() => undefined);
    };
    const handleOffline = () => setOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refreshLeaderboard]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const closeHudPanel = useCallback(() => {
    setHudPanel(null);
    window.requestAnimationFrame(() => hudTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!hudPanel && !shopOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (hudPanel) {
        closeHudPanel();
      } else {
        setShopOpen(false);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [closeHudPanel, hudPanel, shopOpen]);

  const submitNickname = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!player || savingNickname) {
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
      const result = await requestJson<{ player: Player }>("/api/player", {
        method: "PATCH",
        body: JSON.stringify({ nickname: normalized }),
      });
      setPlayer({
        ...player,
        ...result.player,
        nickname: result.player.nickname ?? normalized,
        displayName:
          result.player.displayName || `${normalized} #${player.publicTag}`,
      });
      setNicknameInput(normalized);
      void refreshLeaderboard().catch(() => undefined);
    } catch (error) {
      setNicknameError(getFriendlyError(error));
    } finally {
      setSavingNickname(false);
    }
  };

  const portraitOrder = useMemo(
    () => (player ? shufflePortraits(player.publicTag) : null),
    [player],
  );
  const customer = progress?.customer ?? 1;
  const portrait = portraitOrder
    ? portraitOrder[(customer - 1) % portraitOrder.length]
    : null;
  const nextPortrait = portraitOrder
    ? portraitOrder[customer % portraitOrder.length]
    : null;
  const bigEater = isBigEater(customer);
  const appetite = appetiteFor(customer);
  const hungerPercent = progress
    ? Math.min(100, (progress.customerProgress / appetite) * 100)
    : 0;
  const perSecond = progress ? idleRate(progress) : 0;
  const perTap = progress ? tapValue(progress) : 1;
  const flavor = progress ? currentFlavor(progress) : null;
  const shopHasDeal = progress ? canAffordSomething(progress) : false;
  const showTapHint = Boolean(
    progress && progress.lifetimeFed < 5 && !shopOpen && !hudPanel,
  );
  const currentDisplayName = player?.displayName ?? null;
  const flavorStyle: FlavorStyle | undefined = flavor
    ? {
        "--flavor-accent": flavor.accent,
        "--flavor-accent-soft": flavor.accentSoft,
      }
    : undefined;

  return (
    <div className="game-shell" style={flavorStyle}>
      <div
        className="game-scene"
        inert={nicknameRequired ? true : undefined}
        aria-hidden={nicknameRequired ? true : undefined}
      >
        <Stage
          portrait={progress ? portrait : null}
          nextPortraitSrc={nextPortrait?.src ?? null}
          bigEater={bigEater}
          reducedMotion={reducedMotion}
          inert={hudPanel !== null}
          onFeed={tap}
          handleRef={stageHandleRef}
        >
          {loading ? (
            <div className="stage-state" role="status">
              <strong>Loading…</strong>
            </div>
          ) : null}
          {!loading && bootstrapError ? (
            <div
              className="stage-state"
              role="alert"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <strong>Something went wrong.</strong>
              <span>{bootstrapError}</span>
              <button
                className="text-action"
                type="button"
                onClick={() => void loadEverything()}
              >
                try again
              </button>
            </div>
          ) : null}
          {progress ? (
            <BonusLayer
              unlocks={progress.unlocks}
              paused={hudPanel !== null || nicknameRequired}
              onCatch={catchBonus}
            />
          ) : null}
          {showTapHint ? (
            <p className="tap-hint" aria-hidden="true">
              tap anywhere to feed
            </p>
          ) : null}
        </Stage>

        {progress ? (
          <header className="hud-top">
            <p
              className="hud-bank"
              aria-label={`${formatAmount(progress.scoops)} scoops, ${formatRate(perSecond)} per second`}
            >
              <strong>{formatAmount(progress.scoops)}</strong>
              <span>
                scoops · {formatRate(perSecond)}/s · {formatRate(perTap)}/tap
              </span>
            </p>
            <div
              className={`hunger${bigEater ? " hunger-big-eater" : ""}`}
              role="progressbar"
              aria-label={`Customer ${customer} hunger`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hungerPercent)}
            >
              <p className="hunger-label">
                <strong>{bigEater ? "Big eater" : `Customer ${customer}`}</strong>
                <span>
                  {formatAmount(progress.customerProgress)} / {formatAmount(appetite)}
                </span>
              </p>
              <div className="hunger-track">
                <i style={{ width: `${hungerPercent}%` }} />
              </div>
              {bigEater && bigEaterRemainingMs !== null ? (
                <p className="hunger-timer">
                  {Math.ceil(bigEaterRemainingMs / 1_000)}s to fill them up
                </p>
              ) : null}
            </div>
            {hasUnlock(progress, UNLOCK_BRAIN_FREEZE) || boosts.rushRemainingMs > 0 ? (
              <div className="boosts">
                {hasUnlock(progress, UNLOCK_BRAIN_FREEZE) ? (
                  <div
                    className={`boost boost-freeze${boosts.frenzyRemainingMs > 0 ? " boost-on" : ""}`}
                    role="progressbar"
                    aria-label="Brain Freeze meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                      boosts.frenzyRemainingMs > 0
                        ? 100
                        : Math.round(boosts.frenzyMeter * 100)
                    }
                  >
                    <i
                      style={{
                        width: `${boosts.frenzyRemainingMs > 0 ? (boosts.frenzyRemainingMs / FRENZY_DURATION_MS) * 100 : boosts.frenzyMeter * 100}%`,
                      }}
                    />
                    <span>
                      {boosts.frenzyRemainingMs > 0
                        ? `Brain Freeze ×${FRENZY_MULTIPLIER} · ${Math.ceil(boosts.frenzyRemainingMs / 1_000)}s`
                        : "Brain Freeze · tap fast"}
                    </span>
                  </div>
                ) : null}
                {boosts.rushRemainingMs > 0 ? (
                  <div className="boost boost-rush boost-on">
                    <i style={{ width: `${(boosts.rushRemainingMs / SUGAR_RUSH_DURATION_MS) * 100}%` }} />
                    <span>
                      Sugar Rush ×{SUGAR_RUSH_MULTIPLIER} ·{" "}
                      {Math.ceil(boosts.rushRemainingMs / 1_000)}s
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </header>
        ) : null}

        {progress ? (
          <footer className="dock">
            {shopOpen ? (
              <ShopSheet
                progress={progress}
                onBuyTapUpgrade={buyTapUpgrade}
                onBuyFeeder={buyFeeder}
                onBuyUnlock={buyUnlock}
                onClose={() => setShopOpen(false)}
              />
            ) : null}
            <nav className="tabbar" aria-label="Game menu">
              <button
                className={`tab${shopOpen ? " tab-active" : ""}${shopHasDeal && !shopOpen ? " tab-alert" : ""}`}
                type="button"
                onClick={() => setShopOpen((open) => !open)}
                aria-expanded={shopOpen}
                aria-controls="shop-sheet"
              >
                <span aria-hidden="true">🛍️</span>
                <strong>Shop</strong>
                {shopHasDeal && !shopOpen ? (
                  <span className="sr-only">You can afford something.</span>
                ) : null}
              </button>
              <button
                className="tab"
                type="button"
                onClick={(event) => {
                  hudTriggerRef.current = event.currentTarget;
                  setHudPanel("ranks");
                }}
                aria-expanded={hudPanel === "ranks"}
              >
                <span aria-hidden="true">🏆</span>
                <strong>Ranks</strong>
              </button>
              <button
                className="tab"
                type="button"
                onClick={(event) => {
                  hudTriggerRef.current = event.currentTarget;
                  setHudPanel("stats");
                }}
                aria-expanded={hudPanel === "stats"}
              >
                <span aria-hidden="true">📊</span>
                <strong>Stats</strong>
              </button>
            </nav>
          </footer>
        ) : null}
      </div>

      {hudPanel && progress ? (
        <div className="hud-panel-backdrop">
          <section
            className="hud-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hud-panel-title"
          >
            <header className="hud-panel-header">
              <div>
                <p>{hudPanel === "stats" ? "Your game" : "Leaderboard"}</p>
                <h2 id="hud-panel-title">
                  {hudPanel === "stats"
                    ? currentDisplayName ?? "Getting ready…"
                    : "Top feeders"}
                </h2>
              </div>
              <button
                className="hud-panel-close"
                type="button"
                onClick={closeHudPanel}
                autoFocus
              >
                <span aria-hidden="true">×</span>
                <span className="sr-only">Close panel</span>
              </button>
            </header>

            {hudPanel === "stats" ? (
              <>
                <dl className="hud-stats" aria-label="Game statistics">
                  <div>
                    <dt>total fed</dt>
                    <dd>{formatAmount(progress.lifetimeFed)}</dd>
                  </div>
                  <div>
                    <dt>customers</dt>
                    <dd>{formatAmount(progress.customer - 1)}</dd>
                  </div>
                  <div>
                    <dt>per tap</dt>
                    <dd>{formatRate(perTap)}</dd>
                  </div>
                  <div>
                    <dt>per second</dt>
                    <dd>{formatRate(perSecond)}</dd>
                  </div>
                </dl>

                <dl className="game-details">
                  <div>
                    <dt>Flavor</dt>
                    <dd>{flavor?.name ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Everyone</dt>
                    <dd>
                      {globalTotal === null ? "—" : formatAmount(globalTotal)}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      {localOnly
                        ? "server unavailable, saved on this device"
                        : offline
                          ? "offline"
                          : "saved on this device"}
                    </dd>
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
                    : `${formatAmount(globalTotal)} treats shared`}
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
        <div className="game-toast game-toast-top" role="status">
          {notice}
        </div>
      ) : null}

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
