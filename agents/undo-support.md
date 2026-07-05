# Undo/Redo for Row Movement — Plan

> **Status: implemented — and extended well beyond this plan.** The body below
> is the ORIGINAL plan, kept for its findings and rationale; where it conflicts
> with the code, the **"As implemented" section at the bottom is authoritative**.
> The implementation went further than planned: ALL todo moves record history
> (inbox/archive/trash included, not just `useMoveRow`), invalidation is
> stricter (every non-move data mutation interrupts), interruption is
> gesture-atomic, the sync queue gained guards for undo racing an in-flight
> push, and an end-of-history cue pill was added.

Original plan scope (superseded — see "As implemented"): undo/redo for **row
movement only** — reorders within a project and moves between projects
(`useMoveRow`). Field edits are never tracked, and any structural change other
than a row move (create / delete / archive / trash / placement moves) simply
**clears the whole history**. History has a fixed maximum length.

## How movement works today (findings)

The mutator layer (`src/lib/client/mutate-remote.ts`) follows one shape
everywhere, built by `createMutator` (`src/lib/client/context.ts`):

1. Mutate the reactive `AppState` in place (Svelte reactivity re-renders).
2. Record the change into the sync overlay via a `record*` call
   (`src/lib/client/sync.svelte.ts`), which schedules a batched push.

For row movement specifically, `useMoveRow` (mutate-remote.ts:59):

- Collects the moving rows from `fromProject.rows` (`collectMoving`), filters
  them out of both projects' `rows` arrays, and splices them in at the target
  index (`insert`).
- On a cross-project move it also deletes the moved ids from `rowSelected` on
  every panel showing the source project.
- Records the **complete new order** of each affected project with
  `recordRowOrder(projId, rowOrderOf(project))` — the wire format is a full
  ordered list, not a diff. The server treats the pushed order as
  authoritative for that project.

Two properties make undo easy here:

- **Order is the whole story.** A move changes nothing but the membership +
  ordering of `project.rows` arrays (plus panel selection). No fields, no
  identities.
- **Sync is order-idempotent.** Re-pushing a full row order via
  `recordRowOrder` is exactly how a move syncs in the first place, so undo can
  reuse the identical sync path — no new wire concepts.

Call sites: drag-drop in `TodoList.svelte` (same-panel) and
`ProjectList.svelte` (cross-panel drop, via `useMoveRow.dynamic()`). Both
funnel into the one mutator, so recording history inside `useMoveRow` covers
every UI entry point automatically.

## Design

### History model: order snapshots, not commands

Each history entry stores the row-id order of the affected project(s) before
and after the move:

```ts
// projId → ordered row ids (1 entry for in-project reorder, 2 for cross-project)
type OrderSnapshot = Record<string, string[]>;

type MoveHistoryEntry = {
  before: OrderSnapshot;
  after: OrderSnapshot;
};
```

Undo = apply `before`; redo = apply `after`. Snapshots beat inverse-command
replay here because applying one is trivially correct (set the array to the
recorded order) and validation is trivially checkable (every id must still
resolve to a live row). Since anything that could invalidate a snapshot
(create/delete/archive/…) clears the history, a surviving entry is always
applicable — the validation is defense-in-depth only.

### New module: `src/lib/client/undo.svelte.ts`

```ts
const MAX_HISTORY = 50;

const undoStack: MoveHistoryEntry[] = $state([]);
const redoStack: MoveHistoryEntry[] = $state([]);

export const recordMove = (before: OrderSnapshot, after: OrderSnapshot) => { … };
export const clearMoveHistory = () => { … };
export const undoMove = (state: AppState) => { … };
export const redoMove = (state: AppState) => { … };
export const canUndo = () => undoStack.length > 0;   // for menu/toolbar affordances
export const canRedo = () => redoStack.length > 0;
```

`$state` arrays so any future toolbar button can reactively enable/disable;
costs nothing for keyboard-only use. A `.svelte.ts` module mirrors how
`sync.svelte.ts` and `session.svelte.ts` hold module-level reactive state.

