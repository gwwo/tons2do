// Delta sync engine (client side).
//
// Mutation overlay + syncedAtSeq:
//   Each user action first mutates local app state, then records the change
//   here: field values into `overlay` (latest value per field per entity),
//   structural changes into `scopeOverlay` (ordering / creates / deletes per
//   scope), and placement moves into `placementMoves`. Every record is stamped
//   with the current `pushSeq`.
//
//   At dispatch time the engine composes one wire push from everything
//   pending, sends it, and on ack:
//     1. Advances syncedAtSeq[scope] to each returned delta's newSeq.
//     2. Clears the overlay entries stamped at or before the dispatched seq
//        (mutations recorded while the push was in flight stay queued).
//     3. If anything is still pending, immediately composes the next push.
//
//   One push is in flight at a time. The response deltas are NOT merged into
//   app state — under the current one-writer-per-account assumption the
//   client already holds everything it pushed; merging concurrent clients'
//   changes is the planned sync overhaul's job.

import { SvelteMap } from "svelte/reactivity";
import { CalendarDate } from "@internationalized/date";
import type { AppState, ProjectItem, RowItem, TodoItem } from "./model";
import { newCheckItem, newGroupingItem, newProjectItem, newTodoItem } from "./model";
import { session, signedIn } from "./session.svelte";
import type {
  ProjDelta,
  ProjListDelta,
  PlacementDelta,
  PushBody,
  PushResponse,
  PullRow,
} from "$lib/server/sync/types";

// ─── Overlay types ────────────────────────────────────────────────────────────

export type FieldEntry<T> = { value: T; pushSeq: number };
type FieldOverlay<T> = { [K in keyof T]?: FieldEntry<T[K]> };

export type TodoFields = { title: string; note: string; done: boolean; planned: string | null };

export type EntityOverlay =
  | { kind: "todo"; projId: string | null; placement: string; fields: FieldOverlay<TodoFields> }
  | { kind: "group"; projId: string; fields: FieldOverlay<{ label: string }> }
  | { kind: "proj"; fields: FieldOverlay<{ name: string; note: string }> }
  | {
      kind: "check";
      todoId: string;
      projId: string | null;
      placement: string;
      fields: FieldOverlay<{ content: string; ticked: boolean }>;
    };

// Per-scope structural changes. Scope keys: `proj:{projId}` (row/check order,
// deletes within a project), `todo:{todoId}` (check order of a placement todo),
// `projList`, `projDelete:{projId}`, `todoDelete:{todoId}`.
export type ScopeOverlay = {
  pushSeq: number;
  // Full new row order of the project (the complete list, always).
  rowOrder?: { entries: OrderRowEntry[]; pushSeq: number };
  // Full new check order per todoId (complete list — the server deletes
  // checks absent from it).
  checkOrder?: Record<string, { entries: OrderCheckEntry[]; pushSeq: number }>;
  // Rows to hard-delete from the project.
  deleteRowIds?: { id: string; kind: "todo" | "group"; pushSeq: number }[];
  // New proj-list order (ordered projIds).
  projListOrder?: { entries: string[]; pushSeq: number };
};

export type OrderRowEntry = {
  rowId: string;
  kind: "todo" | "group";
  startAtIndex: number;
  moveHere?: boolean;
  createHere?: boolean;
};

export type OrderCheckEntry = {
  checkId: string;
  startAtIndex: number;
  createHere?: boolean;
};

// Placement moves: items entering archive/trash/inbox.
// `data` carries field + checklist content for a todo the server must CREATE
// in the placement (one that never lived in a project) — routing its content
// through todoUpdates instead would no-op, since that runs before the arrange
// and the todo doesn't exist yet. Used by the sign-up migration of a guest's
// inbox/archive/trash todos.
export type PlacementTodoData = {
  title?: string;
  note?: string;
  done?: boolean;
  planned?: string | null;
  checks?: { id: string; content: string; ticked: boolean }[];
};
export type PlacementMoveTodo = {
  kind: "todo";
  todoId: string;
  placement: "archive" | "trash" | "inbox";
  associateProjId?: string;
  data?: PlacementTodoData;
  pushSeq: number;
};
export type PlacementMoveProj = {
  kind: "proj";
  projId: string;
  placement: "archive" | "trash";
  pushSeq: number;
};
export type PlacementMoveEntry = PlacementMoveTodo | PlacementMoveProj;

// ─── Reactive engine state ────────────────────────────────────────────────────

export const syncStatus = $state<{
  inflight: boolean;
  error: string | null;
  // Monotonic stamp for recorded mutations; incremented per dispatched push.
  pushSeq: number;
}>({
  inflight: false,
  error: null,
  pushSeq: 0,
});

// Per-scope syncedAtSeq. Keyed by `proj:{projId}`, `projList`, `inbox`,
// `archive`, `trash`.
export const syncedAtSeq: Record<string, number> = $state({});

