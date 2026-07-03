import { rangeSelectIds } from "$lib/client/utils";

// The shared mousedown → selection protocol for drag-selectable rows:
//   shift        → range-select from the nearest selected row (applied now)
//   on selected  → defer to click (a drag must keep the multi-selection);
//                  the click then removes it (cmd/ctrl) or makes it the solo
//                  selection
//   otherwise    → add (cmd/ctrl) or replace, applied now so the drag that may
//                  follow picks it up
export type RowMouseDownPlan = {
  /** Selection to apply immediately (before a potential drag starts). */
  apply?: Set<string>;
  /** Deferred selection change, run only if the gesture ends as a plain click.
   *  Receives the selection as it stands at click time. */
  onClick?: (current: ReadonlySet<string>) => Set<string>;
};

export function resolveRowMouseDown(
  ev: MouseEvent,
  id: string,
  orderedIds: string[],
  selected: ReadonlySet<string>,
): RowMouseDownPlan {
  const selectDuo = ev.metaKey || ev.ctrlKey;
  if (ev.shiftKey) {
    return { apply: new Set(rangeSelectIds(orderedIds, id, (rowId) => selected.has(rowId))) };
  }
  if (selected.has(id)) {
    return {
      onClick: (current) => {
        const next = new Set(current);
        if (selectDuo) next.delete(id);
        else {
          next.clear();
          next.add(id);
        }
        return next;
      },
    };
  }
  const next = selectDuo ? new Set(selected) : new Set<string>();
  next.add(id);
  return { apply: next };
}
