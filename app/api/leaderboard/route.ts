import { errorResponse } from "../../../lib/server/api-error";
import { getLeaderboard } from "../../../lib/server/game-service";

const CACHE_TTL_SECONDS = 10;

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return new Request(url, { method: "GET" });
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") {
    return null;
  }
  return caches.open("icecream-clicker-api");
}

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    let cache: Cache | null = null;
    try {
      cache = await openCache();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "leaderboard_cache_open_failed",
          error: error instanceof Error ? error.message : "Unknown cache error",
        }),
      );
    }
    const key = cacheKey(request);
    if (cache) {
      try {
        const cached = await cache.match(key);
        if (cached) {
          const response = new Response(cached.body, cached);
          response.headers.set("X-Leaderboard-Cache", "HIT");
          return response;
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "leaderboard_cache_read_failed",
            error: error instanceof Error ? error.message : "Unknown cache error",
          }),
        );
      }
    }

    const payload = await getLeaderboard();
    const response = Response.json(payload, {
      headers: {
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
        "X-Content-Type-Options": "nosniff",
        "X-Leaderboard-Cache": "MISS",
      },
    });

    if (cache) {
      try {
        await cache.put(key, response.clone());
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "leaderboard_cache_write_failed",
            error: error instanceof Error ? error.message : "Unknown cache error",
          }),
        );
      }
    }
    return response;
  } catch (error) {
    return errorResponse(error, request);
  }
}