// Field overlay: entityId → pending field values. (SvelteMap so size/content
// reads — e.g. the nav bar's "syncing" indicator — are reactive.)
export const overlay: Map<string, EntityOverlay> = new SvelteMap();

// Structural overlay: scopeKey → pending structural changes.
export const scopeOverlay: Map<string, ScopeOverlay> = new SvelteMap();

// Placement moves pending push, in recording order.
export const placementMoves: PlacementMoveEntry[] = $state([]);

let initialized = false;

// ─── Init / session management ───────────────────────────────────────────────

// Boots the dispatch loop once the page has hydrated. The session user is
// seeded by the page during render (see +page.svelte).
export const initSync = () => {
  initialized = true;
  if (signedIn() && hasPendingMutations()) void drive();
};

// Drop every piece of per-session sync bookkeeping. Call whenever the signed-in
// user changes (sign-in, sign-out, account switch) so a previous session's
// state can't leak into the next. In particular `syncedAtSeq` is per-user, per-
// scope: left behind, the next sign-in pulls each project incrementally against
// a seq that already matches the server and gets back an empty delta — the
// project renders with no rows until a reload bootstraps it. The overlay maps
// can likewise hold a guest's never-synced edits, which must not be replayed
// against the account being signed into.
export const resetSyncState = () => {
  for (const k of Object.keys(syncedAtSeq)) delete syncedAtSeq[k];
  overlay.clear();
  scopeOverlay.clear();
  placementMoves.length = 0;
  syncStatus.error = null;
};

// ─── Mutation recording ───────────────────────────────────────────────────────
// Call AFTER applying the change to local app state.

// Get-or-create the overlay entry for an entity. An existing entry keeps its
// routing info (projId/placement) from when it was first recorded.
function upsertEntity<E extends EntityOverlay>(id: string, init: E): E {
  const cur = overlay.get(id);
  if (cur && cur.kind === init.kind) return cur as E;
  overlay.set(id, init);
  return init;
}

// Stamp the defined fields into an overlay entry at the current pushSeq.
function stampFields<T extends object>(target: FieldOverlay<T>, fields: Partial<T>) {
  const seq = syncStatus.pushSeq;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) (target as Record<string, unknown>)[k] = { value: v, pushSeq: seq };
  }
}

// Get-or-create a scope overlay, re-stamping it at the current pushSeq.
function upsertScope(key: string): ScopeOverlay {
  const s = scopeOverlay.get(key) ?? { pushSeq: syncStatus.pushSeq };
  s.pushSeq = syncStatus.pushSeq;
  scopeOverlay.set(key, s);
  return s;
}

export const recordTodoEdit = (
  todoId: string,
  projId: string | null,
  placement: string,
  fields: Partial<TodoFields>,
) => {
  const entry = upsertEntity(todoId, { kind: "todo" as const, projId, placement, fields: {} });
  stampFields(entry.fields, fields);
  scheduleDispatch();
};

export const recordGroupEdit = (
  groupId: string,
  projId: string,
  fields: Partial<{ label: string }>,
) => {
  const entry = upsertEntity(groupId, { kind: "group" as const, projId, fields: {} });
  stampFields(entry.fields, fields);
  scheduleDispatch();
};

export const recordProjEdit = (projId: string, fields: Partial<{ name: string; note: string }>) => {
  const entry = upsertEntity(projId, { kind: "proj" as const, fields: {} });
  stampFields(entry.fields, fields);
  scheduleDispatch();
};

export const recordCheckEdit = (
  checkId: string,
  todoId: string,
  projId: string | null,
  placement: string,
  fields: Partial<{ content: string; ticked: boolean }>,
) => {
  const entry = upsertEntity(checkId, {
    kind: "check" as const,
    todoId,
    projId,
    placement,
    fields: {},
  });
  stampFields(entry.fields, fields);
  scheduleDispatch();
};

export const recordRowOrder = (projId: string, entries: OrderRowEntry[]) => {
  upsertScope(`proj:${projId}`).rowOrder = { entries, pushSeq: syncStatus.pushSeq };
  scheduleDispatch();
};

export const recordCheckOrder = (projId: string, todoId: string, entries: OrderCheckEntry[]) => {
  const s = upsertScope(`proj:${projId}`);
  (s.checkOrder ??= {})[todoId] = { entries, pushSeq: syncStatus.pushSeq };
  scheduleDispatch();
};

// Check order for a todo living in a placement view (inbox/archive/trash).
export const recordPlacementCheckOrder = (todoId: string, entries: OrderCheckEntry[]) => {
  const s = upsertScope(`todo:${todoId}`);
  (s.checkOrder ??= {})[todoId] = { entries, pushSeq: syncStatus.pushSeq };
  scheduleDispatch();
};

