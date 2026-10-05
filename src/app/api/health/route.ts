import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Public liveness check: the app is up and the database answers. */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ status: "ok", time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
