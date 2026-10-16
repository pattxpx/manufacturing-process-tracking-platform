export type OrderStatus =
  | "new" | "in_production" | "awaiting_qc" | "qc_failed" | "ready_for_release" | "released";
export type StepKey =
  | "design_review" | "printing" | "post_processing" | "quality_inspection" | "final_release";

/** What the whole order needs of one material, and how much is in stock right now. */
export interface MaterialRequirement { name: string; unit: string; quantity: number; available: number }

export interface Order {
  id: number;
  order_number: string;
  product: string;
  quantity: number;
  design_reference: string;
  notes: string | null;
  status: OrderStatus;
  current_step: StepKey;
  step_state: "waiting" | "running" | "done";
  queued_at: string;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_edit_production_fields: boolean;
  latest_inspection_result: "pass" | "fail" | null;
  release_blockers: string[];
  // Planned times (UTC). The actual times are in production_records.
  planned_machine_id: number | null;
  planned_start_at: string | null;
  estimated_duration_minutes: number | null;
  planned_end_at: string | null;
  schedule_state: ScheduleState | null;
  can_plan: boolean; // the server says whether the print job may be planned now
}
export type ScheduleState = "planned" | "running" | "delayed" | "completed";

export interface ProductionRecord {
  id: number; step: StepKey; status: "in_progress" | "completed";
  machine_name: string | null; started_at: string; completed_at: string | null;
}
export interface Inspection {
  id: number; order_id: number; order_number: string; result: "pass" | "fail";
  notes: string | null; inspected_at: string; inspected_by: string;
}
export interface HistoryEntry {
  id: number; order_id: number; order_number: string; from_status: string | null;
  to_status: string; note: string; actor: string; created_at: string;
}
export interface OrderDetail extends Order {
  production_records: ProductionRecord[];
  inspections: Inspection[];
  history: HistoryEntry[];
  material_requirements: MaterialRequirement[];
}

export interface Machine {
  id: number; name: string; status: "idle" | "busy";
  current_order_id: number | null; current_order_number: string | null;
}
export interface Resource {
  id: number; name: string; unit: string; on_hand: number; reserved: number; available: number;
  /** Waiting print jobs that cannot get enough of this material (only from GET /api/resources) */
  waiting_short_total: number; waiting_short_orders: { id: number; order_number: string }[];
  category: string; min_stock: number; is_active: boolean; low_stock: boolean;
}
export interface StockAdjustment {
  id: number; resource_id: number; resource_name: string; unit: string; quantity_change: number;
  on_hand_before: number; on_hand_after: number; reason: string; actor_username: string; created_at: string;
}

/** One page of a list from the API. */
export interface Paged<T> { items: T[]; total: number; page: number; page_size: number; total_pages: number }

export interface BoardItem {
  order: Order;
  position: number | null; // place in the FIFO queue; null when the order is not waiting in a queue
  can_start: boolean;
  blocked_reasons: string[];
  material_requirements: MaterialRequirement[];
}
export interface BoardStep { step: StepKey; label: string; total: number; orders: BoardItem[] }
export interface Board { steps: BoardStep[]; released_total: number; limit: number }
export interface ResourceUsage {
  id: number; order_id: number; order_number: string; resource_id: number; resource_name: string; unit: string;
  reserved_quantity: number; actual_quantity: number | null; status: "reserved" | "consumed";
  created_at: string; consumed_at: string | null;
}
export interface QueueItem {
  position: number; step: StepKey; order: Order; can_start: boolean;
  blocked_reasons: string[]; material_requirements: MaterialRequirement[];
}
export interface StepSummary { step: StepKey; label: string; waiting: number; running: number; completed: number }
export interface DashboardSummary {
  total_orders: number; in_production: number; awaiting_qc: number; qc_failed: number; released: number;
  steps: StepSummary[]; machines: Machine[]; resources: Resource[]; recent_activity: HistoryEntry[];
}
export interface ProductMaterial { name: string; unit: string; per_unit: number }
export interface Product { name: string; materials: ProductMaterial[] }

export interface ScheduleJob {
  order_id: number; order_number: string; product: string; quantity: number; machine_id: number;
  planned_start_at: string; planned_end_at: string; estimated_duration_minutes: number; state: ScheduleState;
  actual_start_at: string | null; actual_end_at: string | null; material_short_now: boolean; can_change: boolean;
}
export interface SchedulePrinter {
  id: number; name: string; status: "idle" | "busy"; current_order_number: string | null;
  next_planned_order_number: string | null; next_planned_start_at: string | null; jobs: ScheduleJob[];
}
export interface UnscheduledOrder {
  id: number; order_number: string; product: string; quantity: number; current_step: StepKey; queued_at: string;
}
export interface Schedule {
  timezone: string; now: string; window_start: string; window_end: string; printers: SchedulePrinter[];
  unscheduled: UnscheduledOrder[]; unscheduled_total: number; alerts: string[];
}

export interface AppUser {
  id: number; username: string; full_name: string; role: string; is_active: boolean;
  created_at: string; last_login_at: string | null;
}
export interface RoleInfo { name: string; permissions: string[] }
export interface AuditEvent {
  id: number; created_at: string; actor_username: string | null; action: string; target_type: string | null;
  target_id: string | null; success: boolean; ip: string | null; details: string | null;
}
