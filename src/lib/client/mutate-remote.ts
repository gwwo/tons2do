import {
  isTodoItem,
  isProjectInstance,
  isPlacementInstance,
  newProjectInstance,
  newPlacementInstance,
  newProjectItem,
  newTodoItem,
  newGroupingItem,
  newCheckItem,
  type TodoItem,
  type CheckInitData,
  type TodoInitData,
  type GroupingItem,
  type GroupingInitData,
  type TodoStatus,
  type ProjectInitData,
  isGroupingItem,
  type CheckItem,
  type AppState,
  type ArchiveTodoEntry,
  type PlacementName,
  projOf,
  drilledFrom,
} from "$lib/client/model";
import { createMutator, getPanelContext, getProjContext, getTodoContext } from "./context";
import {
  collectMoving,
  getInsertIndex,
  getProjectInstance,
  getTodo,
  insert,
  normalizeIds,
  pruneDrillIns,
  sameIdOrder,
} from "./utils";
import {
  recordTodoEdit,
  recordGroupEdit,
  recordProjEdit,
  recordCheckEdit,
  recordRowOrder,
  recordRowArrive,
  recordCheckOrder,
  recordPlacementCheckOrder,
  recordProjListOrder,
  recordRowDelete,
  recordPlacementMove,
  recordProjCreate,
  recordProjDelete,
  recordTodoDelete,
  rowOrderOf,
  rowArriveOf,
  formatPlanned,
  parsePlanned,
} from "./sync.svelte";
import { signedIn } from "./session.svelte";
import {
  clearMoveHistory,
  recordChecks,
  recordMove,
  snapshot,
  projKey,
  INBOX,
  ARCHIVE,
  TRASH,
} from "./undo.svelte";
import type { CalendarDate } from "@internationalized/date";

// The undo policy (see undo.svelte.ts): ONE history holds an uninterrupted
// run of moves from a single domain, and recording into the other domain
// resets it. The rows-recording family — useMoveRow,
// useMoveFromPlacementToProject, useMoveToPlacementFrom, useMoveToInbox,
// useArchiveTodo, useTrashOrDeleteRows, useMovePlacementToPlacement —
// snapshots the affected containers before/after and calls recordMove.
// useTrashOrDeleteRows also records grouping HARD deletes: the deleted
// grouping survives only in the entry's `before` snapshot, and undo re-creates
// it server-side via a createHere row-order push (see applyEntry in
// undo.svelte.ts). The checks-recording family — useMoveCheck, useDeleteCheck,
// useMovePlacementCheck, useDeletePlacementCheck — snapshots one todo's
// checklist before/after and calls recordChecks (deleted checks survive only
// on the `before` side; undo re-creates them via the createHere check-order
// push, see applyCheckEntry) — except that a delete removing only EMPTY
// checks interrupts instead (the Backspace-on-emptied-check typing flow; see
// useDeleteCheck). Every other data mutator below interrupts —
// clears — the history (field edits, creates — check creates/edits included —
// todo/project deletes, and every PROJECT move). Rows entries record the same
// container keys on both sides: projKey(id) for a project's rows,
// INBOX/ARCHIVE/TRASH for the placements.
const createInterruptingMutator = <Ctx, Args extends unknown[], R>(
  getCtx: () => Ctx,
  fn: (state: AppState, ctx: Ctx, ...args: Args) => R,
) =>
  createMutator(getCtx, (state: AppState, ctx: Ctx, ...args: Args) => {
    clearMoveHistory();
    return fn(state, ctx, ...args);
  });

// ─── Row moves / reorders ─────────────────────────────────────────────────────

export const useMoveRow = createMutator(
  () => getProjContext("useMoveRow: no project context"),
  (state, ctx, fromProjId: string, rowIds: string[], index?: number) => {
    if (rowIds.length === 0) return;
    const toEntry = state.projs[ctx.projId];
    const fromProject = projOf(state, fromProjId);
    if (toEntry == null || fromProject == null) return;
    const toProject = toEntry.project;
    const { movingIds, moving } = collectMoving(fromProject.rows, rowIds);
    if (moving.length === 0) return;
    const nextTo = toProject.rows.filter(({ id }) => !movingIds.has(id));
    // Default landing spot: before the first grouping (else at the end). For
    // an unloaded (stub) target the local rows are just its earlier arrivals,
    // so the same rule mirrors the server-side arrive anchor.
    const insertAt =
      index ??
      (() => {
        const i = nextTo.findIndex((row) => isGroupingItem(row));
        return i >= 0 ? i : nextTo.length;
      })();
    insert(nextTo, insertAt, moving);
    // A same-project drop back into place moves nothing — no sync push, no
    // history entry. (A cross-project move always changes both containers.)
    if (toProject.id === fromProject.id && sameIdOrder(toProject.rows, nextTo)) return;
    const keys = [...new Set([projKey(fromProject.id), projKey(toProject.id)])];
    const before = snapshot(state, keys);
    fromProject.rows = fromProject.rows.filter(({ id }) => !movingIds.has(id));
    toProject.rows = nextTo;
    if (toProject.id !== fromProject.id) {
      state.panels.forEach(({ instance }) => {
        if (!isProjectInstance(instance)) return;
        if (instance.project.id !== fromProject.id) return;
        for (const rowId of movingIds) {
          delete instance.rowSelected[rowId];
        }
      });
      if (toEntry.loaded) recordRowOrder(toProject.id, rowOrderOf(toProject));
      else recordRowArrive(toProject.id, rowArriveOf(toProject));
      recordRowOrder(fromProject.id, rowOrderOf(fromProject));
    } else {
      recordRowOrder(toProject.id, rowOrderOf(toProject));
    }
    recordMove(before, snapshot(state, keys));
  },
);

