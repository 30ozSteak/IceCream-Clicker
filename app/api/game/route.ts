import { errorResponse } from "../../../lib/server/api-error";
import { getOrCreateGame } from "../../../lib/server/game-service";
import { jsonNoStore, sessionCookie } from "../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const result = await getOrCreateGame(request);
    const response = jsonNoStore(result.game);
    if (result.newSessionToken) {
      response.headers.append("Set-Cookie", sessionCookie(result.newSessionToken));
    }
    return response;
  } catch (error) {
    return errorResponse(error, request);
  }
}
