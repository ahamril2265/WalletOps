import { handle } from "@/lib/api/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function POST(request: Request) {
  return handle(request, "refunds.create");
}