export const useMoveFromPlacementToProject = createMutator(
  () => getProjContext("useMoveFromPlacementToProject: no project context"),
  (state, ctx, todoIds: string[], index: number) => {
    if (todoIds.length === 0) return;
    const toEntry = state.projs[ctx.projId];
    if (toEntry == null) return;
    const toProject = toEntry.project;

    const idSet = new Set(todoIds);
    // Snapshot only the placements that actually hold a moving todo (plus the
    // target project), so unrelated placements aren't dragged into history.
    const srcKeys = [
      state.inbox.some((t) => idSet.has(t.id)) && INBOX,
      state.archive.some((e) => e.kind === "todo" && idSet.has(e.id)) && ARCHIVE,
      state.trash.some((e) => e.kind === "todo" && idSet.has(e.id)) && TRASH,
    ].filter((k): k is string => k !== false);
    const keys = [...srcKeys, projKey(toProject.id)];
    const before = snapshot(state, keys);

    const moving: TodoItem[] = [];

    for (const t of state.inbox) {
      if (idSet.has(t.id)) moving.push({ ...t });
    }
    state.inbox = state.inbox.filter((t) => !idSet.has(t.id));

    for (const e of state.archive) {
      if (idSet.has(e.id) && e.kind === "todo")
        moving.push({
          id: e.id,
          title: e.title,
          note: e.note,
          status: e.done ? "complete" : "todo",
          planned: parsePlanned(e.planned),
          checks: e.checks,
        });
    }
    state.archive = state.archive.filter((e) => !idSet.has(e.id) || e.kind !== "todo");

    for (const e of state.trash) {
      if (idSet.has(e.id) && e.kind === "todo")
        moving.push({
          id: e.id,
          title: e.title,
          note: e.note,
          status: e.done ? "complete" : "todo",
          planned: parsePlanned(e.planned),
          checks: e.checks,
        });
    }
    state.trash = state.trash.filter((e) => !idSet.has(e.id) || e.kind !== "todo");

    if (moving.length === 0) return;
    toProject.rows = toProject.rows.filter(({ id }) => !idSet.has(id));
    // For an unloaded (stub) target the caller computed `index` against the
    // stub's local rows (its earlier arrivals), mirroring the server-side
    // arrive anchor — insert the same way in both cases.
    insert(toProject.rows, index, moving);

    if (toEntry.loaded) recordRowOrder(ctx.projId, rowOrderOf(toProject));
    else recordRowArrive(ctx.projId, rowArriveOf(toProject));
    recordMove(before, snapshot(state, keys));
  },
);

export const useMoveCheck = createMutator(
  () => ({
    ...getProjContext("useMoveCheck: no project context"),
    ...getTodoContext("useMoveCheck: no todo context"),
  }),
  (state, ctx, checkIds: string[], index: number) => {
    if (checkIds.length === 0) return;
    const todo = getTodo(state, ctx);
    if (todo == null) return;
    const { movingIds, moving } = collectMoving(todo.checks, checkIds);
    if (moving.length === 0) return;
    const before = [...todo.checks];
    const next = todo.checks.filter(({ id }) => !movingIds.has(id));
    insert(next, index, moving);
    if (sameIdOrder(before, next)) return;
    todo.checks = next;
    recordCheckOrder(
      ctx.projId,
      todo.id,
      todo.checks.map((c, i) => ({ checkId: c.id, startAtIndex: i })),
    );
    recordChecks({ scope: "project", projId: ctx.projId, todoId: todo.id }, before, [
      ...todo.checks,
    ]);
  },
);

// Not createInterruptingMutator: the wrapper would clear the undo history
// before the body can detect a drop back into place. A real reorder still
// interrupts (project moves are outside the rows/checks undo domains); a no-op
// drop does nothing at all — no sync push, no history interrupt.
export const useMoveProject = createMutator(
  () => null,
  (state, _, projIds: string[], index: number) => {
    if (projIds.length === 0) return;
    const inOrder = new Set(state.projOrder);
    const moving = projIds.filter((id) => inOrder.has(id));
    if (moving.length === 0) return;
    const movingSet = new Set(moving);
    const next = state.projOrder.filter((id) => !movingSet.has(id));
    insert(next, index, moving);
    if (next.length === state.projOrder.length && next.every((id, i) => id === state.projOrder[i]))
      return;
    clearMoveHistory();
    state.projOrder = next;
    recordProjListOrder([...state.projOrder]);
  },
);