export const recordProjListOrder = (projIds: string[]) => {
  upsertScope("projList").projListOrder = { entries: projIds, pushSeq: syncStatus.pushSeq };
  scheduleDispatch();
};

export const recordRowDelete = (projId: string, rowId: string, kind: "todo" | "group") => {
  const s = upsertScope(`proj:${projId}`);
  (s.deleteRowIds ??= []).push({ id: rowId, kind, pushSeq: syncStatus.pushSeq });
  scheduleDispatch();
};

export const recordPlacementMove = (
  entry: Omit<PlacementMoveTodo, "pushSeq"> | Omit<PlacementMoveProj, "pushSeq">,
) => {
  // Last-wins per entity: an earlier queued move of the same todo/proj is
  // superseded — only the final destination matters. The server applies the
  // per-placement slices in a FIXED order (archive, trash, inbox), not in
  // recording order, so two queued moves for one entity composed into the same
  // push would let the stale one win. Inline `data` (the create vehicle for a
  // todo the server doesn't know yet) is carried onto the replacement.
  const idx = placementMoves.findIndex((m) =>
    m.kind === "todo"
      ? entry.kind === "todo" && m.todoId === entry.todoId
      : entry.kind === "proj" && m.projId === entry.projId,
  );
  if (idx >= 0) {
    const [prev] = placementMoves.splice(idx, 1);
    if (prev.kind === "todo" && entry.kind === "todo" && prev.data && !entry.data) {
      entry = { ...entry, data: prev.data };
    }
  }
  placementMoves.push({ ...entry, pushSeq: syncStatus.pushSeq } as PlacementMoveEntry);
  scheduleDispatch();
};

// Drop queued todo placement moves for these ids — used by undo/redo when a
// row order pulls a todo back into a project, superseding its pending
// placement arrival (arranges apply after row orders server-side, so a stale
// queued arrival composed into the same push would override the row order).
// Returns the ids that had a queued move: their move may have been the op that
// would CREATE them server-side, so the caller flags them createHere in the
// row order it records instead.
export const supersedePlacementMoves = (todoIds: Set<string>): Set<string> => {
  const superseded = new Set<string>();
  if (todoIds.size === 0) return superseded;
  for (let i = placementMoves.length - 1; i >= 0; i--) {
    const m = placementMoves[i];
    if (m.kind === "todo" && todoIds.has(m.todoId)) {
      superseded.add(m.todoId);
      placementMoves.splice(i, 1);
    }
  }
  return superseded;
};

export const recordProjCreate = (projId: string) => {
  // Register the proj scope so a projUpdate is emitted even before any row
  // exists; the create itself is carried by the name/note recordProjEdit.
  upsertScope(`proj:${projId}`).rowOrder = { entries: [], pushSeq: syncStatus.pushSeq };
  scheduleDispatch();
};

export const recordProjDelete = (projId: string) => {
  upsertScope(`projDelete:${projId}`);
  scheduleDispatch();
};

export const recordTodoDelete = (todoId: string, projId: string | null) => {
  upsertScope(`todoDelete:${todoId}`);
  // Overwrite any pending field edits (the todo is gone); with a projId this
  // also routes an empty projUpdate so the response refreshes that proj scope.
  overlay.set(todoId, { kind: "todo", projId, placement: "project", fields: {} });
  scheduleDispatch();
};

// ─── Push composition ─────────────────────────────────────────────────────────

type ProjUpdate = NonNullable<PushBody["projUpdates"]>[number];
type RowEdit = NonNullable<ProjUpdate["editRows"]>[string];
type TodoRowEdit = Extract<RowEdit, { kind: "todo" }>;
type TodoUpdate = NonNullable<PushBody["todoUpdates"]>[number];

