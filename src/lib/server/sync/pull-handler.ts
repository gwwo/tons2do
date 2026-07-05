// Server-side pull / delta computation.
//
// Delta algorithm (per schema.ts comments):
//   1. Query update logs for entries since syncedAtSeq.
//   2. Classify entities as entered, exited, or field-changed.
//   3. Fetch current state for entered/changed entities.
//   4. Return the delta.
//
// Known gaps (by design, pending the sync overhaul):
//   - Check-field changes are NOT part of incremental proj deltas; checks only
//     travel with their todo's full row in enteredRows.
//   - Row order changes ("position" logs) are not surfaced either; order is
//     only authoritative on a full fetch (see applyProjDeltaToProject).
//   - projPull.todoSyncedAtSeq is accepted by the protocol but ignored here.
//
// For placement views (inbox / archive / trash) and the proj list, we do a
// simple full fetch (no delta) because these lists are typically small.

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  userTable,
  projTable,
  groupTable,
  todoTable,
  checkTable,
  projUpdateLog,
  groupUpdateLog,
  todoUpdateLog,
} from "../db/schema";
import type {
  ProjDelta,
  ProjListDelta,
  PlacementDelta,
  PlacementEntry,
  PullRow,
  PullCheck,
  ChangedRow,
  ProjListEntry,
} from "./types";

// ─── Shared helpers ──────────────────────────────────────────────────────────

// The user's current head seq — the seq a delta computed "now" is valid through.
async function headSeq(userId: string): Promise<number> {
  const [user] = await db
    .select({ mutateSeq: userTable.mutateSeq })
    .from(userTable)
    .where(eq(userTable.id, userId));
  return user?.mutateSeq ?? 0;
}

// Classify entities from their enter/exit logs in the window (id → earliest
// event kind) against current presence:
//   present now                  → entered: (re)send the full row. Covers plain
//                                  enter, and exit-then-re-enter.
//   absent, earliest was "exit"  → exited: the client knew it; tell it to remove.
//   absent, earliest was "enter" → entered then left within the window; the
//                                  client never saw it — ignore.
function classifyEnterExit(
  events: { id: string; update: "enter" | "exit"; minSeq: number }[],
  presentIds: Set<string>,
): { entered: Set<string>; exited: Set<string> } {
  const first = new Map<string, { update: "enter" | "exit"; seq: number }>();
  for (const e of events) {
    const cur = first.get(e.id);
    // On a same-seq tie (entered and exited in one push), "enter" wins,
    // matching the absent-case rule above.
    if (!cur || e.minSeq < cur.seq || (e.minSeq === cur.seq && e.update === "enter")) {
      first.set(e.id, { update: e.update, seq: e.minSeq });
    }
  }
  const entered = new Set<string>();
  const exited = new Set<string>();
  for (const [id, f] of first) {
    if (presentIds.has(id)) entered.add(id);
    else if (f.update === "exit") exited.add(id);
  }
  return { entered, exited };
}

type CheckRow = typeof checkTable.$inferSelect;

// Fetch all checks of the given todos, ordered, grouped by todoId.
async function checksByTodo(todoIds: string[]): Promise<Map<string, CheckRow[]>> {
  const checks = todoIds.length
    ? await db
        .select()
        .from(checkTable)
        .where(inArray(checkTable.todoId, todoIds))
        .orderBy(asc(checkTable.sortKey))
    : [];
  const byTodo = new Map<string, CheckRow[]>();
  for (const c of checks) {
    const list = byTodo.get(c.todoId);
    if (list) list.push(c);
    else byTodo.set(c.todoId, [c]);
  }
  return byTodo;
}

const toPullCheck = (c: CheckRow): PullCheck => ({
  id: c.id,
  content: c.content,
  ticked: c.ticked,
  sortKey: c.sortKey,
});

const toPullTodoRow = (t: typeof todoTable.$inferSelect, checks: CheckRow[]): PullRow => ({
  kind: "todo",
  id: t.id,
  title: t.title ?? "",
  note: t.note ?? "",
  done: t.done,
  planned: t.planned,
  sortKey: t.sortKey,
  checks: checks.map(toPullCheck),
});