// Restore archived/trashed projects back into the active list at `index`
// (an active-list / projOrder index). Each project's entry just flips to
// placement "list": a drilled-in entry keeps its identity and rows, a signed-
// out entry has carried its rows the whole time, and a project the client
// hasn't opened gets a name-only entry the lazy loader fills. Pushing the new
// list order flips the projects to placement="list" server-side too
// (applyProjsArrange).
export const useRestoreProjects = createInterruptingMutator(
  () => null,
  (state, _, projIds: string[], index: number) => {
    if (projIds.length === 0) return;
    const idSet = new Set(projIds);
    const nameById = new Map<string, string>();
    for (const e of [...state.archive, ...state.trash]) {
      if (e.kind === "proj" && idSet.has(e.id)) nameById.set(e.id, e.name);
    }
    // Only restore ids actually in a placement list, in dragged order.
    const restoring = projIds.filter((id) => nameById.has(id));
    if (restoring.length === 0) return;

    state.archive = state.archive.filter((e) => !(e.kind === "proj" && idSet.has(e.id)));
    state.trash = state.trash.filter((e) => !(e.kind === "proj" && idSet.has(e.id)));

    for (const id of restoring) {
      const entry = state.projs[id];
      if (entry) entry.placement = "list";
      else {
        state.projs[id] = {
          project: { ...newProjectItem({ name: nameById.get(id)! }), id },
          placement: "list",
          loaded: !signedIn(),
        };
      }
    }
    const restoringSet = new Set(restoring);
    state.projOrder = state.projOrder.filter((id) => !restoringSet.has(id));
    insert(state.projOrder, index, restoring);

    recordProjListOrder([...state.projOrder]);
  },
);

// ─── Todo edits ───────────────────────────────────────────────────────────────

// The delta fields recordTodoEdit expects, from a partial TodoItem edit.
const todoDeltaFields = (data: Partial<Omit<TodoItem, "checks" | "id">>) => ({
  ...(data.title !== undefined && { title: data.title }),
  ...(data.note !== undefined && { note: data.note }),
  ...(data.status !== undefined && { done: data.status === "complete" }),
  ...(data.planned !== undefined && { planned: formatPlanned(data.planned) }),
});

export const useEditTodo = createInterruptingMutator(
  () => ({
    ...getProjContext("useEditTodo: no project context"),
    ...getTodoContext("useEditTodo: no todo context"),
  }),
  (state, ctx, data: Partial<Omit<TodoItem, "checks" | "id">>) => {
    const todo = getTodo(state, ctx);
    if (todo == null) return;
    Object.assign(
      todo,
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    );
    recordTodoEdit(todo.id, ctx.projId, "project", todoDeltaFields(data));
  },
);

// ─── Placement todo / check edits (inbox / archive / trash) ──────────────────
// One mutator family parameterized by placement, instead of a copy per
// placement. The placements store todos in two shapes — the inbox holds
// TodoItem rows, archive/trash hold ArchiveTodoEntry rows — so access goes
// through this uniform ref instead of leaking the difference into each hook.

type PlacementTodoRef = {
  projId: string | null;
  // Returns the live checks array.
  checks: () => CheckItem[];
  setChecks: (next: CheckItem[]) => void;
  applyEdit: (data: Partial<Omit<TodoItem, "checks" | "id">>) => void;
};

const findPlacementTodo = (
  state: AppState,
  placement: PlacementName,
  todoId: string,
): PlacementTodoRef | null => {
  if (placement === "inbox") {
    const todo = state.inbox.find((t) => t.id === todoId);
    if (todo == null) return null;
    return {
      projId: null,
      checks: () => todo.checks,
      setChecks: (next) => (todo.checks = next),
      applyEdit: (data) =>
        Object.assign(
          todo,
          Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
        ),
    };
  }
  const entry = state[placement].find(
    (e): e is ArchiveTodoEntry => e.kind === "todo" && e.id === todoId,
  );
  if (entry == null) return null;
  return {
    projId: entry.projId,
    checks: () => entry.checks,
    setChecks: (next) => (entry.checks = next),
    applyEdit: (data) => {
      if (data.title !== undefined) entry.title = data.title;
      if (data.note !== undefined) entry.note = data.note;
      if (data.status !== undefined) entry.done = data.status === "complete";
      if (data.planned !== undefined)
        entry.planned = data.planned ? formatPlanned(data.planned) : null;
    },
  };
};

export const useEditPlacementTodo = createInterruptingMutator(
  () => ({}),
  (
    state,
    _ctx,
    placement: PlacementName,
    todoId: string,
    data: Partial<Omit<TodoItem, "checks" | "id">>,
  ) => {
    const ref = findPlacementTodo(state, placement, todoId);
    if (ref == null) return;
    ref.applyEdit(data);
    recordTodoEdit(todoId, ref.projId, placement, todoDeltaFields(data));
  },
);

// Batch-mark placement todos done/undone (context-menu toggle action).
export const useMarkPlacementTodo = createInterruptingMutator(
  () => ({}),
  (state, _ctx, placement: PlacementName, todoIds: Set<string>, status: TodoStatus) => {
    for (const id of todoIds) {
      const ref = findPlacementTodo(state, placement, id);
      if (ref == null) continue;
      ref.applyEdit({ status });
      recordTodoEdit(id, ref.projId, placement, { done: status === "complete" });
    }
  },
);

