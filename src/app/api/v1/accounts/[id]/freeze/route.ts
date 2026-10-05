import { handle } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, "accounts.freeze", await params);
}