// Project-scoped mutations → projUpdates. Everything recorded against a proj
// scope (proj fields, row field edits, check edits/orders, row order, row
// deletes) folds into one projUpdate per project.
function composeProjUpdates(): ProjUpdate[] {
  const editRowsByProj = new Map<string, Record<string, RowEdit>>();
  const projFields = new Map<string, { name?: string; note?: string }>();

  const editRowsOf = (projId: string) => {
    let rows = editRowsByProj.get(projId);
    if (!rows) editRowsByProj.set(projId, (rows = {}));
    return rows;
  };
  const todoEditOf = (rows: Record<string, RowEdit>, todoId: string): TodoRowEdit => {
    const cur = rows[todoId];
    if (cur?.kind === "todo") return cur;
    return (rows[todoId] = { kind: "todo" });
  };

  for (const [id, entry] of overlay) {
    switch (entry.kind) {
      case "todo": {
        if (entry.projId == null) break; // placement todo → composeTodoUpdates
        const edit = todoEditOf(editRowsOf(entry.projId), id);
        const f = entry.fields;
        if (f.title) edit.title = f.title.value;
        if (f.note) edit.note = f.note.value;
        if (f.done) edit.done = f.done.value;
        if (f.planned) edit.planned = f.planned.value;
        break;
      }
      case "group": {
        if (entry.fields.label) {
          editRowsOf(entry.projId)[id] = { kind: "group", label: entry.fields.label.value };
        }
        break;
      }
      case "proj": {
        const f = entry.fields;
        projFields.set(id, {
          ...(f.name && { name: f.name.value }),
          ...(f.note && { note: f.note.value }),
        });
        break;
      }
      case "check": {
        if (entry.projId == null) break; // placement check → composeTodoUpdates
        const f = entry.fields;
        if (!f.content && !f.ticked) break;
        const edit = todoEditOf(editRowsOf(entry.projId), entry.todoId);
        (edit.editChecks ??= {})[id] = {
          ...(f.content && { content: f.content.value }),
          ...(f.ticked && { ticked: f.ticked.value }),
        };
        break;
      }
    }
  }

  // Every proj scope with pending content or structural changes.
  const projIds = new Set([...editRowsByProj.keys(), ...projFields.keys()]);
  for (const key of scopeOverlay.keys()) {
    if (key.startsWith("proj:")) projIds.add(key.slice("proj:".length));
  }

  const updates: ProjUpdate[] = [];
  for (const projId of projIds) {
    const pu: ProjUpdate = { projId, syncedAtSeq: syncedAtSeq[`proj:${projId}`] ?? 0 };
    const pf = projFields.get(projId);
    if (pf?.name !== undefined) pu.name = pf.name;
    if (pf?.note !== undefined) pu.note = pf.note;

    const editRows = editRowsByProj.get(projId) ?? {};
    // Drop todo edits that gathered no payload (bare { kind: "todo" }).
    for (const [rowId, edit] of Object.entries(editRows)) {
      if (Object.keys(edit).length <= 1) delete editRows[rowId];
    }

    const scope = scopeOverlay.get(`proj:${projId}`);
    if (scope?.rowOrder) pu.orderRows = scope.rowOrder.entries;
    if (scope?.deleteRowIds?.length) {
      pu.deleteRows = Object.fromEntries(scope.deleteRowIds.map((r) => [r.id, r.kind]));
    }
    if (scope?.checkOrder) {
      for (const [todoId, { entries }] of Object.entries(scope.checkOrder)) {
        todoEditOf(editRows, todoId).orderChecks = entries;
      }
    }
    if (Object.keys(editRows).length > 0) pu.editRows = editRows;

    updates.push(pu);
  }
  return updates;
}

// Standalone edits for placement todos (projId == null — inbox/archive/trash):
// field edits, check edits, and check orders, emitted as todoUpdates.
function composeTodoUpdates(): TodoUpdate[] {
  const byTodo = new Map<string, TodoUpdate>();
  const tuOf = (todoId: string): TodoUpdate => {
    let tu = byTodo.get(todoId);
    if (!tu) byTodo.set(todoId, (tu = { todoId }));
    return tu;
  };

  for (const [id, entry] of overlay) {
    if (entry.kind === "todo" && entry.projId == null) {
      const tu = tuOf(id);
      const f = entry.fields;
      if (f.title) tu.title = f.title.value;
      if (f.note) tu.note = f.note.value;
      if (f.done) tu.done = f.done.value;
      if (f.planned) tu.planned = f.planned.value;
    } else if (entry.kind === "check" && entry.projId == null) {
      const f = entry.fields;
      if (!f.content && !f.ticked) continue;
      const tu = tuOf(entry.todoId);
      (tu.editChecks ??= {})[id] = {
        ...(f.content && { content: f.content.value }),
        ...(f.ticked && { ticked: f.ticked.value }),
      };
    }
  }

  for (const [key, scope] of scopeOverlay) {
    if (!key.startsWith("todo:")) continue;
    const todoId = key.slice("todo:".length);
    const order = scope.checkOrder?.[todoId];
    if (order) tuOf(todoId).orderChecks = order.entries;
  }

  // Only emit todoUpdates that carry something beyond the id.
  return [...byTodo.values()].filter((tu) => Object.keys(tu).length > 1);
}

