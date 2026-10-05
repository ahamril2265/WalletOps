import { handle } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handle(request, "customers.create");
}