// Set/clear the planned date on placement todos (bottom-bar date picker).
export const useSetPlannedPlacement = createInterruptingMutator(
  () => ({}),
  (state, _ctx, placement: PlacementName, todoIds: Set<string>, planned: CalendarDate | null) => {
    for (const id of todoIds) {
      const ref = findPlacementTodo(state, placement, id);
      if (ref == null) continue;
      ref.applyEdit({ planned });
      recordTodoEdit(id, ref.projId, placement, { planned: formatPlanned(planned) });
    }
  },
);

export const useEditPlacementCheck = createInterruptingMutator(
  () => ({}),
  (
    state,
    _ctx,
    placement: PlacementName,
    todoId: string,
    checkId: string,
    data: Partial<Omit<CheckItem, "id">>,
  ) => {
    const ref = findPlacementTodo(state, placement, todoId);
    const check = ref?.checks().find((c) => c.id === checkId);
    if (check == null) return;
    if (data.text !== undefined) check.text = data.text;
    if (data.ticked !== undefined) check.ticked = data.ticked;
    recordCheckEdit(checkId, todoId, null, placement, {
      ...(data.text !== undefined && { content: data.text }),
      ...(data.ticked !== undefined && { ticked: data.ticked }),
    });
  },
);

export const useMovePlacementCheck = createMutator(
  () => ({}),
  (state, _ctx, placement: PlacementName, todoId: string, checkIds: string[], index: number) => {
    const ref = findPlacementTodo(state, placement, todoId);
    if (ref == null) return;
    const checks = ref.checks();
    const { movingIds, moving } = collectMoving(checks, checkIds);
    if (moving.length === 0) return;
    const before = [...checks];
    const next = checks.filter(({ id }) => !movingIds.has(id));
    insert(next, index, moving);
    if (sameIdOrder(before, next)) return;
    ref.setChecks(next);
    recordPlacementCheckOrder(
      todoId,
      next.map((c, i) => ({ checkId: c.id, startAtIndex: i })),
    );
    recordChecks({ scope: "placement", placement, todoId }, before, [...next]);
  },
);

export const useCreatePlacementCheck = createInterruptingMutator(
  () => ({}),
  (
    state,
    _ctx,
    placement: PlacementName,
    todoId: string,
    items: CheckInitData[],
    index: number,
  ) => {
    const ref = findPlacementTodo(state, placement, todoId);
    if (ref == null || items.length === 0) return;
    const created = items.map((item) => newCheckItem(item));
    const checks = ref.checks();
    insert(checks, index, created);
    for (const c of created) {
      recordCheckEdit(c.id, todoId, null, placement, { content: c.text, ticked: c.ticked });
    }
    recordPlacementCheckOrder(
      todoId,
      checks.map((c, i) => ({
        checkId: c.id,
        startAtIndex: i,
        createHere: created.some((nc) => nc.id === c.id),
      })),
    );
  },
);

export const useDeletePlacementCheck = createMutator(
  () => ({}),
  (state, _ctx, placement: PlacementName, todoId: string, checkId: string | Set<string>) => {
    const ref = findPlacementTodo(state, placement, todoId);
    if (ref == null) return;
    const ids = normalizeIds(checkId);
    const before = [...ref.checks()];
    const deleted = before.filter(({ id }) => ids.has(id));
    if (deleted.length === 0) return;
    const next = before.filter(({ id }) => !ids.has(id));
    ref.setChecks(next);
    recordPlacementCheckOrder(
      todoId,
      next.map((c, i) => ({ checkId: c.id, startAtIndex: i })),
    );
    // Same empty-delete rule as useDeleteCheck: all-empty deletes interrupt.
    if (deleted.every((c) => c.text === "")) clearMoveHistory();
    else recordChecks({ scope: "placement", placement, todoId }, before, [...next]);
  },
);

// Create a brand-new todo directly in the inbox (Space in the inbox view).
// Mirrors useCreateTodo, but the new row lives in state.inbox (placement
// "inbox", no project) and the new-todo selection/expansion is tracked on the
// placement instance rather than a project instance.
export const useCreateInboxTodo = createInterruptingMutator(
  () => getPanelContext("useCreateInboxTodo: no panel context"),
  (state, ctx, item?: TodoInitData) => {
    const todo = newTodoItem(item);
    state.inbox.unshift(todo);
    const panel = state.panels.find(({ id }) => id === ctx.panelId);
    if (panel != null && isPlacementInstance(panel.instance) && panel.instance.kind === "inbox") {
      panel.instance.selected = new Set([todo.id]);
      panel.instance.expandedId = todo.id;
    }
    recordTodoEdit(todo.id, null, "inbox", {
      title: todo.title,
      note: todo.note,
      done: todo.status === "complete",
      planned: formatPlanned(todo.planned),
    });
    recordPlacementMove({ kind: "todo", todoId: todo.id, placement: "inbox" });
    return { id: todo.id };
  },
);

