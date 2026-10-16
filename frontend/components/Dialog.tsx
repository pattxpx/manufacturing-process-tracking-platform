"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { Button } from "./ui";

/**
 * Modal dialog on Radix Dialog: traps focus, closes on Escape (a dropdown that is open inside it
 * closes first), locks page scroll, returns focus when closed. The body scrolls if it is too tall.
 */
export function Dialog({ title, description, onClose, children, footer }: {
  title: string; description?: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // The button that opened the dialog. These dialogs are opened by state, not by a Dialog.Trigger,
  // so Radix has nothing to return focus to: we remember the opener ourselves.
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));

  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-slate-900/50" />
        <RadixDialog.Content
          ref={contentRef}
          {...(description ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Back to where the user was. If that element is gone (the list refreshed), go to the page content.
            if (opener && document.contains(opener)) opener.focus();
            else document.getElementById("main")?.focus();
          }}
          onOpenAutoFocus={(event) => {
            // Focus the first field if there is one, otherwise the first button in the footer
            // (the safe "Cancel"), instead of the close icon.
            const target = contentRef.current?.querySelector<HTMLElement>(
              "[data-dialog-body] input:not([disabled]), [data-dialog-body] textarea, [data-dialog-body] [role=combobox]:not([disabled])",
            ) ?? contentRef.current?.querySelector<HTMLElement>("[data-dialog-footer] button");
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-panel bg-white shadow-xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <RadixDialog.Title className="break-words text-base font-semibold text-slate-900">{title}</RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-0.5 text-sm text-slate-600">{description}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              aria-label="Close dialog"
              title="Close"
              className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-slate-600 hover:bg-slate-100 sm:h-9 sm:w-9"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </RadixDialog.Close>
          </header>
          <div data-dialog-body className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm text-slate-700 sm:px-5">
            {children}
          </div>
          <footer data-dialog-footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
            {footer}
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger = false, busy = false, onConfirm, onCancel }: {
  title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{message}</div>
    </Dialog>
  );
}