- `recordMove`: skip if `before` and `after` are deep-equal (drop-in-place —
  don't pollute history with no-ops); push onto `undoStack`; **clear
  `redoStack`** (standard linear-history semantics); `shift()` the oldest
  entry when length exceeds `MAX_HISTORY`.
- `clearMoveHistory`: empty both stacks.

### Applying a snapshot (`undoMove` / `redoMove`)

Pop from one stack, apply the corresponding snapshot, push the entry onto the
other stack. Applying `snap: OrderSnapshot`:

1. Resolve every `projId` in `snap` via `projOf(state, projId)`. If any is
   missing (project pruned/deleted through a path we failed to invalidate on),
   `clearMoveHistory()` and bail — never half-apply.
2. Build a pool `Map<rowId, RowItem>` from the rows of **all** affected
   projects (a cross-project undo pulls the row back from the project it
   currently sits in — same pool trick `useMoveRow` uses with its
   double-filter).
3. If any id in `snap` is absent from the pool, `clearMoveHistory()` and bail
   (stale entry — shouldn't happen given the invalidation rules).
4. For each project: `project.rows = snap[projId].map(id => pool.get(id)!)`.
   Defensively append any pooled row *not* named in the snapshot to the end of
   the project it currently lives in, rather than dropping it.
5. Mirror `useMoveRow`'s panel hygiene: for rows that changed projects, delete
   their ids from `rowSelected` (and `todoExpanded`) on panels showing the
   project they left.
6. Sync exactly like a move: `recordRowOrder(projId, rowOrderOf(project))`
   for every affected project. Nothing else — the existing dispatch loop
   batches and pushes it.

No context is needed (undo is app-global, not panel-scoped), so these are
plain functions taking `state`, not `createMutator` hooks — the keyboard
handler lives at the app root where `getAppState()` is available.

### Recording inside `useMoveRow`

In `useMoveRow` (mutate-remote.ts:59):

- After the guards pass (`moving.length > 0`, both projects resolve), snapshot
  `before = { [fromId]: ids…, [toId]: ids… }` (one key when same project) —
  **before** the filter/insert mutations.
- At the end, snapshot `after` the same way and call
  `recordMove(before, after)`.
- The early-return paths record nothing, matching their no-op semantics.

That's the only mutator that records history in this iteration. *(Superseded:
seven mutators record — see "As implemented".)*

### Invalidation: who calls `clearMoveHistory()`

Per the chosen policy, everything structural that isn't a tracked move clears
history. Creates must clear too: snapshots are *complete* orders, so a row
created after a move would be absent from every snapshot and undo would
otherwise trip the stale check anyway.

In `mutate-remote.ts` (explicit one-line call at the top of each — greppable,
no `createMutator` magic):

| Mutator | Why |
|---|---|
| `useCreateTodo`, `useCreateGrouping` | new row not in any snapshot |
| `useDeleteRow` | rows gone |
| `useArchiveTodo`, `useTrashTodo`, `useMoveToInbox`, `useMoveToPlacementFrom` | rows leave a project |
| `useMoveFromPlacementToProject` | rows enter a project |
| `useDeleteProject`, `useArchiveProject`, `useTrashProject` | project (or its `projs` entry, via `pruneDrillIns`) can vanish |
| `usePurgeTrash` | can hard-delete projects |
| `useRestoreProjects` | archived/trashed projects re-enter the list |

Outside the mutators:

- `resetSyncState()` in `app-session.ts` (sign-in/out/account-switch) — a
  different user's history must not survive; add the clear right next to it.
- Wherever pulled deltas are applied over live projects: the refresh path in
  `app-session.ts` (both `applyProjDeltaToProject` call sites) and
  `bootstrap-apply.ts` — server state replacing local rows makes snapshots
  meaningless. One clear per apply-pass is enough (not per project).

Not invalidating (deliberately): field edits (`useEditTodo`, `useEditCheck`,
`useMarkTodo`, `useSetPlanned`, …) — they never change membership/order and
snapshots reference ids, not contents; all of `mutate-local.ts` (selection,
panels, layout — pure UI state).

### Keyboard wiring

History is app-global (one stack across panels), so don't use
`usePanelKeydown` (that's per-focused-panel). Instead, one document-level
`keydown` listener at the app root component (where `setAppStateContext` runs
/ `+page.svelte`):

- Skip when `isEditableTarget(e)` (exported by
  `src/lib/components/list-kit/keys.svelte.ts`) — text inputs keep native
  text undo.
- `Cmd/Ctrl+Z` → `undoMove(state)`; `Shift+Cmd/Ctrl+Z` and `Ctrl+Y` →
  `redoMove(state)`. `preventDefault()` only when a step was actually applied
  (stack non-empty), so the browser default survives otherwise.

## Implementation steps

1. **`src/lib/client/undo.svelte.ts`** (new): types, stacks, `recordMove`,
   `clearMoveHistory`, `undoMove`/`redoMove` with the apply routine above,
   `canUndo`/`canRedo`. ~100 lines.
2. **`mutate-remote.ts`**: snapshot + `recordMove` in `useMoveRow`;
   `clearMoveHistory()` calls in the table above.
3. **`app-session.ts` / `bootstrap-apply.ts`**: clear alongside
   `resetSyncState()` and after delta application.
4. **App root**: global keydown handler for undo/redo.
5. Manual verification (guest mode is enough — sync path is shared):
   - reorder within a project → undo restores order → redo reapplies;
   - drag a row to another project (second panel) → undo returns it to its
     source position, selection in the target panel doesn't linger;
   - move, then create/delete/archive a row → undo does nothing (history
     cleared);
   - >MAX_HISTORY moves → oldest entries dropped;
   - signed in: undo → check the network push carries the restored full order.

## Explicit non-goals / later extensions

- **Project-list reorder** (`useMoveProject`, `useRestoreProjects`) and
  **check reorder** (`useMoveCheck`, `useMovePlacementCheck`): same
  snapshot-of-ids pattern would work (`state.projOrder` +
  `recordProjListOrder`; `todo.checks` + `recordCheckOrder`), either as more
  entry variants on the same stacks or separate histories. Excluded now to
  keep the entry type single-shaped.
- **Placement↔project moves as undoable** (`useMoveFromPlacementToProject`,
  `useArchiveTodo`, …): the inverse crosses the row/`ArchiveEntry`
  representation boundary and touches `placementMoves` sync, so they stay
  history-clearing instead. *(Superseded: these WERE made undoable, by
  retaining member objects per-container-representation — see "As
  implemented".)*
- **Field-edit undo, delete undo**: out of scope by decision; deletes clear
  history. *(Superseded for GROUPING deletes — they record; see "As
  implemented". Todo hard deletes still clear.)*
- **Persistence**: history is in-memory only; a reload starts empty.

## As implemented

The implementation follows this plan's mechanics (snapshot entries on twin
$state stacks, full-order sync reuse, strict invalidation) with these decided
deviations:

- **Stricter ("rigid") invalidation.** Instead of the selective clear table
  above, *every* data mutator in `mutate-remote.ts` outside the recording
  family interrupts (clears) the history — field edits included (todo
  title/note, checks, planned date, project name/note, done toggles, …). Only
  an uninterrupted run of row moves is undoable. Mechanically this is a local
  `createInterruptingMutator` wrapper in `mutate-remote.ts` that fronts
  `createMutator` with a `clearMoveHistory()`; the recording mutators stay on
  the plain `createMutator`. `mutate-local.ts` (selection, panels, layout)
  never clears. Out-of-mutator clears: auth change (next to
  `resetSyncState`), refresh (once after the list pull and again after all
  pulls settle, so moves recorded mid-refresh don't survive against rewritten
  rows), lazy project loads, and lazy placement loads that apply a server
  delta (`app-session.ts`).
- **All todo moves are undoable — inbox, archive, and trash included.** The
  snapshot model was generalized from projects to *containers*, in two
  classes: **positional** (`proj:{id}` — a project's rows; undo restores the
  exact order via a full `recordRowOrder` push) and **recency** (`inbox` /
  `archive` / `trash` — the wire only expresses enter/leave, so undo restores
  *membership* and a re-entering todo lands at the top, which is correct
  recency semantics). Snapshots retain the member objects in the
  representation of the container they were captured in (a `RowItem` in
  project/inbox, an `ArchiveTodoEntry` in archive/trash), so applying a side
  just re-inserts the stored objects — no representation reconstruction, and
  field edits can't have mutated a retained object because edits interrupt.
  Recording mutators: `useMoveRow`, `useMoveFromPlacementToProject`,
  `useMoveToPlacementFrom`, `useMoveToInbox`, `useArchiveTodo`,
  `useTrashTodo`, `useMovePlacementToPlacement`. Every PROJECT move still
  interrupts.
- **Gesture-atomic interruption.** A single gesture can mix a recordable todo
  move with an interrupting project move (restoring a mixed trash selection,
  archive→trash context delete, mixed drops onto placement views /
  operation rows). Whatever the call order inside the gesture, no partial
  history entry may survive — undo would otherwise revert the todos while the
  projects stay put. `clearMoveHistory` therefore also suppresses
  `recordMove` for the remainder of the current microtask.
- **In-flight pushes.** If a move's forward mutation is still queued when its
  undo is recorded (a push was in flight / retrying when the user moved),
  forward and inverse compose into ONE push, and the server applies placement
  arranges last and in fixed archive→trash→inbox order — not recording
  order. Two guards in the sync layer keep the composed push equal to the
  final intent: `recordPlacementMove` is last-wins per entity (an earlier
  queued move of the same todo/proj is superseded, inline create `data`
  carried forward), and undo/redo pulling a todo back into a project calls
  `supersedePlacementMoves` to drop its queued placement arrival, flagging
  the row `createHere` in the recorded row order in case that arrival was the
  todo's server-side create vehicle.
- **Grouping deletes are undoable** *(added 2026-07-05)*. The delete-selection
  gesture (Delete key / context menu) is ONE recording mutator,
  `useTrashOrDeleteRows`, replacing the old `useTrashTodo` + interrupting
  `useDeleteRow` pair: todos → trash, groupings → hard delete, one history
  entry — so a mixed selection (which previously left groupings behind) now
  deletes everything and restores everything on a single undo. A hard-deleted
  grouping exists in NO container on the entry's other side; its retained
  snapshot object is the only survivor. Undo re-inserts it locally and
  re-creates it server-side by flagging it `createHere` in the row-order push
  with its label re-recorded as the INSERT's field data (`applyRowOrder`
  INSERTs unknown+createHere rows and ignores the flag on known rows, so a
  not-yet-dispatched delete is harmless); redo records the hard delete again.
  No new sync-queue guards were needed: the server applies `deleteRows` before
  `orderRows` within a push and the row order is a full-state last-wins
  replacement, so delete+restore (or restore+delete) composed into one push
  still lands on the final intent. Todo HARD deletes are still never recorded
  (their undo would need full field/check re-push) and keep clearing history.
- **End-of-history cue.** Invoking undo/redo with nothing left to apply
  flashes a transient pill ("Nothing to undo" / "Nothing to redo") styled and
  positioned identically to app.html's status banner ("Making page
  interactive…"): top-center, dark translucent, rounded-full.
  `undo.svelte.ts` exposes a reactive `undoCue` (kind + bumping seq);
  `UndoRedo.svelte` renders the pill and re-arms its 1.4 s hide timer on each
  press.
- **Entry point**: keyboard only for now. `UndoRedo.svelte` (mounted in
  `+page.svelte`) installs a document-level keydown listener — Cmd/Ctrl+Z
  undoes, Shift+Cmd/Ctrl+Z or Ctrl+Y redoes, text-editing targets are left to
  native text undo (`isEditableTarget`). Unlike the plan, `preventDefault()`
  fires even with nothing to apply — the cue pill covers that case, and the
  browser default (e.g. Cmd+Z reverting an earlier input) would be confusing.

Files: `src/lib/client/undo.svelte.ts` (new), `src/lib/components/UndoRedo.svelte`
(new), `src/lib/client/mutate-remote.ts`, `src/lib/client/sync.svelte.ts`
(last-wins placement-move queue + `supersedePlacementMoves`),
`src/lib/client/app-session.ts`, `src/routes/+page.svelte`.
