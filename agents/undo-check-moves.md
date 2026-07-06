# Undo/Redo for Check Moves (Reorder + Delete) — Design

> **Status: implemented 2026-07-05** (as designed; outcome folded into
> agents/undo-support.md "As implemented"). Extends the shipped row/todo-move undo
> (agents/undo-support.md, `src/lib/client/undo.svelte.ts`) with a second
> undoable domain: check reorders and check deletes, in project todos and
> placement (inbox/archive/trash) todos alike.

## Required semantics (from discussion)

- Check **reorder** and check **delete** are undoable.
- Check **create** and check **edit** (text or tick) reset the history.
- Any other entity's change resets it too — todo moves, todo edits, project
  edits, everything already in the interrupting family.
- Symmetrically, a check reorder/delete resets the **todo-move** history.
- Net effect: the two histories can never coexist. At any moment there is at
  most one non-empty history, belonging to whichever domain acted last.

## Reasoning through the cases

Walking the mutation surface against those rules:

| Action | Effect on history |
|---|---|
| `useMoveCheck` / `useMovePlacementCheck` (reorder) | records a **checks** entry; implicitly wipes any row-move run |
| `useDeleteCheck` / `useDeletePlacementCheck` | records a **checks** entry; the deleted `CheckItem`s survive only in the entry's `before` side (the grouping-delete pattern) |
| `useCreateCheck` / `useCreatePlacementCheck` | interrupts (clears everything) — a new check is immediately in text-edit mode; native text undo owns it |
| `useEditCheck` / `useEditPlacementCheck` (text or tick) | interrupts. This is also what keeps retained snapshot objects truthful: a snapshot holds live `CheckItem` references, and no edit can mutate them behind history's back because every edit clears it |
| any row/todo move (`useMoveRow`, `useTrashOrDeleteRows`, …) | records a **rows** entry; implicitly wipes any check run |
| every other data mutator | interrupts, exactly as today |
| server pulls, auth change, lazy loads (`app-session.ts`) | already call the global clear — nothing new to wire |
| `mutate-local.ts` (selection, expansion, panels, layout) | never touches history, unchanged |

Consequences worth spelling out:

- **The todo hosting a recorded check run can never relocate or vanish while
  the run is live.** Moving it records a rows entry (domain switch → check
  history cleared); trashing it via `useTrashOrDeleteRows` likewise; hard
  deletes and purges interrupt. So a surviving checks entry always refers to a
  todo that is still exactly where it was captured. The stale-todo check in
  the apply routine is defense-in-depth only, mirroring the vanished-project
  check in `applyEntry`.
