import type { CalendarDate } from "@internationalized/date";

// The date all given todos agree on, or null when they differ (or none is
// planned). Seeds the date picker when scheduling a multi-selection.
export function agreedPlannedDate(dates: Iterable<CalendarDate | null>): CalendarDate | null {
  let agreed: CalendarDate | null = null;
  for (const d of dates) {
    if (d == null) continue;
    if (agreed == null) agreed = d;
    else if (agreed.compare(d) !== 0) return null;
  }
  return agreed;
}
