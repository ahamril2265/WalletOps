import { handle } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(request, "fx.rates");
}