const toPullGroupRow = (g: typeof groupTable.$inferSelect): PullRow => ({
  kind: "group",
  id: g.id,
  label: g.label ?? "",
  sortKey: g.sortKey,
});

// ─── Project content delta ───────────────────────────────────────────────────

export async function buildProjDelta(
  userId: string,
  projId: string,
  syncedAtSeq: number | undefined,
): Promise<ProjDelta> {
  const newSeq = await headSeq(userId);

  if (syncedAtSeq === undefined) {
    return fullProjFetch(userId, projId, newSeq);
  }

  // ── Enter/exit logs since syncedAtSeq, and current presence ───────────────
  const [todoEnterExitLogs, groupEnterExitLogs, presentTodos, presentGroups] = await Promise.all([
    db
      .select({
        id: todoUpdateLog.todoId,
        update: todoUpdateLog.update,
        minSeq: sql<number>`MIN(${todoUpdateLog.createdAtSeq})`.mapWith(Number),
      })
      .from(todoUpdateLog)
      .where(
        and(
          eq(todoUpdateLog.userId, userId),
          eq(todoUpdateLog.projId, projId),
          // Only logs stamped in the project scope. An archive/trash move
          // writes exit(project, projId) + enter(archive, projId) at the same
          // seq — without this filter the placement-scope enter would tie with
          // the exit and the todo's departure would be misread as
          // entered-then-left (i.e. never reported to the client).
          eq(todoUpdateLog.placement, "project"),
          gt(todoUpdateLog.createdAtSeq, syncedAtSeq),
          inArray(todoUpdateLog.update, ["enter", "exit"]),
        ),
      )
      .groupBy(todoUpdateLog.todoId, todoUpdateLog.update),
    db
      .select({
        id: groupUpdateLog.groupId,
        update: groupUpdateLog.update,
        minSeq: sql<number>`MIN(${groupUpdateLog.createdAtSeq})`.mapWith(Number),
      })
      .from(groupUpdateLog)
      .where(
        and(
          eq(groupUpdateLog.userId, userId),
          eq(groupUpdateLog.projId, projId),
          gt(groupUpdateLog.createdAtSeq, syncedAtSeq),
          inArray(groupUpdateLog.update, ["enter", "exit"]),
        ),
      )
      .groupBy(groupUpdateLog.groupId, groupUpdateLog.update),
    // Todos currently in this project (placement="project" only — trashed or
    // archived todos keep projId as an association but are not "in" the proj).
    db
      .select({ id: todoTable.id })
      .from(todoTable)
      .where(
        and(
          eq(todoTable.projId, projId),
          eq(todoTable.userId, userId),
          eq(todoTable.placement, "project"),
        ),
      ),
    db.select({ id: groupTable.id }).from(groupTable).where(eq(groupTable.projId, projId)),
  ]);

  const presentTodoIds = new Set(presentTodos.map((t) => t.id));
  const presentGroupIds = new Set(presentGroups.map((g) => g.id));

  // The WHERE clauses restrict `update` to enter/exit; narrow the enum type.
  type EnterExitLog = { id: string; update: "enter" | "exit"; minSeq: number }[];
  const todos = classifyEnterExit(todoEnterExitLogs as EnterExitLog, presentTodoIds);
  const groups = classifyEnterExit(groupEnterExitLogs as EnterExitLog, presentGroupIds);

  // ── Field-change logs for rows the client already knows ───────────────────
  const [changedTodoLogs, changedGroupLogs] = await Promise.all([
    db
      .select({ id: todoUpdateLog.todoId, update: todoUpdateLog.update })
      .from(todoUpdateLog)
      .where(
        and(
          eq(todoUpdateLog.userId, userId),
          eq(todoUpdateLog.projId, projId),
          // Edits made while the todo lives elsewhere (archived/trashed but
          // still associated with this proj) belong to the placement scope.
          eq(todoUpdateLog.placement, "project"),
          gt(todoUpdateLog.createdAtSeq, syncedAtSeq),
          inArray(todoUpdateLog.update, ["title", "note", "done", "planned"]),
        ),
      )
      .groupBy(todoUpdateLog.todoId, todoUpdateLog.update),
    db
      .select({ id: groupUpdateLog.groupId, update: groupUpdateLog.update })
      .from(groupUpdateLog)
      .where(
        and(
          eq(groupUpdateLog.userId, userId),
          eq(groupUpdateLog.projId, projId),
          gt(groupUpdateLog.createdAtSeq, syncedAtSeq),
          inArray(groupUpdateLog.update, ["label"]),
        ),
      )
      .groupBy(groupUpdateLog.groupId, groupUpdateLog.update),
  ]);

  // entityId → set of changed field names. Rows being sent whole (entered) or
  // already gone (absent) are skipped.
  const collectChanged = (
    logs: { id: string; update: string }[],
    entered: Set<string>,
    present: Set<string>,
  ): Map<string, Set<string>> => {
    const changed = new Map<string, Set<string>>();
    for (const row of logs) {
      if (entered.has(row.id) || !present.has(row.id)) continue;
      const fields = changed.get(row.id) ?? new Set();
      fields.add(row.update);
      changed.set(row.id, fields);
    }
    return changed;
  };
  const changedTodoFields = collectChanged(changedTodoLogs, todos.entered, presentTodoIds);
  const changedGroupFields = collectChanged(changedGroupLogs, groups.entered, presentGroupIds);

  // ── Fetch current state for entered/changed rows ───────────────────────────
  const fetchTodoIds = [...new Set([...todos.entered, ...changedTodoFields.keys()])];
  const fetchGroupIds = [...new Set([...groups.entered, ...changedGroupFields.keys()])];

  const [fetchedTodos, fetchedGroups, checks] = await Promise.all([
    fetchTodoIds.length
      ? db.select().from(todoTable).where(inArray(todoTable.id, fetchTodoIds))
      : Promise.resolve([]),
    fetchGroupIds.length
      ? db.select().from(groupTable).where(inArray(groupTable.id, fetchGroupIds))
      : Promise.resolve([]),
    checksByTodo([...todos.entered]),
  ]);

  const enteredRows: PullRow[] = [];
  const changedRows: ChangedRow[] = [];

  for (const t of fetchedTodos) {
    if (todos.entered.has(t.id)) {
      enteredRows.push(toPullTodoRow(t, checks.get(t.id) ?? []));
      continue;
    }
    const fields = changedTodoFields.get(t.id);
    if (!fields) continue;
    const change: ChangedRow = { kind: "todo", id: t.id };
    if (fields.has("title")) change.title = t.title ?? "";
    if (fields.has("note")) change.note = t.note ?? "";
    if (fields.has("done")) change.done = t.done;
    if (fields.has("planned")) change.planned = t.planned;
    changedRows.push(change);
  }
  for (const g of fetchedGroups) {
    if (groups.entered.has(g.id)) {
      enteredRows.push(toPullGroupRow(g));
      continue;
    }
    const fields = changedGroupFields.get(g.id);
    if (!fields) continue;
    const change: ChangedRow = { kind: "group", id: g.id };
    if (fields.has("label")) change.label = g.label ?? "";
    changedRows.push(change);
  }

  // ── Project's own field changes ─────────────────────────────────────────────
  const projFieldLogs = await db
    .select({ update: projUpdateLog.update })
    .from(projUpdateLog)
    .where(
      and(
        eq(projUpdateLog.userId, userId),
        eq(projUpdateLog.projId, projId),
        gt(projUpdateLog.createdAtSeq, syncedAtSeq),
        inArray(projUpdateLog.update, ["name", "note"]),
      ),
    );
  let projFields: { name?: string; note?: string } | undefined;
  if (projFieldLogs.length > 0) {
    const [proj] = await db
      .select({ name: projTable.name, note: projTable.note })
      .from(projTable)
      .where(eq(projTable.id, projId));
    if (proj) {
      projFields = {};
      if (projFieldLogs.some((l) => l.update === "name")) projFields.name = proj.name ?? "";
      if (projFieldLogs.some((l) => l.update === "note")) projFields.note = proj.note ?? "";
    }
  }

  return {
    newSeq,
    enteredRows,
    changedRows,
    exitedRowIds: [...todos.exited, ...groups.exited],
    ...(projFields && { projFields }),
  };
}

