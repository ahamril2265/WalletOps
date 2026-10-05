import { isAuthorizedRequest } from "@/lib/auth/session";
import { recentEvents } from "@/lib/telemetry/events";

export const dynamic = "force-dynamic";

/** Live event feed for the dashboard (admin session only). */
export async function GET(request: Request) {
  if (!(await isAuthorizedRequest(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0) || undefined;
  return Response.json(await recentEvents(40, after));
}