// Pending placement moves → per-placement arrange slices.
function composeArrangeSlices() {
  const archive: NonNullable<PushBody["archiveArrange"]>["slice"] = [];
  const trash: NonNullable<PushBody["trashArrange"]>["slice"] = [];
  const inbox: NonNullable<PushBody["inboxArrange"]>["slice"] = [];

  for (const mv of placementMoves) {
    if (mv.placement === "inbox") {
      // A todo created directly in the inbox doesn't exist server-side when
      // the arrange runs (todoUpdates is applied first and no-ops on missing
      // todos), so carry its pending field data inline. For a move of an
      // existing todo the server ignores `data`.
      let data = mv.data;
      if (!data) {
        const ov = overlay.get(mv.todoId);
        if (ov?.kind === "todo") {
          const f = ov.fields;
          const inline: PlacementTodoData = {
            ...(f.title && { title: f.title.value }),
            ...(f.note && { note: f.note.value }),
            ...(f.done && { done: f.done.value }),
            ...(f.planned && { planned: f.planned.value }),
          };
          if (Object.keys(inline).length > 0) data = inline;
        }
      }
      inbox.push({ todoId: mv.todoId, createHere: true, ...(data && { data }) });
    } else {
      const slice = mv.placement === "archive" ? archive : trash;
      if (mv.kind === "todo") {
        slice.push({
          kind: "todo",
          todoId: mv.todoId,
          createHere: true,
          ...(mv.associateProjId && { associateProjId: mv.associateProjId }),
          ...(mv.data && { data: mv.data }),
        });
      } else {
        slice.push({ kind: "proj", projId: mv.projId, createHere: true });
      }
    }
  }
  return { archive, trash, inbox };
}

function composePush(): PushBody | null {
  if (!hasPendingMutations()) return null;

  const projUpdates = composeProjUpdates();
  const todoUpdates = composeTodoUpdates();
  const slices = composeArrangeSlices();

  const projDeletes: NonNullable<PushBody["projDeletes"]> = [];
  const todoDeletes: NonNullable<PushBody["todoDeletes"]> = [];
  for (const key of scopeOverlay.keys()) {
    if (key.startsWith("projDelete:")) {
      projDeletes.push({
        projId: key.slice("projDelete:".length),
        positionSyncedAtSeq: syncedAtSeq["projList"] ?? 0,
      });
    } else if (key.startsWith("todoDelete:")) {
      todoDeletes.push({ todoId: key.slice("todoDelete:".length), positionSyncedAtSeq: 0 });
    }
  }

  let projsArrange: PushBody["projsArrange"];
  const listOrder = scopeOverlay.get("projList")?.projListOrder;
  if (listOrder) {
    projsArrange = {
      orderProjs: listOrder.entries.map((projId, i) => ({
        projId,
        startAtIndex: i,
        positionSyncedAtSeq: syncedAtSeq["projList"] ?? 0,
      })),
    };
  }

  const body: PushBody = {
    ...(projUpdates.length > 0 && { projUpdates }),
    ...(projDeletes.length > 0 && { projDeletes }),
    ...(projsArrange && { projsArrange }),
    ...(slices.archive.length > 0 && { archiveArrange: { slice: slices.archive } }),
    ...(slices.trash.length > 0 && { trashArrange: { slice: slices.trash } }),
    ...(slices.inbox.length > 0 && { inboxArrange: { slice: slices.inbox } }),
    ...(todoUpdates.length > 0 && { todoUpdates }),
    ...(todoDeletes.length > 0 && { todoDeletes }),
  };

  return Object.keys(body).length > 0 ? body : null;
}

// ─── Dispatch loop ────────────────────────────────────────────────────────────

let dispatchScheduled = false;

function scheduleDispatch() {
  if (!signedIn()) return;
  if (!initialized) return;
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  // Micro-task delay so multiple synchronous mutations are batched.
  queueMicrotask(() => {
    dispatchScheduled = false;
    void drive();
  });
}

async function drive() {
  if (syncStatus.inflight) return;
  if (!signedIn()) return;

  const body = composePush();
  if (!body) return;

  // Everything just composed carries pushSeq <= dispatchedSeq; advance pushSeq
  // so mutations recorded while this push is in flight get a higher stamp and
  // survive the post-ack clear.
  const dispatchedSeq = syncStatus.pushSeq;
  syncStatus.pushSeq++;
  syncStatus.inflight = true;

  let retry = false;
  try {
    const res = await fetch("/api/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => "");
      syncStatus.error = `push rejected: ${res.status} ${text}`;
      console.error("[sync]", syncStatus.error, body);
      // Drop the batch — client and server may be in different states.
      clearPushedEntries(dispatchedSeq);
    } else if (!res.ok) {
      throw new Error(`push failed: ${res.status} ${await res.text()}`);
    } else {
      syncStatus.error = null;
      const ack = (await res.json()) as PushResponse;
      applyAck(ack, dispatchedSeq);
    }
  } catch (e) {
    syncStatus.error = e instanceof Error ? e.message : String(e);
    retry = true;
  }

  if (retry) {
    // Network/5xx: roll pushSeq back so the retry re-composes the same batch
    // under the same seq (plus anything recorded since).
    syncStatus.pushSeq = dispatchedSeq;
    setTimeout(() => {
      syncStatus.inflight = false;
      void drive();
    }, 2000);
    return;
  }

  syncStatus.inflight = false;
  if (hasPendingMutations()) void drive();
}

