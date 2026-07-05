// Undo/redo history for row/todo movement (design: agents/undo-support.md).
//
// Scope: an uninterrupted run of row/todo *moves* is undoable — rows within and
// between projects, and todos moving among projects, the inbox, archive, and
// trash — plus grouping HARD deletes (the delete-selection gesture,
// useTrashOrDeleteRows). Everything else (field edits, creates, todo/project
// deletes, and every PROJECT move) clears this history
// (createInterruptingMutator in mutate-remote.ts), as do auth changes and
// server pulls that rewrite rows (app-session.ts).
//
// ─── The two container classes ───────────────────────────────────────────────
// Every place a row/todo can live is one of:
//
//   • Positional — a project's rows (`proj:{id}`). User-ordered AND carries a
//     full-order push (recordRowOrder), so undo restores exact position with
//     zero client/server divergence.
//   • Recency — inbox / archive / trash. Chronological: the wire can only
//     express "entered (at the top)" / "left", never a reorder. So undo
//     restores MEMBERSHIP; a re-entering todo lands at the top (which is the
//     correct recency semantics — it re-entered just now). No divergence.
//
// ─── Snapshots retain the real objects ───────────────────────────────────────
// A snapshot stores, per container, the actual member objects as they existed
// on that side — a RowItem in a project/inbox, an ArchiveTodoEntry in
// archive/trash. Because each side captured the entity in the representation of
// the container it was in, applying a side just re-inserts the stored object —
// no TodoItem⇆ArchiveTodoEntry reconstruction, and a project filed nowhere here
// so no row-eviction concern. Field edits can't have mutated a retained object
// because any field edit clears the history.
//
// ─── Hard-deleted groupings ──────────────────────────────────────────────────
// A deleted grouping exists in NO container on the entry's other side — the
// retained object in the `before` snapshot is its only survivor. Undo
// re-inserts it locally like any positional member and re-creates it
// server-side: the row-order push flags it createHere (an unknown row with
// createHere is INSERTed by applyRowOrder; for a known row the flag is
// ignored, so a delete push that never landed is harmless) with its label
// re-recorded as the INSERT's field data. Redo records the hard delete again.
// Composition is safe without extra queue guards: the server applies
// deleteRows before orderRows within a push, and the row order is a full-state
// last-wins replacement per project, so delete+restore (or restore+delete)
// queued into one push still lands on the final intent. Only groupings take
// this path — todo hard deletes are never recorded (their undo would need full
// field/check re-push) and keep clearing the history.

import {
  isGroupingItem,
  isProjectInstance,
  projOf,
  type AppState,
  type ArchiveEntry,
  type ArchiveTodoEntry,
  type RowItem,
  type TodoItem,
} from "./model";
import {
  recordGroupEdit,
  recordPlacementMove,
  recordRowArrive,
  recordRowDelete,
  recordRowOrder,
  supersedePlacementMoves,
} from "./sync.svelte";

// ─── Container keys ───────────────────────────────────────────────────────────
export const INBOX = "inbox";
export const ARCHIVE = "archive";
export const TRASH = "trash";
export const projKey = (projId: string) => `proj:${projId}`;

const PROJ_PREFIX = "proj:";
const isProjKey = (k: string) => k.startsWith(PROJ_PREFIX);
const projIdOf = (k: string) => k.slice(PROJ_PREFIX.length);
const isRecencyKey = (k: string) => k === INBOX || k === ARCHIVE || k === TRASH;

// A container member: a RowItem (project rows / inbox todos) or an
// ArchiveTodoEntry (archive/trash todos). Both carry `id`.
type Member = RowItem | ArchiveTodoEntry;
// container key → ordered member objects on one side (a shallow-copied array,
// so later splices on the live array don't mutate the snapshot).
type Snapshot = Record<string, Member[]>;

type MoveHistoryEntry = { before: Snapshot; after: Snapshot };

const MAX_HISTORY = 50;

const undoStack: MoveHistoryEntry[] = $state([]);
const redoStack: MoveHistoryEntry[] = $state([]);

// Visual cue for invoking undo/redo with nothing left to apply ("end of
// history"). `seq` bumps on every trigger so the UI re-flashes on repeated
// presses; `kind` names the exhausted direction.
export const undoCue = $state<{ kind: "undo" | "redo" | null; seq: number }>({
  kind: null,
  seq: 0,
});

const flashCue = (kind: "undo" | "redo") => {
  undoCue.kind = kind;
  undoCue.seq++;
};

const idsOf = (members: Member[] | undefined) => (members ?? []).map((m) => m.id);

