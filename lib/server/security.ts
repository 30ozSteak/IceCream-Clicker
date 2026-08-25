import type {
  PackReloadTokenClaims,
  RoundTokenClaims,
} from "../game-types";

const SESSION_TOKEN_BYTES = 32;
const HMAC_SIGNATURE_BYTES = 32;
const PACK_RELOAD_TOKEN_DOMAIN = "fatboy.pack-reload.v1";
const encoder = new TextEncoder();

export type RoundTokenVerification =
  | { ok: true; claims: RoundTokenClaims }
  | {
      ok: false;
      reason: "malformed" | "invalid-signature" | "expired";
    };

export type PackReloadTokenVerification =
  | { ok: true; claims: PackReloadTokenClaims }
  | {
      ok: false;
      reason: "malformed" | "invalid-signature" | "expired";
    };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(paddingLength);
  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isRoundTokenClaims(value: unknown): value is RoundTokenClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return (
    "playerId" in value &&
    typeof value.playerId === "string" &&
    value.playerId.length > 0 &&
    value.playerId.length <= 128 &&
    "scoreVersion" in value &&
    typeof value.scoreVersion === "number" &&
    Number.isSafeInteger(value.scoreVersion) &&
    value.scoreVersion >= 0 &&
    "portraitId" in value &&
    typeof value.portraitId === "string" &&
    value.portraitId.length > 0 &&
    value.portraitId.length <= 128 &&
    "expiresAtMs" in value &&
    typeof value.expiresAtMs === "number" &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > 0
  );
}

function isPackReloadTokenClaims(value: unknown): value is PackReloadTokenClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const expectedKeys = new Set([
    "kind",
    "playerId",
    "scoreVersion",
    "packsOpened",
    "startedAtMs",
    "expiresAtMs",
  ]);
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.size &&
    keys.every((key) => expectedKeys.has(key)) &&
    "kind" in value &&
    value.kind === "pack-reload" &&
    "playerId" in value &&
    typeof value.playerId === "string" &&
    value.playerId.length > 0 &&
    value.playerId.length <= 128 &&
    "scoreVersion" in value &&
    typeof value.scoreVersion === "number" &&
    Number.isSafeInteger(value.scoreVersion) &&
    value.scoreVersion >= 0 &&
    "packsOpened" in value &&
    typeof value.packsOpened === "number" &&
    Number.isSafeInteger(value.packsOpened) &&
    value.packsOpened >= 1 &&
    "startedAtMs" in value &&
    typeof value.startedAtMs === "number" &&
    Number.isSafeInteger(value.startedAtMs) &&
    value.startedAtMs > 0 &&
    "expiresAtMs" in value &&
    typeof value.expiresAtMs === "number" &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > value.startedAtMs
  );
}

async function hmac(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

function domainPayload(domain: string, payload: string): string {
  return `${domain}\u0000${payload}`;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const normalizedRight = new Uint8Array(left.byteLength);
  normalizedRight.set(right.subarray(0, left.byteLength));

  const platformTimingSafeEqual: unknown = Reflect.get(
    crypto.subtle,
    "timingSafeEqual",
  );
  let equal: boolean;
  if (typeof platformTimingSafeEqual === "function") {
    equal = Boolean(
      Reflect.apply(platformTimingSafeEqual, crypto.subtle, [left, normalizedRight]),
    );
  } else {
    let difference = 0;
    for (let index = 0; index < left.byteLength; index += 1) {
      difference |= left[index] ^ normalizedRight[index];
    }
    equal = difference === 0;
  }

  return right.byteLength === left.byteLength && equal;
}

export function isSessionToken(value: string | null): value is string {
  return value !== null && value.length === 43 && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function createSessionToken(): string {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function randomPublicTag(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function secureRandomIndex(length: number): number {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 0xffff_ffff) {
    throw new RangeError("A positive collection length is required.");
  }

  const range = 0x1_0000_0000;
  const unbiasedLimit = Math.floor(range / length) * length;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= unbiasedLimit);
  return values[0] % length;
}

export async function signRoundToken(
  claims: RoundTokenClaims,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmac(payload, secret);
  return `${payload}.${bytesToBase64Url(signature)}`;
}

export async function verifyRoundToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<RoundTokenVerification> {
  if (token.length > 1_024) {
    return { ok: false, reason: "malformed" };
  }

  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return { ok: false, reason: "malformed" };
  }

  const [payload, encodedSignature] = segments;
  const suppliedSignature = base64UrlToBytes(encodedSignature);
  const expectedSignature = await hmac(payload, secret);
  const signatureMatches = timingSafeEqual(
    expectedSignature,
    suppliedSignature ?? new Uint8Array(HMAC_SIGNATURE_BYTES),
  );
  if (!suppliedSignature || !signatureMatches) {
    return { ok: false, reason: "invalid-signature" };
  }

  const payloadBytes = base64UrlToBytes(payload);
  if (!payloadBytes) {
    return { ok: false, reason: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
    );
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!isRoundTokenClaims(parsed)) {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.expiresAtMs <= nowMs) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims: parsed };
}

export async function signPackReloadToken(
  claims: PackReloadTokenClaims,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmac(
    domainPayload(PACK_RELOAD_TOKEN_DOMAIN, payload),
    secret,
  );
  return `${payload}.${bytesToBase64Url(signature)}`;
}

export async function verifyPackReloadToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<PackReloadTokenVerification> {
  if (token.length > 1_024) {
    return { ok: false, reason: "malformed" };
  }

  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return { ok: false, reason: "malformed" };
  }

  const [payload, encodedSignature] = segments;
  const suppliedSignature = base64UrlToBytes(encodedSignature);
  const expectedSignature = await hmac(
    domainPayload(PACK_RELOAD_TOKEN_DOMAIN, payload),
    secret,
  );
  const signatureMatches = timingSafeEqual(
    expectedSignature,
    suppliedSignature ?? new Uint8Array(HMAC_SIGNATURE_BYTES),
  );
  if (!suppliedSignature || !signatureMatches) {
    return { ok: false, reason: "invalid-signature" };
  }

  const payloadBytes = base64UrlToBytes(payload);
  if (!payloadBytes) {
    return { ok: false, reason: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!isPackReloadTokenClaims(parsed)) {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.expiresAtMs <= nowMs) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims: parsed };
}