// ─── Ack handling ─────────────────────────────────────────────────────────────

function applyAck(ack: PushResponse, dispatchedSeq: number) {
  // Advance syncedAtSeq per touched scope to the seq its delta was computed
  // at. (The delta contents themselves are not merged — see the header note.)
  for (const [projId, delta] of Object.entries(ack.projDeltas ?? {})) {
    syncedAtSeq[`proj:${projId}`] = delta.newSeq;
  }
  if (ack.projListDelta) syncedAtSeq["projList"] = ack.projListDelta.newSeq;
  if (ack.inboxDelta) syncedAtSeq["inbox"] = ack.inboxDelta.newSeq;
  if (ack.archiveDelta) syncedAtSeq["archive"] = ack.archiveDelta.newSeq;
  if (ack.trashDelta) syncedAtSeq["trash"] = ack.trashDelta.newSeq;

  clearPushedEntries(dispatchedSeq);
}

// Drop everything stamped at or before the dispatched seq; whatever was
// recorded while the push was in flight stays for the next one.
function clearPushedEntries(dispatchedSeq: number) {
  for (const [id, entry] of overlay) {
    const fields = entry.fields as Record<string, { pushSeq: number } | undefined>;
    for (const [k, fe] of Object.entries(fields)) {
      if (fe && fe.pushSeq <= dispatchedSeq) delete fields[k];
    }
    if (Object.values(fields).every((v) => v === undefined)) {
      overlay.delete(id);
    }
  }

  for (const [key, s] of scopeOverlay) {
    if (s.pushSeq <= dispatchedSeq) {
      scopeOverlay.delete(key);
      continue;
    }
    if (s.rowOrder && s.rowOrder.pushSeq <= dispatchedSeq) delete s.rowOrder;
    if (s.projListOrder && s.projListOrder.pushSeq <= dispatchedSeq) delete s.projListOrder;
    if (s.checkOrder) {
      for (const [todoId, co] of Object.entries(s.checkOrder)) {
        if (co.pushSeq <= dispatchedSeq) delete s.checkOrder[todoId];
      }
      if (Object.keys(s.checkOrder).length === 0) delete s.checkOrder;
    }
    if (s.deleteRowIds) {
      s.deleteRowIds = s.deleteRowIds.filter((r) => r.pushSeq > dispatchedSeq);
      if (s.deleteRowIds.length === 0) delete s.deleteRowIds;
    }
  }

  for (let i = placementMoves.length - 1; i >= 0; i--) {
    if (placementMoves[i].pushSeq <= dispatchedSeq) placementMoves.splice(i, 1);
  }
}

function hasPendingMutations(): boolean {
  return overlay.size > 0 || scopeOverlay.size > 0 || placementMoves.length > 0;
}

// ─── Explicit pulls ───────────────────────────────────────────────────────────

