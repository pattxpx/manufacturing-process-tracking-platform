"use client";

import { Select } from "./Select";

/** 1 … 4 5 6 … 20: always the first, last and nearby pages. */
function pageWindow(page: number, totalPages: number): (number | "…")[] {
  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  pages.forEach((p, index) => {
    if (index > 0 && p - pages[index - 1] > 1) result.push("…");
    result.push(p);
  });
  return result;
}

const pageButton =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border px-3 text-sm font-medium sm:min-h-9 sm:min-w-9 disabled:border-slate-200 disabled:text-slate-400";

/**
 * Page controls for a list that is paged by the server. Shows "Showing 26–50 of 1,240 orders",
 * Previous / Next, page numbers (on wider screens) and a rows-per-page dropdown.
 */
export function Pagination({ page, pageSize, total, totalPages, itemName, label = itemName.many, onPageChange, onPageSizeChange, pageSizeOptions = [10, 25, 50] }: {
  page: number; pageSize: number; total: number; totalPages: number;
  itemName: { one: string; many: string };
  label?: string; // names this control for screen readers, so two lists of orders can be told apart
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav aria-label={`${label} pages`} className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 md:flex-row md:items-center md:justify-between">
      <p className="text-sm text-slate-700" aria-live="polite">
        Showing <strong className="tabular-nums">{first.toLocaleString()}–{last.toLocaleString()}</strong> of{" "}
        <strong className="tabular-nums">{total.toLocaleString()}</strong> {total === 1 ? itemName.one : itemName.many}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-700" aria-hidden="true">Rows per page</span>
          <div className="w-20">
            <Select
              ariaLabel={`Rows per page for ${label}`}
              value={String(pageSize)}
              onChange={(value) => onPageSizeChange(Number(value))}
              options={pageSizeOptions.map((size) => ({ value: String(size), label: String(size) }))}
            />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-between gap-1 md:flex-none md:justify-end">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className={`${pageButton} border-slate-500 bg-white text-slate-800 hover:bg-slate-50 active:bg-slate-100`}
          >
            <span aria-hidden="true">←</span>&nbsp;Previous
          </button>

          {/* Page numbers on wider screens, a short "Page 2 of 50" on phones */}
          <ol className="hidden items-center gap-1 sm:flex">
            {pageWindow(page, totalPages).map((entry, index) =>
              entry === "…" ? (
                <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-slate-600">…</li>
              ) : (
                <li key={entry}>
                  <button
                    onClick={() => onPageChange(entry)}
                    aria-label={`Page ${entry}`}
                    aria-current={entry === page ? "page" : undefined}
                    className={`${pageButton} tabular-nums ${
                      entry === page
                        ? "border-brand-ring bg-brand-tint font-semibold text-slate-900"
                        : "border-transparent text-slate-800 hover:bg-slate-100 active:bg-slate-200"
                    }`}
                  >
                    {entry}
                  </button>
                </li>
              ),
            )}
          </ol>
          <p className="px-2 text-sm tabular-nums text-slate-700 sm:hidden">Page {page} of {totalPages}</p>

          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className={`${pageButton} border-slate-500 bg-white text-slate-800 hover:bg-slate-50 active:bg-slate-100`}
          >
            Next&nbsp;<span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
