import { Nav } from "@/components/nav";
import { requireSession } from "@/lib/auth/session";
import { ticketCounts } from "@/lib/tickets/tickets";
import { logoutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const counts = await ticketCounts();
  const open = Object.entries(counts)
    .filter(([key]) => ["open", "investigating", "mitigated", "resolved"].includes(key))
    .reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 z-20 bg-slate-950 lg:flex lg:h-screen lg:w-60 lg:shrink-0 lg:flex-col">
        <div className="flex items-center gap-3 px-5 pt-4 lg:pt-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 text-sm font-bold text-white">W</div>
          <div>
            <div className="text-sm font-semibold text-white">WalletOps</div>
            <div className="text-[11px] text-slate-400">Incident console</div>
          </div>
        </div>
        <Nav openTickets={open} />
        <form action={logoutAction} className="hidden px-3 pb-5 lg:mt-auto lg:block">
          <button className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-400 hover:bg-white/5 hover:text-white">Sign out</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