// Capture the current contents of each container. archive/trash contribute only
// their todo entries — projects live there too but never take part in a row
// move (project moves clear the history).
export const snapshot = (state: AppState, keys: string[]): Snapshot => {
  const snap: Snapshot = {};
  for (const key of keys) {
    if (isProjKey(key)) {
      const project = projOf(state, projIdOf(key));
      snap[key] = project ? [...project.rows] : [];
    } else if (key === INBOX) {
      snap[key] = [...state.inbox];
    } else {
      const list = key === ARCHIVE ? state.archive : state.trash;
      snap[key] = list.filter((e): e is ArchiveTodoEntry => e.kind === "todo");
    }
  }
  return snap;
};

const snapshotsEqual = (a: Snapshot, b: Snapshot): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ai = idsOf(a[k]);
    const bi = idsOf(b[k]);
    if (ai.length !== bi.length || ai.some((id, i) => id !== bi[i])) return false;
  }
  return true;
};

// A user gesture that mixes a recordable todo move with an interrupting
// mutation (e.g. restoring a mixed trash selection = interrupting project
// restore + recordable todo move) must leave NO history entry — a surviving
// half-entry would let undo revert the todos while the projects stay put. The
// two mutators run in one synchronous batch but in call-site order, so an
// interrupt also suppresses recording for the remainder of the current
// microtask rather than relying on which ran first.
let suppressRecording = false;

// `before`/`after` snapshot the SAME container keys (the mutator captures both
// from one key set), so applying either side describes the full intended state
// of every container the move touched.
export const recordMove = (before: Snapshot, after: Snapshot) => {
  if (suppressRecording) return;
  // A drop back into place moves nothing — don't pollute the history.
  if (snapshotsEqual(before, after)) return;
  undoStack.push({ before, after });
  redoStack.length = 0;
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
};

export const clearMoveHistory = () => {
  undoStack.length = 0;
  redoStack.length = 0;
  if (!suppressRecording) {
    suppressRecording = true;
    queueMicrotask(() => (suppressRecording = false));
  }
};

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

// A row leaving a project must not linger in the selection/expansion of panels
// showing it — mirrors the forward mutators.
const clearPanelRowState = (state: AppState, projId: string, ids: Set<string>) => {
  state.panels.forEach(({ instance }) => {
    if (!isProjectInstance(instance) || instance.project.id !== projId) return;
    for (const id of ids) {
      delete instance.rowSelected[id];
      delete instance.todoExpanded[id];
    }
  });
};

