import { isAuthorizedRequest } from "@/lib/auth/session";
import { runTick } from "@/lib/generator/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Run one generator tick. Called by Vercel Cron (GET), the GitHub Actions schedule (POST) and the
 * dashboard's auto mode. Needs `Authorization: Bearer <CRON_SECRET>` or an admin session.
 */
async function run(request: Request) {
  if (!(await isAuthorizedRequest(request))) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid credentials" } }, { status: 401 });
  }
  const trigger = new URL(request.url).searchParams.get("trigger") === "auto" ? "auto" : "cron";
  try {
    const result = await runTick(trigger);
    return Response.json(result, { status: result.ran ? 200 : 202 });
  } catch (error) {
    console.error("tick failed", error);
    return Response.json({ ran: false, reason: error instanceof Error ? error.message : "tick failed" }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
