import { redirect } from "next/navigation";
import { hasSession } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await hasSession()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500 text-lg font-bold text-white">W</div>
          <h1 className="text-xl font-semibold text-white">WalletOps</h1>
          <p className="mt-1 text-sm text-slate-400">Incident console</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