// Permanently delete trash entries (todos + projects). Drives both "empty
// trash" (all entries) and "permanently delete" (selected entries). The server
// hard-deletes by id regardless of placement and cascades a project's rows.
export const usePurgeTrash = createInterruptingMutator(
  () => ({}),
  (state, _ctx, ids: Set<string>) => {
    if (ids.size === 0) return;
    const removed = state.trash.filter((e) => ids.has(e.id));
    if (removed.length === 0) return;
    state.trash = state.trash.filter((e) => !ids.has(e.id));
    const purgedProjIds = new Set<string>();
    for (const e of removed) {
      if (e.kind === "todo") recordTodoDelete(e.id, null);
      else {
        recordProjDelete(e.id);
        purgedProjIds.add(e.id);
        delete state.projs[e.id];
      }
    }
    // A purged project may be open (drilled into) in some panel — return that
    // panel to the trash view rather than leaving it on a deleted project.
    if (purgedProjIds.size === 0) return;
    for (const panel of state.panels) {
      if (isProjectInstance(panel.instance) && purgedProjIds.has(panel.instance.project.id)) {
        panel.instance = newPlacementInstance("trash");
      }
    }
  },
);

// ─── Check edits ──────────────────────────────────────────────────────────────

export const useCreateCheck = createInterruptingMutator(
  () => ({
    ...getProjContext("useCreateCheck: no project context"),
    ...getTodoContext("useCreateCheck: no todo context"),
  }),
  async (state, ctx, items: CheckInitData[], index: number) => {
    const todo = getTodo(state, ctx);
    if (todo == null || items.length === 0) return;
    const checks = items.map((item) => newCheckItem(item));
    insert(todo.checks, index, checks);
    for (const c of checks) {
      recordCheckEdit(c.id, todo.id, ctx.projId, "project", {
        content: c.text,
        ticked: c.ticked,
      });
    }
    recordCheckOrder(
      ctx.projId,
      todo.id,
      todo.checks.map((c, i) => ({
        checkId: c.id,
        startAtIndex: i,
        createHere: checks.some((nc) => nc.id === c.id),
      })),
    );
  },
);

export const useEditCheck = createInterruptingMutator(
  () => ({
    ...getProjContext("useEditCheck: no project context"),
    ...getTodoContext("useEditCheck: no todo context"),
  }),
  (state, ctx, checkId: string, data: Partial<Omit<CheckItem, "id">>) => {
    const todo = getTodo(state, ctx);
    if (todo == null) return;
    const check = todo.checks.find(({ id }) => id === checkId);
    if (check == null) return;
    Object.assign(
      check,
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    );
    recordCheckEdit(checkId, todo.id, ctx.projId, "project", {
      ...(data.text !== undefined && { content: data.text }),
      ...(data.ticked !== undefined && { ticked: data.ticked }),
    });
  },
);

export const useDeleteCheck = createMutator(
  () => ({
    ...getProjContext("useDeleteCheck: no project context"),
    ...getTodoContext("useDeleteCheck: no todo context"),
  }),
  (state, ctx, checkIds: string | Set<string>) => {
    const todo = getTodo(state, ctx);
    if (todo == null) return;
    const ids = normalizeIds(checkIds);
    const before = [...todo.checks];
    const deleted = before.filter(({ id }) => ids.has(id));
    if (deleted.length === 0) return;
    todo.checks = todo.checks.filter(({ id }) => !ids.has(id));
    // Deletion is expressed through the check order: orderChecks is the
    // complete desired list, and the server deletes any check absent from it.
    recordCheckOrder(
      ctx.projId,
      todo.id,
      todo.checks.map((c, i) => ({ checkId: c.id, startAtIndex: i })),
    );
    // A delete of only EMPTY checks interrupts instead of recording: it's the
    // tail of a typing flow (Backspace on an emptied check), the snapshot
    // could only restore a blank row, and recording it would make the
    // in-checklist Cmd/Ctrl+Z exception shadow native text undo right after
    // the user erased the text. Deletes that remove any content record.
    if (deleted.every((c) => c.text === "")) clearMoveHistory();
    else
      recordChecks({ scope: "project", projId: ctx.projId, todoId: todo.id }, before, [
        ...todo.checks,
      ]);
  },
);

// ─── Todo creates / deletes ───────────────────────────────────────────────────

export const useCreateTodo = createInterruptingMutator(
  () => ({
    ...getPanelContext("useCreateTodo: no panel context"),
    ...getProjContext("useCreateTodo: no project context"),
  }),
  async (state, ctx, item?: TodoInitData) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    const insertAt = getInsertIndex(instance);
    const todo = newTodoItem(item);
    insert(instance.project.rows, insertAt, todo);
    instance.rowSelected = { [todo.id]: true };
    instance.todoExpanded = { [todo.id]: true };
    // Record both the field data and the new row order.
    recordTodoEdit(todo.id, ctx.projId, "project", {
      title: todo.title,
      note: todo.note,
      done: todo.status === "complete",
      planned: formatPlanned(todo.planned),
    });
    const newOrder = rowOrderOf(instance.project).map((e) => ({
      ...e,
      ...(e.rowId === todo.id && { createHere: true }),
    }));
    recordRowOrder(ctx.projId, newOrder);
    return { id: todo.id };
  },
);

export const useCreateGrouping = createInterruptingMutator(
  () => ({
    ...getPanelContext("useCreateGrouping: no panel context"),
    ...getProjContext("useCreateGrouping: no project context"),
  }),
  async (state, ctx, item?: GroupingInitData) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    const insertAt = getInsertIndex(instance);
    const grouping = newGroupingItem(item);
    insert(instance.project.rows, insertAt, grouping);
    instance.rowSelected = { [grouping.id]: true };
    recordGroupEdit(grouping.id, ctx.projId, { label: grouping.label });
    const newOrder = rowOrderOf(instance.project).map((e) => ({
      ...e,
      ...(e.rowId === grouping.id && { createHere: true }),
    }));
    recordRowOrder(ctx.projId, newOrder);
    return { id: grouping.id };
  },
);

