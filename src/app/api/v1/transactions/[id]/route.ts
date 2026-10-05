import { handle } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, "transactions.get", await params);
}
