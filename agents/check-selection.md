# Check selection ↔ row selection exclusivity, and Delete on selected checks

Status: implemented 2026-07-06.

## The problem

Checks are selected by clicking their drag handles (`CheckList.svelte`, local
`selected` state), but Delete/Backspace was handled only at the panel level
(`usePanelKeydown` in `PanelMain.svelte` / `PlacementView.svelte`) against the
ROW selection — so with checks visibly selected, Delete trashed the selected
rows instead. Row and check selections could also coexist (clicking a check
handle happens inside a `.movable` row, so TodoList's `selectedCleanup` never
fired), which is what made the keypress ambiguous in the first place.

## The rule

One selection at a time, app-wide:

- At most ONE checklist has selected checks (a global singleton, like the
  single tagged undo stack).
- A check selection never coexists with any row selection (project rows or
  placement entries, any panel).

So Delete/Backspace always has exactly one selection to act on.

## Where each piece lives

- `src/lib/client/check-selection.ts` — tiny owner registry (no runes; the
  reactive state stays in the owning CheckList, which registers a `clear`
  callback). `claimCheckSelection` / `releaseCheckSelection` /
  `clearCheckSelection`.
- `src/lib/client/mutate-local.ts` — both exclusivity directions in the state
  layer: `useSetRowSelected` / `useSelectRow` / `useSetPlacementSelected` call
  `clearCheckSelection()` when setting a non-empty selection;
  `useClearRowSelections` sweeps every panel instance (project `rowSelected`,
  placement `selected`) and is called by CheckList when it claims.
- `CheckList.svelte` — one `$effect` gated on "any check selected": claims the
  ownership + clears row selections, and installs document CAPTURE-phase
  listeners: Delete/Backspace deletes the selected checks via
  `mut.deleteCheck(Set)` (capture + `stopPropagation` so the panel-level row
  shortcuts never see the keypress), Escape deselects, mousedown outside the
  list (a `display:contents` wrapper provides the root for `contains`)
  deselects. Teardown releases ownership (also covers unmount).

## Notes

- `useDeleteCheck` / `useDeletePlacementCheck` already accepted
  `string | Set<string>`; only the component-level `deleteCheck` prop types
  (CheckList, ExpandedTodo, PlacementView's `todoMutFor`) needed widening. A
  multi-check Delete is therefore ONE mutator call → ONE undoable "checks"
  entry (see agents/undo-check-moves.md); Cmd+Z restores all deleted checks
  at once. The all-empty-checks-interrupt rule applies unchanged.
- The `isEditableTarget` guard in the keydown handler keeps typing safe in the
  (hard to reach) case where focus sits in an editor while a selection is
  visible.
- Panel handlers needed NO changes: exclusivity guarantees their row-delete
  branch sees an empty row selection whenever checks are selected, and the
  capture-phase stop keeps the event away from them anyway.