export const useEditGrouping = createInterruptingMutator(
  () => getProjContext("useEditGrouping: no project context"),
  (state, ctx, groupingId: string, data: Partial<Omit<GroupingItem, "id">>) => {
    const project = projOf(state, ctx.projId);
    if (project == null) return;
    const row = project.rows.find(({ id }) => id === groupingId);
    if (row == null || !isGroupingItem(row)) return;
    Object.assign(
      row,
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    );
    if (data.label !== undefined) {
      recordGroupEdit(groupingId, ctx.projId, { label: data.label });
    }
  },
);

export const useMarkTodo = createInterruptingMutator(
  () => getProjContext("useMarkTodo: no project context"),
  (state, ctx, todoIds: Set<string>, status: TodoStatus) => {
    const project = projOf(state, ctx.projId);
    if (project == null) return;
    project.rows.forEach((row) => {
      if (isTodoItem(row) && todoIds.has(row.id)) {
        row.status = status;
        recordTodoEdit(row.id, ctx.projId, "project", { done: status === "complete" });
      }
    });
  },
);

export const useSetPlanned = createInterruptingMutator(
  () => getProjContext("useSetPlanned: no project context"),
  (state, ctx, todoIds: Set<string>, planned: CalendarDate | null) => {
    const project = projOf(state, ctx.projId);
    if (project == null) return;
    project.rows.forEach((row) => {
      if (isTodoItem(row) && todoIds.has(row.id)) {
        row.planned = planned;
        recordTodoEdit(row.id, ctx.projId, "project", { planned: formatPlanned(planned) });
      }
    });
  },
);

// ─── Project creates / edits / deletes ────────────────────────────────────────

export const useCreateProject = createInterruptingMutator(
  () => getPanelContext("useCreateProject: no panel context"),
  (state, ctx, index: number, item?: ProjectInitData) => {
    const project = newProjectItem(item);
    state.projs[project.id] = { project, placement: "list", loaded: true };
    insert(state.projOrder, index, project.id);
    const panel = state.panels.find(({ id }) => id === ctx.panelId);
    if (panel != null) {
      // Point the panel at the reactive instance registered in state.
      panel.instance = newProjectInstance({ project: state.projs[project.id].project });
    }
    recordProjCreate(project.id);
    recordProjEdit(project.id, { name: project.name, note: project.note });
    recordProjListOrder([...state.projOrder]);
    return { id: project.id };
  },
);

export const useEditProject = createInterruptingMutator(
  () => getProjContext("useEditProject: no project context"),
  (state, ctx, data: Partial<Omit<ProjectInitData, "rows" | "id">>) => {
    const project = projOf(state, ctx.projId);
    if (project == null) return;
    Object.assign(
      project,
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    );
    recordProjEdit(ctx.projId, {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.note !== undefined && { note: data.note }),
    });
    // A project opened from a placement view (archive/trash) also has a row in
    // that placement; keep its name in sync so the list reflects the edit.
    const openFrom = drilledFrom(state, ctx.projId);
    if (data.name !== undefined && openFrom != null) {
      const entry = state[openFrom].find((e) => e.kind === "proj" && e.id === ctx.projId);
      if (entry?.kind === "proj") entry.name = data.name;
    }
  },
);

export const useDeleteProject = createInterruptingMutator(
  () => null,
  async (state, _, projIds: Set<string>) => {
    if (projIds.size === 0) return;
    for (const id of projIds) delete state.projs[id];
    state.projOrder = state.projOrder.filter((id) => !projIds.has(id));
    const fallback = state.projOrder.length > 0 ? projOf(state, state.projOrder[0]) : null;
    state.panels.forEach((panel) => {
      if (!isProjectInstance(panel.instance)) return;
      if (!projIds.has(panel.instance.project.id)) return;
      panel.instance = fallback
        ? newProjectInstance({ project: fallback })
        : newPlacementInstance("inbox");
    });
    for (const id of projIds) recordProjDelete(id);
  },
);

// ─── Placement operations (archive / trash / inbox) ──────────────────────────

export const useArchiveTodo = createMutator(
  () => getProjContext("useArchiveTodo: no project context"),
  (state, ctx, todoIds: Set<string>) => {
    const project = projOf(state, ctx.projId);
    if (project == null) return;
    const archived = project.rows.filter((r) => isTodoItem(r) && todoIds.has(r.id)) as TodoItem[];
    if (archived.length === 0) return;
    const keys = [projKey(project.id), ARCHIVE];
    const before = snapshot(state, keys);
    project.rows = project.rows.filter((r) => !isTodoItem(r) || !todoIds.has(r.id));
    state.panels.forEach((panel) => {
      if (!isProjectInstance(panel.instance)) return;
      if (panel.instance.project.id !== ctx.projId) return;
      for (const id of todoIds) {
        delete panel.instance.rowSelected[id];
        delete panel.instance.todoExpanded[id];
      }
    });
    for (const todo of archived) {
      recordPlacementMove({
        kind: "todo",
        todoId: todo.id,
        placement: "archive",
        associateProjId: ctx.projId,
      });
      state.archive.unshift({
        kind: "todo",
        id: todo.id,
        title: todo.title,
        note: todo.note,
        done: todo.status === "complete",
        planned: todo.planned ? formatPlanned(todo.planned) : null,
        projId: ctx.projId,
        checks: todo.checks,
      });
    }
    recordRowOrder(ctx.projId, rowOrderOf(project));
    recordMove(before, snapshot(state, keys));
  },
);

