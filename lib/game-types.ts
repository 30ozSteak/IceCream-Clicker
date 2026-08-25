import type { Portrait } from "./portraits";

export interface PlayerState {
  nickname: string | null;
  publicTag: string;
  displayName: string;
  sandwichesFed: number;
  sandwichesRemaining: number;
  scoreVersion: number;
}

export type PortraitPreview = Pick<Portrait, "id" | "src" | "alt">;

export interface GameRound {
  currentPortrait: Portrait;
  nextPortrait: PortraitPreview;
  roundToken: string;
  expiresAtMs: number;
}

export interface GameStateResponse {
  player: PlayerState;
  round: GameRound;
}

export interface UpdatePlayerRequest {
  nickname: string;
}

export interface UpdatePlayerResponse {
  player: PlayerState;
}

export interface FeedRequest {
  roundToken: string;
  portraitId: string;
  x: number;
  y: number;
}

export interface StartPackReloadRequest {
  action: "start";
  expectedScoreVersion: number;
}

export interface CompletePackReloadRequest {
  action: "complete";
  reloadToken: string;
}

export interface PackReloadStartResponse {
  reload: {
    token: string;
    durationMs: number;
    activeStartMs: number;
    activeEndMs: number;
  };
}

export type PackReloadResponse = GameStateResponse | PackReloadStartResponse;

export type FeedOutcome = "hit" | "miss";

export interface FeedResponse extends GameStateResponse {
  outcome: FeedOutcome;
}

export interface LeaderboardEntry {
  position: number;
  displayName: string;
  publicTag: string;
  sandwichesFed: number;
}

export interface LeaderboardResponse {
  leaders: LeaderboardEntry[];
  globalTotal: number;
  generatedAtMs: number;
  cachedUntilMs: number;
}

export interface DeletePlayerResponse {
  ok: true;
}

export interface RoundTokenClaims {
  playerId: string;
  scoreVersion: number;
  portraitId: string;
  expiresAtMs: number;
}

export interface PackReloadTokenClaims {
  kind: "pack-reload";
  playerId: string;
  scoreVersion: number;
  packsOpened: number;
  startedAtMs: number;
  expiresAtMs: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    [detail: string]: string | number | boolean;
  };
}
