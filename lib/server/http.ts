import { ApiError } from "./api-error.ts";

export {
  expiredSessionCookie,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionCookie,
} from "./session-cookie.ts";

const MAX_JSON_BODY_BYTES = 4_096;

export function jsonNoStore(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(data, { ...init, headers });
}

export function requireSameOrigin(request: Request): void {
  const originHeader = request.headers.get("Origin");
  if (!originHeader) {
    throw new ApiError(
      403,
      "ORIGIN_REQUIRED",
      "This request must come from the game page.",
    );
  }

  let suppliedOrigin: string;
  try {
    suppliedOrigin = new URL(originHeader).origin;
  } catch {
    throw new ApiError(403, "ORIGIN_MISMATCH", "The request origin is invalid.");
  }

  const requestUrl = new URL(request.url);
  const allowedOrigins = new Set([requestUrl.origin]);
  const hostHeader = request.headers.get("Host");
  if (hostHeader) {
    try {
      const hostOrigin = new URL(`${requestUrl.protocol}//${hostHeader}`);
      if (
        hostOrigin.username === "" &&
        hostOrigin.password === "" &&
        hostOrigin.pathname === "/" &&
        hostOrigin.search === "" &&
        hostOrigin.hash === ""
      ) {
        allowedOrigins.add(hostOrigin.origin);
      }
    } catch {
      // A malformed Host header cannot authorize an origin.
    }
  }

  if (!allowedOrigins.has(suppliedOrigin)) {
    throw new ApiError(
      403,
      "ORIGIN_MISMATCH",
      "Cross-origin game requests are not allowed.",
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiError(
      415,
      "JSON_REQUIRED",
      "Send this request with an application/json body.",
    );
  }

  const announcedLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.");
  }

  if (!request.body) {
    throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The JSON request body is invalid.");
  }

  if (!isRecord(parsed)) {
    throw new ApiError(400, "INVALID_BODY", "The JSON body must be an object.");
  }

  return parsed;
}