// The "delete selection" gesture (Delete key / context menu): todos move to
// trash (a recency container, restorable from the Trash view), groupings are
// HARD-deleted — they have no trash representation. One mutator so a mixed
// selection records ONE history entry: a single undo restores the todos from
// trash and the groupings from the entry's retained snapshot objects (the
// server-side re-create rides the row-order push as createHere — see
// applyEntry in undo.svelte.ts).
export const useTrashOrDeleteRows = createMutator(
  () => getProjContext("useTrashOrDeleteRows: no project context"),
  (state, ctx, rowIds: Set<string>) => {
    const project = projOf(state, ctx.projId);
    if (project == null) return;
    const trashed = project.rows.filter((r) => isTodoItem(r) && rowIds.has(r.id)) as TodoItem[];
    const deleted = project.rows.filter((r) => isGroupingItem(r) && rowIds.has(r.id));
    if (trashed.length === 0 && deleted.length === 0) return;
    const keys = trashed.length > 0 ? [projKey(project.id), TRASH] : [projKey(project.id)];
    const before = snapshot(state, keys);
    project.rows = project.rows.filter((r) => !rowIds.has(r.id));
    state.panels.forEach((panel) => {
      if (!isProjectInstance(panel.instance)) return;
      if (panel.instance.project.id !== ctx.projId) return;
      for (const id of rowIds) {
        delete panel.instance.rowSelected[id];
        delete panel.instance.todoExpanded[id];
      }
    });
    for (const todo of trashed) {
      recordPlacementMove({
        kind: "todo",
        todoId: todo.id,
        placement: "trash",
        associateProjId: ctx.projId,
      });
      state.trash.unshift({
        kind: "todo",
        id: todo.id,
        title: todo.title,
        note: todo.note,
        done: todo.status === "complete",
        planned: todo.planned ? formatPlanned(todo.planned) : null,
        projId: ctx.projId,
        checks: todo.checks,
      });
    }
    for (const g of deleted) recordRowDelete(ctx.projId, g.id, "group");
    recordRowOrder(ctx.projId, rowOrderOf(project));
    recordMove(before, snapshot(state, keys));
  },
);

// Move an active project into archive/trash: its entry just flips placement
// (leaving the active list). Signed out the entry keeps holding the rows;
// signed in the prune below drops the now-unshown entry, and reopening it
// later fetches the rows fresh from the server.
const fileProjectAway = (state: AppState, projId: string, placement: "archive" | "trash"): void => {
  const entry = state.projs[projId];
  if (!entry || entry.placement !== "list") return;
  entry.placement = placement;
  state.projOrder = state.projOrder.filter((id) => id !== projId);
  const fallback = state.projOrder.length > 0 ? projOf(state, state.projOrder[0]) : null;
  state.panels.forEach((panel) => {
    if (!isProjectInstance(panel.instance)) return;
    if (panel.instance.project.id !== projId) return;
    panel.instance = fallback
      ? newProjectInstance({ project: fallback })
      : newPlacementInstance(placement);
  });
  recordPlacementMove({ kind: "proj", projId, placement });
  state[placement].unshift({ kind: "proj", id: projId, name: entry.project.name });
  recordProjListOrder([...state.projOrder]);
  pruneDrillIns(state);
};

export const useArchiveProject = createInterruptingMutator(
  () => null,
  (state, _, projId: string) => fileProjectAway(state, projId, "archive"),
);

export const useTrashProject = createInterruptingMutator(
  () => null,
  (state, _, projId: string) => fileProjectAway(state, projId, "trash"),
);

export const useMoveToInbox = createMutator(
  () => getProjContext("useMoveToInbox: no project context"),
  (state, ctx, todoIds: Set<string>) => {
    const project = projOf(state, ctx.projId);
    if (project == null) return;
    const moved = project.rows.filter((r) => isTodoItem(r) && todoIds.has(r.id)) as TodoItem[];
    if (moved.length === 0) return;
    const keys = [projKey(project.id), INBOX];
    const before = snapshot(state, keys);
    project.rows = project.rows.filter((r) => !isTodoItem(r) || !todoIds.has(r.id));
    for (const todo of moved) {
      recordPlacementMove({ kind: "todo", todoId: todo.id, placement: "inbox" });
      // Newest-first, like every other inbox arrival (and the server's recency
      // order — an appended todo would jump to the top on reload).
      state.inbox.unshift({ ...todo });
    }
    recordRowOrder(ctx.projId, rowOrderOf(project));
    recordMove(before, snapshot(state, keys));
  },
);

