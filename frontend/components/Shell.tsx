"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LiveProvider, useLive } from "@/lib/live";
import { ToastProvider } from "./Toast";
import { LoadingBlock } from "./ui";

// "permission" decides who sees the link. The backend enforces the same permissions on every call.
const nav = [
  { href: "/", label: "Dashboard", permission: "orders:read", icon: "M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10" },
  { href: "/orders", label: "Orders", permission: "orders:read", icon: "M9 5h10M9 12h10M9 19h10M4 5h.01M4 12h.01M4 19h.01" },
  { href: "/production", label: "Production Board", permission: "production:read", icon: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z" },
  { href: "/schedule", label: "Schedule", permission: "schedule:read", icon: "M4 7h16M4 12h10M4 17h13M8 4v6M16 9v6" },
  { href: "/resources", label: "Resources", permission: "resources:read", icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5" },
  { href: "/quality", label: "Quality & Release", permission: "quality:read", icon: "M9 12l2 2 4-4M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6l8-3z" },
  { href: "/users", label: "Users", permission: "users:manage", icon: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20v-1a5 5 0 0110 0v1M16 11a3 3 0 100-6M21 20v-1a5 5 0 00-4-4.9" },
  { href: "/audit", label: "Audit log", permission: "audit:read", icon: "M7 4h10v16H7zM10 8h4M10 12h4M10 16h2" },
];

function BrandMark() {
  return (
    <div className="flex items-center gap-3 px-3">
      <span className="relative flex h-9 w-9 items-center justify-center rounded-control bg-brand" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-900" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16.5l8 4 8-4" />
        </svg>
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-accent" />
      </span>
      <div>
        <p className="text-sm font-semibold leading-tight text-slate-900">Meridian Medical</p>
        <p className="text-xs text-slate-600">Production tracking</p>
      </div>
    </div>
  );
}

function ConnectionStatus() {
  const { connected } = useLive();
  return (
    <p className="flex items-center gap-2 text-xs text-slate-600" role="status">
      <span className={`h-2 w-2 rounded-full ${connected ? "bg-accent" : "bg-amber-500"}`} aria-hidden="true" />
      {connected ? "Live updates on" : "Reconnecting…"}
    </p>
  );
}

function NavLinks({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const { can } = useAuth();
  return (
    <nav aria-label="Main" className="space-y-1">
      {nav.filter((item) => can(item.permission)).map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`relative flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium ${
              active ? "bg-brand-tint text-slate-900" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {active && <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-brand" aria-hidden="true" />}
            <svg viewBox="0 0 24 24" className={`h-[1.1rem] w-[1.1rem] shrink-0 ${active ? "text-brand-strong" : "text-slate-500"}`} fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={item.icon} />
            </svg>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function AccountBox({ onNavigate }: { onNavigate: () => void }) {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="rounded-control border border-slate-200 bg-canvas p-3">
      <p className="truncate text-sm font-semibold text-slate-900">{user.full_name}</p>
      <p className="truncate text-xs text-slate-600">{user.username} · {user.role}</p>
      <div className="mt-2 flex gap-2">
        <Link href="/account" onClick={onNavigate} className="inline-flex min-h-9 items-center rounded-control border border-slate-500 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50">
          Account
        </Link>
        <button onClick={logout} className="inline-flex min-h-9 items-center rounded-control border border-slate-500 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-50">
          Sign out
        </button>
      </div>
    </div>
  );
}

function AppFrame({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);

  const sidebar = (
    <div className="flex h-full flex-col justify-between p-4">
      <div>
        <div className="mb-6"><BrandMark /></div>
        <NavLinks onNavigate={close} />
      </div>
      <div className="space-y-3">
        <AccountBox onNavigate={close} />
        <ConnectionStatus />
        <p className="text-xs text-slate-500">Demo prototype. Not a certified medical manufacturing system.</p>
      </div>
    </div>
  );

  return (
    <LiveProvider>
      <ToastProvider>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[90] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow">
          Skip to content
        </a>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
            {sidebar}
          </aside>

          <div className="min-w-0 flex-1">
            <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2 lg:hidden">
              <RadixDialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <RadixDialog.Trigger
                  aria-label="Open navigation menu"
                  title="Open navigation menu"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-control border border-slate-500 hover:bg-slate-50"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </RadixDialog.Trigger>
                <RadixDialog.Portal>
                  <RadixDialog.Overlay className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden" />
                  <RadixDialog.Content
                    aria-describedby={undefined}
                    className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] overflow-y-auto bg-white shadow-xl lg:hidden"
                  >
                    <RadixDialog.Title className="sr-only">Navigation</RadixDialog.Title>
                    <RadixDialog.Close
                      aria-label="Close navigation menu"
                      title="Close navigation menu"
                      className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-control text-slate-600 hover:bg-slate-100"
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
                    </RadixDialog.Close>
                    {sidebar}
                  </RadixDialog.Content>
                </RadixDialog.Portal>
              </RadixDialog.Root>
              <BrandMark />
            </header>
            <main id="main" tabIndex={-1} className="mx-auto outline-none w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
          </div>
        </div>
      </ToastProvider>
    </LiveProvider>
  );
}


/** Signed-in pages get the frame. The sign-in page stands alone. Everything else needs a session. */
function Gate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const onLoginPage = pathname === "/login";

  useEffect(() => {
    if (status === "anonymous" && !onLoginPage) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, onLoginPage, pathname, router]);

  if (onLoginPage) return <ToastProvider>{children}</ToastProvider>;
  if (status !== "authenticated") {
    return <div className="min-h-screen"><LoadingBlock label="Checking your session…" /></div>;
  }
  return <AppFrame>{children}</AppFrame>;
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Gate>{children}</Gate>
    </AuthProvider>
  );
}
