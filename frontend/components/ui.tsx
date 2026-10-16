import { useId } from "react";
import Link from "next/link";

// Shared control look. Controls are 44px tall on touch screens and 40px on desktop.
export const controlBase =
  "min-h-11 sm:min-h-10 rounded-control border px-3 text-sm";

type ButtonVariant = "primary" | "secondary" | "danger";
const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-brand text-slate-900 font-semibold hover:bg-brand-hover active:bg-brand-active disabled:bg-slate-200 disabled:text-slate-500",
  secondary:
    "border-slate-500 bg-white text-slate-800 font-medium hover:bg-slate-50 active:bg-slate-100 disabled:bg-slate-50 disabled:text-slate-400",
  danger:
    "border-transparent bg-red-600 text-white font-semibold hover:bg-red-700 active:bg-red-800 disabled:bg-red-200",
};
const buttonBase =
  "inline-flex min-h-11 sm:min-h-10 items-center justify-center gap-2 rounded-control border px-4 text-sm ";

export function Button({
  variant = "primary", loading = false, className = "", children, ...props
}: { variant?: ButtonVariant; loading?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={`${buttonBase} ${buttonStyles[variant]} ${className}`}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = "secondary", children, className = "" }: {
  href: string; variant?: ButtonVariant; children: React.ReactNode; className?: string;
}) {
  return <Link href={href} className={`${buttonBase} ${buttonStyles[variant]} ${className}`}>{children}</Link>;
}

export function TextLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={`font-medium text-brand-strong underline-offset-2 hover:underline ${className}`}>
      {children}
    </Link>
  );
}

export function Card({ title, description, action, children, className = "", flush = false }: {
  title?: string; description?: string; action?: React.ReactNode; children: React.ReactNode;
  className?: string; flush?: boolean; // flush: no padding, for tables that go edge to edge
}) {
  return (
    <section className={`rounded-panel border border-slate-200 bg-surface ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={flush ? "" : "p-4 sm:p-5"}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, backHref, backLabel }: {
  title: string; description?: string; actions?: React.ReactNode; backHref?: string; backLabel?: string;
}) {
  return (
    <div className="mb-6">
      {backHref && (
        <Link href={backHref} className="mb-2 inline-flex min-h-8 items-center gap-1 text-sm font-medium text-brand-strong hover:underline">
          <span aria-hidden="true">←</span> {backLabel}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Spinner({ small = false }: { small?: boolean }) {
  const size = small ? "h-4 w-4" : "h-6 w-6";
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block ${size} animate-spin rounded-full border-2 border-slate-300 border-t-brand-ring motion-reduce:animate-none`}
    />
  );
}

export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-600" aria-live="polite">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: {
  title: string; description?: string; action?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

type AlertKind = "error" | "success" | "warning" | "info";
// A symbol is added with CSS so meaning never depends on color alone.
const alertStyles: Record<AlertKind, string> = {
  error: "border-red-200 bg-red-50 text-red-900 before:content-['✕']",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900 before:content-['✓']",
  warning: "border-amber-200 bg-amber-50 text-amber-950 before:content-['!']",
  info: "border-sky-200 bg-sky-50 text-sky-950 before:content-['i']",
};

export function Alert({ kind = "info", title, children, onRetry }: {
  kind?: AlertKind; title?: string; children: React.ReactNode; onRetry?: () => void;
}) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-control border px-3 py-2.5 text-sm before:mt-0.5 before:inline-flex before:h-5 before:w-5 before:shrink-0 before:items-center before:justify-center before:rounded-full before:bg-current/10 before:text-xs before:font-bold ${alertStyles[kind]}`}
    >
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <div>{children}</div>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 rounded font-semibold underline">Retry</button>
      )}
    </div>
  );
}

// ---- Form fields ----

const inputStyles =
  `block w-full ${controlBase} border-slate-500 bg-white text-slate-900 placeholder:text-slate-500 hover:border-slate-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 aria-[invalid=true]:border-red-600`;

export function FieldShell({ id, label, required, optional, error, hint, children }: {
  id: string; label: string; required?: boolean; optional?: boolean; error?: string; hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-800">
        {label}
        {required && <span aria-hidden="true" className="ml-0.5 text-red-600">*</span>}
        {optional && <>{" "}<span className="font-normal text-slate-500">(optional)</span></>}
      </label>
      {children}
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-600">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

type FieldProps = { label: string; required?: boolean; optional?: boolean; error?: string; hint?: string };

function describedBy(id: string, error?: string, hint?: string) {
  const ids = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ");
  return ids || undefined;
}

export function TextField({ label, required, optional, error, hint, ...props }:
  FieldProps & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} required={required} optional={optional} error={error} hint={hint}>
      <input id={id} {...props} aria-required={required} aria-invalid={!!error}
        aria-describedby={describedBy(id, error, hint)} className={inputStyles} />
    </FieldShell>
  );
}

export function TextAreaField({ label, required, optional, error, hint, ...props }:
  FieldProps & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} required={required} optional={optional} error={error} hint={hint}>
      <textarea id={id} rows={3} {...props} aria-required={required} aria-invalid={!!error}
        aria-describedby={describedBy(id, error, hint)} className={`${inputStyles} py-2`} />
    </FieldShell>
  );
}

export function SearchInput({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`relative ${className}`}>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
      </svg>
      <input type="search" {...props} className={`${inputStyles} pl-9`} />
    </div>
  );
}

// ---- Tables ----
// On phones each row turns into a small card (see .table-stack in globals.css).
// Give every Td a `label` so the card shows what each value is.

export function Table({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="table-stack w-full min-w-full text-sm">{children}</table>
    </div>
  );
}
export function Thead({ children }: { children: React.ReactNode }) {
  return <thead className="border-b border-slate-200 bg-slate-50">{children}</thead>;
}
export function Tbody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}
export function Tr({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <tr className={`border-t border-slate-100 first:border-t-0 ${className}`}>{children}</tr>;
}
export function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 ${className}`}>
      {children}
    </th>
  );
}
export function Td({ children, label, className = "" }: { children?: React.ReactNode; label?: string; className?: string }) {
  return <td data-label={label} className={`px-4 py-3 align-top text-slate-800 ${className}`}>{children}</td>;
}

/** Stock bar: amber = reserved, brand = still available. The numbers are always shown next to it. */
export function StockBar({ reserved, onHand }: { reserved: number; onHand: number }) {
  const percent = onHand > 0 ? Math.min(100, Math.round((reserved / onHand) * 100)) : 0;
  return (
    <div
      role="img"
      aria-label={`${reserved} of ${onHand} reserved`}
      className="flex h-2 w-full overflow-hidden rounded-full bg-brand-tint-strong"
    >
      <div className="h-full bg-amber-500" style={{ width: `${percent}%` }} />
    </div>
  );
}
