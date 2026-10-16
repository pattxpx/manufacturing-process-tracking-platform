"use client";

import { useState } from "react";
import { Badge } from "@/components/Badge";
import { Pagination } from "@/components/Pagination";
import { Select } from "@/components/Select";
import {
  Alert, Card, EmptyState, LoadingBlock, PageHeader, Table, Tbody, Td, Th, Thead, Tr,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { useLiveData, usePagination } from "@/lib/hooks";
import type { AuditEvent, Paged } from "@/lib/types";

const ACTIONS = [
  "login_success", "login_failed", "login_blocked", "logout", "permission_denied", "password_changed", "password_reset",
  "user_created", "user_role_changed", "user_deactivated", "user_activated",
  "order_created", "order_updated", "production_started", "production_completed", "inspection_recorded", "order_released",
  "order_scheduled", "order_rescheduled", "order_schedule_cleared",
  "resource_created", "resource_updated", "stock_adjusted",
];

export default function AuditPage() {
  const { can } = useAuth();
  const [action, setAction] = useState("all");
  const { page, pageSize, setPage, setPageSize } = usePagination(25, action);
  const { data, error, loading, refreshing, reload } = useLiveData(() => {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (action !== "all") query.set("action", action);
    return api<Paged<AuditEvent>>(`/api/audit-events?${query}`);
  }, [action, page, pageSize]);

  if (!can("audit:read")) {
    return <><PageHeader title="Audit log" /><Alert kind="warning">You do not have permission to read the audit log.</Alert></>;
  }

  return (
    <>
      <PageHeader title="Audit log" description="Who did what, and when. Events can be added but never changed or deleted." />
      <Card flush>
        <div className="flex border-b border-slate-200 p-3 sm:p-4">
          <div className="w-full sm:w-72">
            <Select ariaLabel="Filter by action" value={action} onChange={setAction}
              options={[{ value: "all", label: "All actions" }, ...ACTIONS.map((a) => ({ value: a, label: a.replaceAll("_", " ") }))]} />
          </div>
        </div>
        {error && <div className="p-4"><Alert kind="error" onRetry={reload}>{error}</Alert></div>}
        {loading && !data && <LoadingBlock />}
        {data && data.items.length === 0 && <EmptyState title="No events match" />}
        {data && data.items.length > 0 && (
          <div aria-busy={refreshing} className={refreshing ? "opacity-60" : ""}>
            <Table label="Audit events">
              <Thead><Tr><Th>When</Th><Th>Who</Th><Th>Action</Th><Th>Target</Th><Th>Result</Th><Th>Address</Th><Th>Details</Th></Tr></Thead>
              <Tbody>
                {data.items.map((e) => (
                  <Tr key={e.id}>
                    <Td label="When" className="whitespace-nowrap text-slate-600">{formatDateTime(e.created_at)}</Td>
                    <Td label="Who" className="break-all">{e.actor_username ?? "—"}</Td>
                    <Td label="Action" className="font-medium text-slate-900">{e.action.replaceAll("_", " ")}</Td>
                    <Td label="Target" className="break-words">{e.target_type ? `${e.target_type} ${e.target_id ?? ""}` : "—"}</Td>
                    <Td label="Result">{e.success ? <Badge tone="green">OK</Badge> : <Badge tone="red">Refused</Badge>}</Td>
                    <Td label="Address" className="font-mono text-xs">{e.ip ?? "—"}</Td>
                    <Td label="Details" className="max-w-xs break-all font-mono text-xs text-slate-600">{e.details ?? ""}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
        {data && (
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} totalPages={data.total_pages}
            itemName={{ one: "event", many: "events" }} onPageChange={setPage} onPageSizeChange={setPageSize} />
        )}
      </Card>
    </>
  );
}
