import { errorResponse } from "../../../lib/server/api-error";
import {
  deletePlayer,
  updatePlayerNickname,
} from "../../../lib/server/game-service";
import {
  expiredSessionCookie,
  jsonNoStore,
  readJsonObject,
  requireSameOrigin,
} from "../../../lib/server/http";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const payload = await readJsonObject(request);
    return jsonNoStore(await updatePlayerNickname(request, payload));
  } catch (error) {
    return errorResponse(error, request);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const response = jsonNoStore(await deletePlayer(request));
    response.headers.append("Set-Cookie", expiredSessionCookie());
    return response;
  } catch (error) {
    return errorResponse(error, request);
  }
}
