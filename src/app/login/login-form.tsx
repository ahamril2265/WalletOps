"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/client";
import { inputClass } from "@/components/ui";
import { loginAction } from "./actions";

export function LoginForm() {
  const [state, action] = useActionState(loginAction, { error: "" });
  return (
    <form action={action} className="space-y-4 rounded-2xl bg-white p-6 shadow-xl">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Admin password</span>
        <input name="password" type="password" autoComplete="current-password" required autoFocus className={inputClass} />
      </label>
      {state.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
      <SubmitButton className="w-full" pendingText="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
