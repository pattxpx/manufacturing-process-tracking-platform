import { getDisplayTimeZone } from "@/lib/format";
import type { Schedule, ScheduleState } from "@/lib/types";

const HOUR = 3600_000;

const barStyle: Record<ScheduleState, string> = {
  planned: "border-slate-500 bg-white text-slate-900",
  running: "border-blue-600 bg-blue-50 text-blue-950",
  delayed: "border-amber-600 bg-amber-50 text-amber-950",
  completed: "border-emerald-600 bg-emerald-50 text-emerald-950",
};
const stateLabel: Record<ScheduleState, string> = {
  planned: "Planned", running: "Running", delayed: "Delayed", completed: "Completed",
};
const stateMark: Record<ScheduleState, string> = { planned: "○", running: "●", delayed: "!", completed: "✓" };

function hourLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: getDisplayTimeZone() });
}
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: getDisplayTimeZone() });
}
function dayKey(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: getDisplayTimeZone() });
}

/**
 * A Gantt-style view of the printers over time: the planned slot of every job, a thin line under it for the
 * ACTUAL time the job ran, and a line for "now". It is a picture: the table under it on the Schedule page has
 * the same information in text (and is the layout used on phones).
 */
export function ScheduleTimeline({ schedule }: { schedule: Schedule }) {
  const start = new Date(schedule.window_start).getTime();
  const end = new Date(schedule.window_end).getTime();
  const span = end - start;
  const hours = span / HOUR;
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - start) / span) * 100));

  const step = hours <= 24 ? 3 : hours <= 72 ? 6 : 12;
  const ticks: number[] = [];
  const first = Math.ceil(start / (step * HOUR)) * step * HOUR;
  for (let t = first; t < end; t += step * HOUR) ticks.push(t);
  const nowPct = pct(new Date(schedule.now).getTime());
  const nowVisible = new Date(schedule.now).getTime() >= start && new Date(schedule.now).getTime() <= end;

  return (
    <div className="overflow-x-auto" aria-hidden="true" data-testid="schedule-timeline">
      <div className="relative" style={{ minWidth: Math.max(860, hours * 30) }}>
        <div className="relative ml-24 h-10 border-b border-slate-300 text-xs text-slate-700">
          {ticks.map((t, index) => {
            const newDay = index === 0 || dayKey(t) !== dayKey(ticks[index - 1]);
            return (
              <div key={t} className="absolute top-0 h-full border-l border-slate-200 pl-1" style={{ left: `${pct(t)}%` }}>
                {newDay && <div className="font-semibold text-slate-900">{dayLabel(t)}</div>}
                <div className={newDay ? "" : "mt-4"}>{hourLabel(t)}</div>
              </div>
            );
          })}
        </div>

        {schedule.printers.map((printer) => (
          <div key={printer.id} className="flex border-b border-slate-100">
            <div className="flex w-24 shrink-0 flex-col justify-center pr-2 text-sm font-medium text-slate-900">
              {printer.name}
              <span className="text-xs font-normal text-slate-600">{printer.status === "busy" ? "Busy" : "Free"}</span>
            </div>
            <div className="relative h-16 flex-1 border-l border-slate-200">
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-slate-100" style={{ left: `${pct(t)}%` }} />
              ))}
              {printer.jobs.map((job) => {
                const left = pct(new Date(job.planned_start_at).getTime());
                const right = pct(new Date(job.planned_end_at).getTime());
                const actualStart = job.actual_start_at ? new Date(job.actual_start_at).getTime() : null;
                const actualEnd = job.actual_end_at ? new Date(job.actual_end_at).getTime() : new Date(schedule.now).getTime();
                return (
                  <div key={job.order_id}>
                    <div
                      className={`absolute top-1.5 h-9 overflow-hidden rounded border-2 px-1.5 py-0.5 text-xs leading-tight ${barStyle[job.state]} ${job.state === "planned" ? "border-dashed" : ""}`}
                      style={{ left: `${left}%`, width: `${Math.max(right - left, 1.2)}%` }}
                      title={`${job.order_number}: ${stateLabel[job.state]}`}
                    >
                      <div className="truncate font-semibold">{stateMark[job.state]} {job.order_number}</div>
                      <div className="truncate">{stateLabel[job.state]}</div>
                    </div>
                    {actualStart !== null && (
                      <div
                        className="absolute top-12 h-1.5 rounded bg-blue-700"
                        style={{ left: `${pct(actualStart)}%`, width: `${Math.max(pct(actualEnd) - pct(actualStart), 0.6)}%` }}
                      />
                    )}
                  </div>
                );
              })}
              {nowVisible && <div className="absolute top-0 h-full w-0.5 bg-red-600" style={{ left: `${nowPct}%` }} />}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-600">
        Dashed box = planned time. Thin line = time actually printed. Red line = now. Times are in {schedule.timezone}.
      </p>
    </div>
  );
}