// Full bootstrap for a project: every current row as an enteredRow.
async function fullProjFetch(userId: string, projId: string, newSeq: number): Promise<ProjDelta> {
  const [proj] = await db
    .select()
    .from(projTable)
    .where(and(eq(projTable.id, projId), eq(projTable.userId, userId)));
  if (!proj) {
    return { newSeq, enteredRows: [], changedRows: [], exitedRowIds: [] };
  }

  const [todos, groups] = await Promise.all([
    db
      .select()
      .from(todoTable)
      .where(
        and(
          eq(todoTable.projId, projId),
          eq(todoTable.userId, userId),
          eq(todoTable.placement, "project"),
        ),
      )
      // The id tie-break keeps rows with colliding sortKeys (left by historical
      // partial order pushes) stable across fetches; the next arrange of the
      // project renumbers them apart.
      .orderBy(asc(todoTable.sortKey), asc(todoTable.id)),
    db
      .select()
      .from(groupTable)
      .where(eq(groupTable.projId, projId))
      .orderBy(asc(groupTable.sortKey), asc(groupTable.id)),
  ]);

  const checks = await checksByTodo(todos.map((t) => t.id));

  return {
    newSeq,
    enteredRows: [
      ...todos.map((t) => toPullTodoRow(t, checks.get(t.id) ?? [])),
      ...groups.map(toPullGroupRow),
    ],
    changedRows: [],
    exitedRowIds: [],
    projFields: { name: proj.name ?? "", note: proj.note ?? "" },
  };
}