- **Keyboard merge/split gestures** (return/delete inside check text) mix an
  edit with a delete or create. The existing gesture-atomicity mechanic
  already handles them: whichever order the mutators run in, the interrupting
  edit either clears the just-recorded delete entry or suppresses recording
  for the rest of the microtask (`suppressRecording`). Result: merges/splits
  are not undoable (they're edits — correct per the rules), and no half-entry
  can survive. The undoable delete is the pure delete gesture
  (delete-selection on checks / delete at an empty check).
- **Checks never move between todos** — `useMoveCheck` takes ids + index
  within one todo. So a checks entry involves exactly ONE container. No
  multi-container snapshot, no recency semantics, no cross-representation
  concerns: the check domain is a strict subset of the row domain's
  complexity.

## Why the wire already supports this (findings)

The check sync path has the same two properties that made row undo cheap:

- **Full-order, last-wins, absence-deletes.** `applyCheckOps`
  (push-handler.ts) treats `orderChecks` as the COMPLETE desired list per
  todo: checks absent from it are deleted, `createHere` entries are INSERTed
  with field data taken from `editChecks` in the same push, the flag is
  ignored on known checks. And the client queue (`recordCheckOrder` /
  `recordPlacementCheckOrder` in sync.svelte.ts) stores one order per todo,
  each record replacing the last.
- **Delete-restore composition is even simpler than groupings.** Deletion is
  expressed *through* the order (no separate delete op), and the queue is
  last-wins per todo, so a queued delete-order overwritten by an undo's
  restore-order before dispatch collapses to "reorder + harmless re-edit";
  restore racing an already-dispatched delete lands as createHere INSERT. No
  new queue guards needed — nothing like `supersedePlacementMoves` applies,
  because checks never interact with placement arranges.
- **The restore push is byte-for-byte the create push.** Undoing a check
  delete records `recordCheckEdit(content, ticked)` + full order with
  `createHere` — exactly what `useCreateCheck` / `useCreatePlacementCheck`
  already emit, so server-side op ordering is already proven.

## Design: one history, tagged by domain

The neat move is a reframe, not a second machine. `undo.svelte.ts` currently
holds "the history of the most recent uninterrupted run of row moves".
Generalize it to "the history of the most recent uninterrupted run of
undoable mutations **of one domain**":

```ts
type ChecklistRef =
  | { scope: "project"; projId: string; todoId: string }
  | { scope: "placement"; placement: PlacementName; todoId: string };

type HistoryEntry =
  | { kind: "rows"; before: Snapshot; after: Snapshot }          // existing
  | { kind: "checks"; ref: ChecklistRef; before: CheckItem[]; after: CheckItem[] };
```

Same twin `$state` stacks, same `MAX_HISTORY`, same cue pill, same
`UndoRedo.svelte` — untouched. Two recording entry points funnel into one
push:

```ts
const record = (entry: HistoryEntry) => {
  if (suppressRecording) return;
  if (undoStack.at(-1)?.kind !== entry.kind) undoStack.length = 0;  // domain switch
  // …existing no-op skip, push, redo clear, MAX_HISTORY shift
};
```

That one line IS the mutual-reset rule. Because there is only one history,
"check moves reset todo-move history and vice versa" isn't a policy that N
call sites must remember to enforce — it's structurally impossible to
violate. Both stacks stay homogeneous by construction, `canUndo`/`canRedo`
and the keyboard handler don't care which domain is loaded, and every
existing global clear site (interrupting mutators, auth, pulls, lazy loads)
covers both domains for free because there is only one thing to clear.

`step()` dispatches on `entry.kind`: rows entries go to the existing
`applyEntry`, checks entries to a new `applyCheckEntry`.

### `applyCheckEntry(state, ref, target, source)` (~40 lines)

1. Resolve the live checks array from `ref` — project scope via
   `projOf(state, projId)` → `rows.find(todoId)`, placement scope via a small
   local resolver over `state.inbox` / `state.archive` / `state.trash`
   (undo.svelte.ts can't import mutate-remote's `findPlacementTodo` — that
   would cycle — and it only needs the checks get/set, not `applyEdit`).
   Todo missing → return false; `step()` clears history and flashes the cue,
   exactly like a vanished project.
2. Set the checklist to `[...target]` — retained objects, no reconstruction.
3. For ids in `target` but not `source` (restoring a delete):
   `recordCheckEdit(id, todoId, …, { content, ticked })` and flag the row
   `createHere` in the order push. Ids in `source` but not `target` (redoing
   a delete): nothing — absence from the full order deletes server-side.
4. Push the full order: `recordCheckOrder(projId, todoId, entries)` or
   `recordPlacementCheckOrder(todoId, entries)`.

No panel hygiene needed: checks carry no per-panel selection/expansion state
keyed by id the way rows do (check selection lives in the expanded todo's
local component state).

### Mutator changes (`mutate-remote.ts`)

Four mutators switch from `createInterruptingMutator` to plain
`createMutator` + record:

| Mutator | Entry captured |
|---|---|
| `useMoveCheck` | `{ scope: "project", projId, todoId }`, checks before/after the splice |
| `useDeleteCheck` | same ref; deleted checks retained on the `before` side |
| `useMovePlacementCheck` | `{ scope: "placement", placement, todoId }` |
| `useDeletePlacementCheck` | same ref |

Each is a 2-line addition (`const before = [...checks]` … `recordChecks(ref,
before, after)`); `recordChecks` skips no-op reorders like `recordMove` does.
Every other mutator — including all check creates/edits — stays exactly as it
is.

### Rejected alternatives

- **Two independent history modules with cross-clear wiring.** Every check
  mutator calls `clearMoveHistory`, every row mutator calls
  `clearCheckHistory`, the keyboard handler picks the non-empty stack, and
  every global clear site must remember both. The invariant lives in
  discipline instead of structure, and "which history does Cmd+Z hit if both
  are non-empty" becomes a question that shouldn't exist.
- **Folding checklists into the rows Snapshot as a `checks:{todoId}`
  container key.** One entry type, but `Member`, `snapshot`, and `applyEntry`
  all grow scope-conditionals (checklists aren't state-root containers, sync
  through a different record family, and need todo resolution), and the
  mutual-reset rule would still need special-casing since rows and checks
  must never share a run anyway. The union entry keeps each apply routine
  simple and honest about what it handles.

## Implementation steps

1. `undo.svelte.ts`: entry union + `ChecklistRef`, `record` with the
   domain-switch clear (rename `recordMove`→ internal, keep exported
   `recordMove`/`recordChecks` wrappers), `applyCheckEntry`, dispatch in
   `step()`. Consider renaming `clearMoveHistory` → `clearUndoHistory`
   (mechanical; ~10 call sites) since it now guards two domains.
2. `mutate-remote.ts`: flip the four mutators to recording; update the
   policy comment block at the top.
3. Docs: fold the outcome into agents/undo-support.md "As implemented";
   update the demo row in mock.ts ("undo todo moves" → mention check
   reorders/deletes).
4. Verify (guest mode suffices; then signed-in for wire checks — see the
   arranger-verify recipe):
   - reorder checks → undo restores order → redo reapplies;
   - delete checks → undo restores them in place (text + tick intact) →
     redo deletes again; signed in: restore push carries createHere + field
     re-record, delete-then-undo before dispatch collapses to one order;
   - check reorder after todo moves → Cmd+Z steps through checks only;
     nothing left flashes the cue (todo-move run gone), and vice versa;
   - edit/tick/create a check after a recorded reorder → history cleared;
   - keyboard merge (backspace at check start) → not undoable, no
     half-entry;
   - placement variants: same flows on an expanded inbox/archive/trash todo.