export const useMoveProjectBetweenPlacements = createInterruptingMutator(
  () => null,
  (
    state,
    _,
    fromPlacement: "archive" | "trash",
    projIds: Set<string>,
    toPlacement: "archive" | "trash",
  ) => {
    if (projIds.size === 0 || fromPlacement === toPlacement) return;
    const src = fromPlacement === "archive" ? state.archive : state.trash;
    const moving = src.filter((e) => e.kind === "proj" && projIds.has(e.id));
    if (moving.length === 0) return;
    const next = src.filter((e) => !(e.kind === "proj" && projIds.has(e.id)));
    if (fromPlacement === "archive") state.archive = next;
    else state.trash = next;
    for (const entry of moving) {
      if (entry.kind !== "proj") continue;
      recordPlacementMove({ kind: "proj", projId: entry.id, placement: toPlacement });
      const dst = toPlacement === "archive" ? state.archive : state.trash;
      dst.unshift({ kind: "proj", id: entry.id, name: entry.name });
      // Keep an open (or signed-out row-holding) entry pointing at its new home.
      const proj = state.projs[entry.id];
      if (proj) proj.placement = toPlacement;
    }
  },
);

export const useMovePlacementToPlacement = createMutator(
  () => null,
  (
    state,
    _,
    fromPlacement: "inbox" | "archive" | "trash",
    todoIds: Set<string>,
    toPlacement: "inbox" | "archive" | "trash",
  ) => {
    if (todoIds.size === 0 || fromPlacement === toPlacement) return;
    const keys = [fromPlacement, toPlacement];
    const before = snapshot(state, keys);

    const moved: TodoItem[] = [];
    const associateProjId: Record<string, string | null> = {};

    if (fromPlacement === "inbox") {
      for (const t of state.inbox) {
        if (todoIds.has(t.id)) {
          moved.push({ ...t });
          associateProjId[t.id] = null;
        }
      }
      state.inbox = state.inbox.filter((t) => !todoIds.has(t.id));
    } else {
      const src = fromPlacement === "archive" ? state.archive : state.trash;
      for (const e of src) {
        if (e.kind !== "todo" || !todoIds.has(e.id)) continue;
        moved.push({
          id: e.id,
          title: e.title,
          note: e.note,
          status: e.done ? "complete" : "todo",
          planned: parsePlanned(e.planned),
          checks: e.checks,
        });
        associateProjId[e.id] = e.projId;
      }
      const next = src.filter((e) => !(e.kind === "todo" && todoIds.has(e.id)));
      if (fromPlacement === "archive") state.archive = next;
      else state.trash = next;
    }

    if (moved.length === 0) return;

    for (const todo of moved) {
      if (toPlacement === "inbox") {
        recordPlacementMove({ kind: "todo", todoId: todo.id, placement: "inbox" });
        state.inbox.unshift({ ...todo });
      } else {
        const assoc = associateProjId[todo.id];
        recordPlacementMove({
          kind: "todo",
          todoId: todo.id,
          placement: toPlacement,
          ...(assoc != null && { associateProjId: assoc }),
        });
        const entry = {
          kind: "todo" as const,
          id: todo.id,
          title: todo.title,
          note: todo.note,
          done: todo.status === "complete",
          planned: todo.planned ? formatPlanned(todo.planned) : null,
          projId: assoc,
          checks: todo.checks,
        };
        if (toPlacement === "archive") state.archive.unshift(entry);
        else state.trash.unshift(entry);
      }
    }
    recordMove(before, snapshot(state, keys));
  },
);

export const useMoveToPlacementFrom = createMutator(
  () => null,
  (
    state,
    _,
    fromProjId: string,
    todoIds: Set<string>,
    placement: "inbox" | "archive" | "trash",
  ) => {
    const project = projOf(state, fromProjId);
    if (project == null) return;
    const moved = project.rows.filter((r) => isTodoItem(r) && todoIds.has(r.id)) as TodoItem[];
    if (moved.length === 0) return;
    const keys = [projKey(project.id), placement];
    const before = snapshot(state, keys);
    project.rows = project.rows.filter((r) => !isTodoItem(r) || !todoIds.has(r.id));
    state.panels.forEach((panel) => {
      if (!isProjectInstance(panel.instance)) return;
      if (panel.instance.project.id !== fromProjId) return;
      for (const id of todoIds) {
        delete panel.instance.rowSelected[id];
        delete panel.instance.todoExpanded[id];
      }
    });
    for (const todo of moved) {
      if (placement === "inbox") {
        recordPlacementMove({ kind: "todo", todoId: todo.id, placement: "inbox" });
        state.inbox.unshift({ ...todo });
      } else {
        recordPlacementMove({
          kind: "todo",
          todoId: todo.id,
          placement,
          associateProjId: fromProjId,
        });
        const entry = {
          kind: "todo" as const,
          id: todo.id,
          title: todo.title,
          note: todo.note,
          done: todo.status === "complete",
          planned: todo.planned ? formatPlanned(todo.planned) : null,
          projId: fromProjId,
          checks: todo.checks,
        };
        if (placement === "archive") state.archive.unshift(entry);
        else state.trash.unshift(entry);
      }
    }
    recordRowOrder(fromProjId, rowOrderOf(project));
    recordMove(before, snapshot(state, keys));
  },
);