// ─── Project list delta ───────────────────────────────────────────────────────

export async function buildProjListDelta(
  userId: string,
  // Accepted for future delta support; the list is always returned in full.
  _syncedAtSeq: number | undefined,
): Promise<ProjListDelta> {
  void _syncedAtSeq;
  const [newSeq, projs] = await Promise.all([
    headSeq(userId),
    db
      .select()
      .from(projTable)
      .where(and(eq(projTable.userId, userId), eq(projTable.placement, "list")))
      .orderBy(asc(projTable.sortKey)),
  ]);

  const projects: ProjListEntry[] = projs.map((p) => ({
    id: p.id,
    name: p.name ?? "",
    note: p.note ?? "",
    sortKey: p.sortKey,
    placement: p.placement,
  }));

  return { newSeq, projects };
}

// Where a project currently lives: "list" (active), "archive", "trash", or null
// if it doesn't exist / isn't owned by this user. Used to prefetch any open
// project by id and tell the client whether it's a placement drill-in.
export async function getProjPlacement(
  userId: string,
  projId: string,
): Promise<"list" | "archive" | "trash" | null> {
  const [row] = await db
    .select({ placement: projTable.placement })
    .from(projTable)
    .where(and(eq(projTable.userId, userId), eq(projTable.id, projId)));
  return row?.placement ?? null;
}

// ─── Placement views (inbox / archive / trash) ────────────────────────────────

export async function buildPlacementDelta(
  userId: string,
  placement: "inbox" | "archive" | "trash",
): Promise<PlacementDelta> {
  const [newSeq, todos] = await Promise.all([
    headSeq(userId),
    db
      .select()
      .from(todoTable)
      .where(and(eq(todoTable.userId, userId), eq(todoTable.placement, placement)))
      .orderBy(desc(todoTable.sortKey)), // most recently added first
  ]);

  const checks = await checksByTodo(todos.map((t) => t.id));

  const entries: PlacementEntry[] = todos.map((t) => ({
    kind: "todo" as const,
    id: t.id,
    title: t.title ?? "",
    note: t.note ?? "",
    done: t.done,
    planned: t.planned,
    sortKey: t.sortKey,
    projId: t.projId,
    checks: (checks.get(t.id) ?? []).map(toPullCheck),
  }));

  if (placement === "inbox") {
    return { newSeq, entries };
  }

  // Archive / trash also contain projects.
  const projs = await db
    .select()
    .from(projTable)
    .where(and(eq(projTable.userId, userId), eq(projTable.placement, placement)))
    .orderBy(desc(projTable.sortKey));

  entries.push(
    ...projs.map((p) => ({
      kind: "proj" as const,
      id: p.id,
      name: p.name ?? "",
      sortKey: p.sortKey,
    })),
  );

  // Interleave todos and projects, most recently placed first.
  entries.sort((a, b) => b.sortKey - a.sortKey);

  return { newSeq, entries };
}