// Bring the app state to the `target` side. `source` is the side we're leaving
// (== live state under LIFO undo/redo); it distinguishes rows arriving from a
// recency container (whose queued placement moves must be superseded) from
// rows shuffled within/between projects. Returns false if a referenced project
// vanished (defensive — the interrupt policy should prevent it).
const applyEntry = (state: AppState, target: Snapshot, source: Snapshot): boolean => {
  const keys = Object.keys(target);
  for (const key of keys) {
    if (isProjKey(key) && projOf(state, projIdOf(key)) == null) return false;
  }

  // Ids present in some recency container on the source side — a row arriving
  // into a project from one of these is a placement→project move; one arriving
  // from another project is not (matches useMoveRow, which the server resolves
  // from both projects' orders in the same push).
  const recencySourceIds = new Set<string>();
  for (const key of keys) {
    if (isRecencyKey(key)) for (const m of source[key] ?? []) recencySourceIds.add(m.id);
  }

  // Ids present anywhere on each side. A row in a target project that's in NO
  // source container is being restored from a hard delete (undoing a grouping
  // delete); one in a source project that's in NO target container is being
  // hard-deleted (the redo direction). See "Hard-deleted groupings" above.
  const sourceAllIds = new Set<string>();
  const targetAllIds = new Set<string>();
  for (const key of keys) {
    for (const m of source[key] ?? []) sourceAllIds.add(m.id);
    for (const m of target[key] ?? []) targetAllIds.add(m.id);
  }

  // 1. Positional containers: rebuild rows to the exact target order (the
  //    retained objects already carry the right representation), clearing panel
  //    state for rows that left.
  for (const key of keys) {
    if (!isProjKey(key)) continue;
    const project = projOf(state, projIdOf(key))!;
    const targetRows = target[key] as RowItem[];
    const targetIds = new Set(targetRows.map((r) => r.id));
    const leaving = new Set(idsOf(source[key]).filter((id) => !targetIds.has(id)));
    if (leaving.size > 0) clearPanelRowState(state, project.id, leaving);
    project.rows = [...targetRows];
  }

  // 2. Recency containers: reconcile membership. Drop todos not in target, keep
  //    the rest in place, and prepend (top) the ones entering. Untouched proj
  //    entries in archive/trash are preserved.
  for (const key of keys) {
    if (!isRecencyKey(key)) continue;
    const targetIds = new Set(idsOf(target[key]));
    if (key === INBOX) {
      const retained = state.inbox.filter((t) => targetIds.has(t.id));
      const present = new Set(retained.map((t) => t.id));
      const entering = (target[key] as TodoItem[]).filter((t) => !present.has(t.id));
      state.inbox = [...entering, ...retained];
      for (const t of entering) {
        recordPlacementMove({ kind: "todo", todoId: t.id, placement: "inbox" });
      }
    } else {
      const list: ArchiveEntry[] = key === ARCHIVE ? state.archive : state.trash;
      const kept = list.filter((e) => e.kind === "proj" || targetIds.has(e.id));
      const present = new Set(kept.filter((e) => e.kind === "todo").map((e) => e.id));
      const entering = (target[key] as ArchiveTodoEntry[]).filter((e) => !present.has(e.id));
      const next = [...entering, ...kept];
      if (key === ARCHIVE) state.archive = next;
      else state.trash = next;
      for (const e of entering) {
        recordPlacementMove({
          kind: "todo",
          todoId: e.id,
          placement: key,
          ...(e.projId != null && { associateProjId: e.projId }),
        });
      }
    }
  }

  // 3. Sync each project's new order. A row pulled back into a project
  //    supersedes any still-queued placement move for it: the server applies
  //    placement arranges AFTER row orders, so if the forward move hadn't
  //    dispatched yet (a push in flight when it was recorded), leaving it
  //    queued would land both in one push and the stale arrange would win. If
  //    the superseded move was also the op that would have CREATEd the todo
  //    server-side (a todo born in a placement this same batch), flag the row
  //    createHere so the row order inserts it instead — its field edits are
  //    still queued and apply in the same push (todoUpdates run after
  //    projUpdates).
  for (const key of keys) {
    if (!isProjKey(key)) continue;
    const entry = state.projs[projIdOf(key)]!;
    const project = entry.project;
    const sourceIds = new Set(idsOf(source[key]));
    const arriving = new Set(
      project.rows.flatMap(({ id }) =>
        !sourceIds.has(id) && recencySourceIds.has(id) ? [id] : [],
      ),
    );
    const superseded = supersedePlacementMoves(arriving);
    // Restored-from-delete rows: createHere so the row-order push re-INSERTs
    // them server-side, with the label re-recorded as the INSERT's field data
    // (it rides the same push). Only groupings can be in this state.
    const restored = new Set<string>();
    for (const r of project.rows) {
      if (sourceAllIds.has(r.id) || !isGroupingItem(r)) continue;
      restored.add(r.id);
      recordGroupEdit(r.id, project.id, { label: r.label });
    }
    // Rows leaving this project for no container at all: hard-delete again.
    for (const m of source[key] ?? []) {
      if (!targetAllIds.has(m.id) && isGroupingItem(m as RowItem)) {
        recordRowDelete(project.id, m.id, "group");
      }
    }
    if (!entry.loaded) {
      // The rows of a stub project were never loaded, so its local rows are
      // not the full server list and a full-order push would collide with
      // rows this client hasn't seen. Push the rows as an arrive slice
      // instead (undoing/redoing a move onto a stub only ever leaves arrived
      // rows here); rows that LEFT the stub on this step exit server-side via
      // the placement arranges recorded above.
      recordRowArrive(
        project.id,
        project.rows.map((r) => ({
          rowId: r.id,
          kind: (isGroupingItem(r) ? "group" : "todo") as "todo" | "group",
          ...((superseded.has(r.id) || restored.has(r.id)) && { createHere: true }),
        })),
      );
    } else {
      recordRowOrder(
        project.id,
        project.rows.map((r, i) => ({
          rowId: r.id,
          kind: (isGroupingItem(r) ? "group" : "todo") as "todo" | "group",
          startAtIndex: i,
          ...((superseded.has(r.id) || restored.has(r.id)) && { createHere: true }),
        })),
      );
    }
  }
  return true;
};

const step = (state: AppState, direction: "undo" | "redo"): boolean => {
  const [from, to] = direction === "undo" ? [undoStack, redoStack] : [redoStack, undoStack];
  const entry = from.at(-1);
  if (entry == null) {
    flashCue(direction);
    return false;
  }
  const [target, source] =
    direction === "undo" ? [entry.before, entry.after] : [entry.after, entry.before];
  if (!applyEntry(state, target, source)) {
    clearMoveHistory();
    flashCue(direction);
    return false;
  }
  from.pop();
  to.push(entry);
  return true;
};

export const undoMove = (state: AppState): boolean => step(state, "undo");
export const redoMove = (state: AppState): boolean => step(state, "redo");
