import { errorResponse } from "../../../lib/server/api-error";
import { feedPlayer } from "../../../lib/server/game-service";
import {
  jsonNoStore,
  readJsonObject,
  requireSameOrigin,
} from "../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const payload = await readJsonObject(request);
    return jsonNoStore(await feedPlayer(request, payload));
  } catch (error) {
    return errorResponse(error, request);
  }
}