export async function pullProj(
  projId: string,
  opts?: { full?: boolean },
): Promise<ProjDelta | null> {
  if (!signedIn()) return null;
  try {
    // `full` forces a bootstrap fetch (omit syncedAtSeq) — used when opening a
    // stubbed/trashed project, where a stale per-proj seq would yield a partial
    // delta that projectFromDelta can't reconstruct a whole project from.
    const r = await fetch("/api/sync/proj", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projId,
        syncedAtSeq: opts?.full ? undefined : syncedAtSeq[`proj:${projId}`],
      }),
    });
    if (!r.ok) {
      syncStatus.error = `proj pull failed: ${r.status}`;
      return null;
    }
    const delta = (await r.json()) as ProjDelta;
    syncedAtSeq[`proj:${projId}`] = delta.newSeq;
    return delta;
  } catch (e) {
    syncStatus.error = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export async function pullProjList(): Promise<ProjListDelta | null> {
  if (!signedIn()) return null;
  try {
    const r = await fetch("/api/sync/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ syncedAtSeq: syncedAtSeq["projList"] }),
    });
    if (!r.ok) {
      syncStatus.error = `proj list pull failed: ${r.status}`;
      return null;
    }
    const delta = (await r.json()) as ProjListDelta;
    syncedAtSeq["projList"] = delta.newSeq;
    return delta;
  } catch (e) {
    syncStatus.error = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export async function pullPlacement(
  placement: "inbox" | "archive" | "trash",
): Promise<PlacementDelta | null> {
  if (!signedIn()) return null;
  try {
    const r = await fetch(`/api/sync/${placement}`);
    if (!r.ok) {
      syncStatus.error = `${placement} pull failed: ${r.status}`;
      return null;
    }
    const delta = (await r.json()) as PlacementDelta;
    syncedAtSeq[placement] = delta.newSeq;
    return delta;
  } catch (e) {
    syncStatus.error = e instanceof Error ? e.message : String(e);
    return null;
  }
}

// ─── Build client model from deltas ──────────────────────────────────────────

export const parsePlanned = (s: string | null): CalendarDate | null => {
  if (s == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new CalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
};

export const formatPlanned = (d: CalendarDate | null): string | null => {
  if (d == null) return null;
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
};

function deltaToRows(enteredRows: PullRow[]): RowItem[] {
  return enteredRows.map((r) => {
    if (r.kind === "group") {
      return { ...newGroupingItem({ label: r.label }), id: r.id };
    }
    const checks = [...r.checks]
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((c) => ({ ...newCheckItem({ text: c.content, ticked: c.ticked }), id: c.id }));
    return {
      ...newTodoItem({
        title: r.title,
        note: r.note,
        status: r.done ? "complete" : "todo",
        planned: parsePlanned(r.planned),
        checks,
      }),
      id: r.id,
    };
  });
}

// Build a full ProjectItem from a ProjDelta (bootstrap case: all rows in
// enteredRows). The server emits enteredRows todos-first-then-groups (not
// globally interleaved), so re-sort by the sortKey carried on the delta rows —
// otherwise every grouping sinks below all todos on reload.
export const projectFromDelta = (
  projId: string,
  name: string,
  note: string,
  delta: ProjDelta,
): ProjectItem => {
  const sortKeyById = new Map(delta.enteredRows.map((r) => [r.id, r.sortKey]));
  const rows = deltaToRows(delta.enteredRows);
  rows.sort((a, b) => (sortKeyById.get(a.id) ?? 0) - (sortKeyById.get(b.id) ?? 0));
  return { ...newProjectItem({ name, note, rows }), id: projId };
};

// Apply a ProjDelta to an existing ProjectItem. Mutates in place.
export const applyProjDeltaToProject = (project: ProjectItem, delta: ProjDelta): void => {
  if (delta.projFields) {
    if (delta.projFields.name !== undefined) project.name = delta.projFields.name;
    if (delta.projFields.note !== undefined) project.note = delta.projFields.note;
  }

  // Add entered rows. Each carries a sortKey; insert new rows at the position
  // that sortKey implies relative to the other rows we have a sortKey for. On
  // a full fetch every row is in this delta, so the interleaved order is fully
  // reconstructed; on an incremental delta only co-arriving rows are
  // comparable, so a lone new row falls back to appending.
  const sortKeyById = new Map(delta.enteredRows.map((r) => [r.id, r.sortKey]));
  const entered = deltaToRows(delta.enteredRows);
  for (const row of entered) {
    const existing = project.rows.findIndex((r) => r.id === row.id);
    if (existing >= 0) {
      project.rows[existing] = row;
      continue;
    }
    const sk = sortKeyById.get(row.id)!;
    let insertAt = project.rows.length;
    for (let i = 0; i < project.rows.length; i++) {
      const otherSk = sortKeyById.get(project.rows[i].id);
      if (otherSk !== undefined && otherSk > sk) {
        insertAt = i;
        break;
      }
    }
    project.rows.splice(insertAt, 0, row);
  }

  // Apply field changes to existing rows.
  for (const change of delta.changedRows) {
    const row = project.rows.find((r) => r.id === change.id);
    if (!row) continue;
    if (change.kind === "todo") {
      const todo = row as TodoItem;
      if (change.title !== undefined) todo.title = change.title;
      if (change.note !== undefined) todo.note = change.note;
      if (change.done !== undefined) todo.status = change.done ? "complete" : "todo";
      if (change.planned !== undefined) todo.planned = parsePlanned(change.planned);
    } else {
      if (change.label !== undefined) (row as { label: string }).label = change.label;
    }
  }

  // Remove exited rows.
  const exitedSet = new Set(delta.exitedRowIds);
  project.rows = project.rows.filter((r) => !exitedSet.has(r.id));

  // When the delta is a full snapshot (every current row carries a sortKey),
  // trust it as the authoritative order. Skipped for incremental deltas — a
  // locally-created row not yet known to the server leaves a row without a
  // sortKey, so local order is never clobbered.
  if (project.rows.length > 0 && project.rows.every((r) => sortKeyById.has(r.id))) {
    project.rows.sort((a, b) => sortKeyById.get(a.id)! - sortKeyById.get(b.id)!);
  }
};

// ─── Wire helpers ─────────────────────────────────────────────────────────────

export const rowOrderOf = (proj: ProjectItem): OrderRowEntry[] =>
  proj.rows.map((r, i) => ({
    rowId: r.id,
    kind: ("label" in r ? "group" : "todo") as "todo" | "group",
    startAtIndex: i,
  }));

// Upload a guest's entire local state to the server on sign-up. Every project's
// content (fields + rows + checks) is recorded as a normal project edit; the
// proj-list order is sent for the active list; each archived/trashed project
// gets a placement move so the server files it under archive/trash (its rows
// ride along as placement="project", exactly as in the live app); and each
// standalone placement todo (inbox / archive / trash) is created directly in its
// placement with its fields + checks carried inline. Signed out, an
// archived/trashed project's full content is still in its `projs` entry.
export const uploadInitialState = async (state: AppState): Promise<void> => {
  if (!signedIn()) return;

  // Discard whatever the guest accumulated while signed out. Those mutations
  // never synced, and replaying them on top of the clean snapshot below would
  // conflict: e.g. a guest's "move todo to trash" was recorded without field
  // data, so left in the queue it creates the row as a shell first, and the
  // snapshot's data-carrying move then no-ops on the now-existing row. We upload
  // the final state, not the guest's edit history.
  overlay.clear();
  scopeOverlay.clear();
  placementMoves.length = 0;

  const recordProjectContent = (p: ProjectItem) => {
    recordProjEdit(p.id, { name: p.name, note: p.note });
    // Every row is brand-new on the server: mark createHere so applyRowOrder
    // INSERTs it (a plain reorder no-ops against rows that don't exist yet).
    recordRowOrder(
      p.id,
      p.rows.map((r, i) => ({
        rowId: r.id,
        kind: ("label" in r ? "group" : "todo") as "todo" | "group",
        startAtIndex: i,
        createHere: true,
      })),
    );
    for (const row of p.rows) {
      if ("label" in row) {
        recordGroupEdit(row.id, p.id, { label: row.label });
      } else {
        const todo = row as TodoItem;
        recordTodoEdit(todo.id, p.id, "project", {
          title: todo.title,
          note: todo.note,
          done: todo.status === "complete",
          planned: formatPlanned(todo.planned),
        });
        // Likewise createHere for each check, so the server INSERTs them (in
        // order) rather than logging edits against checks that don't exist.
        if (todo.checks.length > 0) {
          recordCheckOrder(
            p.id,
            todo.id,
            todo.checks.map((c, i) => ({ checkId: c.id, startAtIndex: i, createHere: true })),
          );
        }
        for (const check of todo.checks) {
          recordCheckEdit(check.id, todo.id, p.id, "project", {
            content: check.text,
            ticked: check.ticked,
          });
        }
      }
    }
  };

  // Active projects (archived/trashed ones are handled below).
  for (const id of state.projOrder) {
    const entry = state.projs[id];
    if (entry) recordProjectContent(entry.project);
  }
  recordProjListOrder([...state.projOrder]);

  // Every project id being uploaded. An archived/trashed todo may name its
  // originating project (associateProjId) — keep that link only when the project
  // is here too, so the server's todo.projId FK holds.
  const projIds = new Set(state.projOrder);
  for (const e of [...state.archive, ...state.trash]) {
    if (e.kind === "proj") projIds.add(e.id);
  }

  // Archived / trashed entries. Iterate each list oldest-first (the lists are
  // newest-first) so the server's ascending sortKey reproduces the client's
  // display order. Projects upload their content — signed out it's all present
  // in their projs entry — then move placement; standalone todos are created
  // directly in the placement with their fields + checks.
  for (const [placement, entries] of [
    ["archive", state.archive],
    ["trash", state.trash],
  ] as const) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === "proj") {
        recordProjectContent(
          state.projs[e.id]?.project ?? { id: e.id, name: e.name, note: "", rows: [] },
        );
        recordPlacementMove({ kind: "proj", projId: e.id, placement });
      } else {
        recordPlacementMove({
          kind: "todo",
          todoId: e.id,
          placement,
          ...(e.projId != null && projIds.has(e.projId) && { associateProjId: e.projId }),
          data: {
            title: e.title,
            note: e.note,
            done: e.done,
            planned: e.planned,
            checks: e.checks.map((c) => ({ id: c.id, content: c.text, ticked: c.ticked })),
          },
        });
      }
    }
  }

  // Inbox todos (also newest-first), created directly in the inbox.
  for (let i = state.inbox.length - 1; i >= 0; i--) {
    const t = state.inbox[i];
    recordPlacementMove({
      kind: "todo",
      todoId: t.id,
      placement: "inbox",
      data: {
        title: t.title,
        note: t.note,
        done: t.status === "complete",
        planned: formatPlanned(t.planned),
        checks: t.checks.map((c) => ({ id: c.id, content: c.text, ticked: c.ticked })),
      },
    });
  }

  await settle();
};

// Settle: wait for the push queue to drain (used by sign-up upload and the
// manual refresh). Resolves false on timeout or when the queue drained with a
// sticky error.
export async function settle(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (!syncStatus.inflight && hasPendingMutations()) void drive();
  while (Date.now() < deadline) {
    if (!syncStatus.inflight && !hasPendingMutations()) {
      return syncStatus.error == null;
    }
    if (!syncStatus.inflight && hasPendingMutations()) void drive();
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
