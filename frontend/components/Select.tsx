"use client";

import * as RadixSelect from "@radix-ui/react-select";
import { useId } from "react";
import { controlBase, FieldShell, Spinner } from "./ui";

export interface SelectOption {
  value: string;      // must not be empty (use e.g. "all" for "no filter")
  label: string;
  hint?: string;      // small second line in the menu, e.g. why an option is disabled
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  hint?: string;
  required?: boolean;
  optional?: boolean;
  /** Either a visible label... */
  label?: string;
  /** ...or an invisible one (for filters that sit next to a search box). */
  ariaLabel?: string;
  className?: string;
}

/**
 * Accessible dropdown built on Radix Select: arrow keys, Home/End, type-ahead, Enter/Space to choose,
 * Escape to close, focus return, screen reader roles, and a menu that is never clipped by tables
 * or dialogs (it is rendered in a portal and flips/shifts at the screen edge).
 */
export function Select({
  value, onChange, options, placeholder = "Select…", disabled, loading, error, hint,
  required, optional, label, ariaLabel, className = "",
}: SelectProps) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;

  const select = (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled || loading}>
      <RadixSelect.Trigger
        id={id}
        aria-label={label ? undefined : ariaLabel}
        aria-invalid={!!error}
        aria-required={required}
        aria-describedby={describedBy}
        className={`flex w-full items-center justify-between gap-2 ${controlBase} border-slate-500 bg-white text-left text-slate-900 hover:border-slate-700 data-[state=open]:border-brand-ring data-[placeholder]:text-slate-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 aria-[invalid=true]:border-red-600 ${className}`}
      >
        <span className="min-w-0 flex-1 truncate">
          <RadixSelect.Value placeholder={loading ? "Loading…" : placeholder} />
        </span>
        {loading ? <Spinner small /> : (
          <RadixSelect.Icon aria-hidden="true">
            <svg viewBox="0 0 20 20" className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 8l5 5 5-5" />
            </svg>
          </RadixSelect.Icon>
        )}
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-[70] max-h-[min(var(--radix-select-content-available-height),20rem)] w-[var(--radix-select-trigger-width)] min-w-[min(12rem,calc(100vw-1rem))] overflow-hidden rounded-control border border-slate-200 bg-white shadow-md"
        >
          <RadixSelect.Viewport className="p-1">
            {options.length === 0 && <p className="px-3 py-2 text-sm text-slate-600">No options available</p>}
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                // By default Radix names an option from its label only. When there is a second line
                // (for example "Busy, running ORD-1006") it must be part of the name, or screen readers skip it.
                aria-label={option.hint ? `${option.label} ${option.hint}` : undefined}
                aria-labelledby={undefined}
                className="relative flex min-h-11 select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-slate-900 outline-none before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-1 before:rounded-full before:bg-accent before:opacity-0 data-[disabled]:text-slate-500 data-[highlighted]:bg-brand-tint data-[state=checked]:font-semibold data-[state=checked]:before:opacity-100 sm:min-h-9"
              >
                <span className="min-w-0">
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.hint && <>{" "}<span className="block break-words text-xs font-normal text-slate-600">{option.hint}</span></>}
                </span>
                <RadixSelect.ItemIndicator aria-hidden="true">
                  <svg viewBox="0 0 20 20" className="h-4 w-4 text-brand-strong" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 10.5l4 4 8-9" />
                  </svg>
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );

  if (!label) return select;
  return (
    <FieldShell id={id} label={label} required={required} optional={optional} error={error} hint={hint}>
      {select}
    </FieldShell>
  );
}
