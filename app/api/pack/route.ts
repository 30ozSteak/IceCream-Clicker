import { errorResponse } from "../../../lib/server/api-error";
import { openNextPack } from "../../../lib/server/game-service";
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
    return jsonNoStore(await openNextPack(request, payload));
  } catch (error) {
    return errorResponse(error, request);
  }
}
