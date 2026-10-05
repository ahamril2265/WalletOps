"use server";

import { redirect } from "next/navigation";
import { passwordMatches, startSession } from "@/lib/auth/session";

export async function loginAction(_state: { error: string }, formData: FormData): Promise<{ error: string }> {
  if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
    return { error: "The server is missing ADMIN_PASSWORD or SESSION_SECRET." };
  }
  const password = String(formData.get("password") ?? "");
  if (!passwordMatches(password)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { error: "Wrong password." };
  }
  await startSession();
  redirect("/");
}
