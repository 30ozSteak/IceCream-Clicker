import type { ApiErrorBody } from "../game-types";

type ErrorDetail = string | number | boolean;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, ErrorDetail>>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      details?: Readonly<Record<string, ErrorDetail>>;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

function collectErrorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }

  return messages.join("\n");
}

function hasErrorCode(error: unknown, expectedCodes: ReadonlySet<string>): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && expectedCodes.has(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function databaseConfigurationError(error: unknown): ApiError | null {
  const message = collectErrorMessages(error);
  if (
    message.includes("DATABASE_URL") ||
    hasErrorCode(error, new Set(["42P01", "42703"])) ||
    message.includes('relation "players" does not exist') ||
    (message.includes("does not exist") && message.includes("column"))
  ) {
    return new ApiError(
      503,
      "DATABASE_NOT_READY",
      "The game database is not ready. Connect a Postgres database to this Vercel project and redeploy.",
      { retryable: true },
    );
  }

  if (
    message.includes("ROUND_TOKEN_SECRET") ||
    message.includes("portrait manifest")
  ) {
    return new ApiError(
      503,
      "GAME_CONFIGURATION_ERROR",
      "The game service is not fully configured yet.",
      { retryable: true },
    );
  }

  return null;
}

function errorBody(error: ApiError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...error.details,
    },
  };
}

export function errorResponse(error: unknown, request: Request): Response {
  const known =
    error instanceof ApiError
      ? error
      : databaseConfigurationError(error) ??
        new ApiError(500, "INTERNAL_ERROR", "The game service hit an unexpected error.", {
          retryable: true,
        });

  if (!(error instanceof ApiError) || known.status >= 500) {
    console.error(
      JSON.stringify({
        message: "game_api_request_failed",
        path: new URL(request.url).pathname,
        code: known.code,
        error: collectErrorMessages(error) || "Unknown error",
      }),
    );
  }

  return Response.json(errorBody(known), {
    status: known.status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
