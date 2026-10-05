"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const LINKS = [
  { href: "/", label: "Dashboard", icon: "M3 12l2-2 7-7 7 7 2 2M5 10v10h5v-6h4v6h5V10" },
  { href: "/tickets", label: "Tickets", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/generator", label: "Generator", icon: "M13 2L3 14h8l-1 8 10-12h-8l1-8z" },
  { href: "/operations", label: "Operations", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" },
  { href: "/accounts", label: "Accounts", icon: "M3 7h18v10H3zM3 10h18M7 15h3" },
  { href: "/logs", label: "Request log", icon: "M4 4h16v16H4zM8 8h8M8 12h8M8 16h5" },
  { href: "/guide", label: "Guide", icon: "M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5v14zM20 17v4H6.5" },
];

export function Nav({ openTickets }: { openTickets: number }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 py-2 lg:flex-col lg:overflow-visible lg:px-3 lg:py-4">
      {LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cx(
              "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white",
            )}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={link.icon} />
            </svg>
            <span>{link.label}</span>
            {link.href === "/tickets" && openTickets > 0 && (
              <span className="ml-auto rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white tabular">{openTickets}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
