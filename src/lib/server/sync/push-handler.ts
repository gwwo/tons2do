// Server-side push handler for the delta sync protocol.
//
// All writes for a given user execute inside a single transaction that
// SELECT … FOR UPDATEs the user_table row first, serialising concurrent pushes.
//
// Every mutation writes update-log rows stamped with the new mutateSeq, and
// entity mutators derive each log's scope tag (placement/projId) from the
// entity's CURRENT server-side state — never from what the client claims — so
// exit logs land in the scope other clients are actually watching.
//
// Re-sent pushes (network retry after the server already applied) are treated
// as no-ops where detectable: creates of existing rows become plain updates,
// deletes of missing rows are skipped, and unchanged sortKeys produce no
// position logs.
//
// The push response carries per-scope deltas so the client can advance its
// syncedAtSeq without a separate pull round-trip. Deltas are computed outside
// the transaction (reads only); a concurrent push landing in between only makes
// a delta cover more than this push, which is safe for the client to absorb.

import { and, eq, inArray } from "drizzle-orm";
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
  checkUpdateLog,
} from "../db/schema";
import type { PushBody, ProjDelta, PushResponse } from "./types";
import { buildProjDelta, buildProjListDelta, buildPlacementDelta } from "./pull-handler";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type TodoPlacement = "project" | "inbox" | "archive" | "trash";

// Per-placement sortKey counters (user_table columns), threaded mutably through
// the mutators and written back once at the end of the transaction.
type SortCounters = { archive: number; trash: number; inbox: number };

// ─── Main entry point ────────────────────────────────────────────────────────

export async function applyPush(userId: string, body: PushBody): Promise<PushResponse> {
  const outcome = await db.transaction(async (tx) => {
    // Serialize all writes for this user.
    const [user] = await tx
      .select({
        mutateSeq: userTable.mutateSeq,
        archiveSortSeq: userTable.archiveSortSeq,
        trashSortSeq: userTable.trashSortSeq,
        inboxSortSeq: userTable.inboxSortSeq,
      })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .for("update");
    if (!user) throw new Error("user not found");

    const newSeq = user.mutateSeq + 1;
    const counters: SortCounters = {
      archive: user.archiveSortSeq,
      trash: user.trashSortSeq,
      inbox: user.inboxSortSeq,
    };

    // Track which scopes were touched so we can compute deltas in the response.
    const touched = {
      projIds: new Set<string>(),
      projList: false,
      archive: false,
      trash: false,
      inbox: false,
    };

    // projUpdates go first so projects created in this push exist before
    // projsArrange positions them or placement moves reference them.
    for (const pu of body.projUpdates ?? []) {
      await applyProjUpdate(tx, userId, pu, counters, newSeq);
      touched.projIds.add(pu.projId);
    }

    if (body.projsArrange) {
      await applyProjsArrange(tx, userId, body.projsArrange, newSeq);
      touched.projList = true;
    }

    for (const pd of body.projDeletes ?? []) {
      await applyProjDelete(tx, userId, pd.projId, newSeq);
      touched.projList = true;
    }

    for (const tu of body.todoUpdates ?? []) {
      const projId = await applyTodoEditAndChecks(tx, userId, tu.todoId, tu, newSeq);
      if (projId) touched.projIds.add(projId);
    }

    for (const td of body.todoDeletes ?? []) {
      const projId = await deleteTodo(tx, userId, td.todoId, newSeq);
      if (projId) touched.projIds.add(projId);
    }

    if (body.archiveArrange) {
      await applyPlacementArrange(
        tx,
        userId,
        "archive",
        body.archiveArrange.slice,
        counters,
        newSeq,
      );
      touched.archive = true;
      touched.projList = true; // archiving a proj removes it from the list
    }

    if (body.trashArrange) {
      await applyPlacementArrange(tx, userId, "trash", body.trashArrange.slice, counters, newSeq);
      touched.trash = true;
      touched.projList = true;
    }

    if (body.inboxArrange) {
      await applyInboxArrange(tx, userId, body.inboxArrange.slice, counters, newSeq);
      touched.inbox = true;
    }

    await tx
      .update(userTable)
      .set({
        mutateSeq: newSeq,
        archiveSortSeq: counters.archive,
        trashSortSeq: counters.trash,
        inboxSortSeq: counters.inbox,
      })
      .where(eq(userTable.id, userId));

    return { newSeq, touched };
  });

  // ── Response deltas (computed outside the transaction — reads only) ────────
  // Per-proj deltas start from the syncedAtSeq the client sent in its
  // projUpdate. A proj touched some other way (e.g. deleting a placement todo
  // still associated with it) has no client seq and gets a full bootstrap
  // delta — wasteful but safe.
  const projSyncedAt = new Map<string, number | undefined>();
  for (const pu of body.projUpdates ?? []) projSyncedAt.set(pu.projId, pu.syncedAtSeq);

  const projDeltas: Record<string, ProjDelta> = {};
  for (const projId of outcome.touched.projIds) {
    projDeltas[projId] = await buildProjDelta(userId, projId, projSyncedAt.get(projId));
  }

  const [projListDelta, archiveDelta, trashDelta, inboxDelta] = await Promise.all([
    outcome.touched.projList ? buildProjListDelta(userId, undefined) : undefined,
    outcome.touched.archive ? buildPlacementDelta(userId, "archive") : undefined,
    outcome.touched.trash ? buildPlacementDelta(userId, "trash") : undefined,
    outcome.touched.inbox ? buildPlacementDelta(userId, "inbox") : undefined,
  ]);

  return {
    ok: true,
    newSeq: outcome.newSeq,
    ...(Object.keys(projDeltas).length > 0 && { projDeltas }),
    ...(projListDelta && { projListDelta }),
    ...(archiveDelta && { archiveDelta }),
    ...(trashDelta && { trashDelta }),
    ...(inboxDelta && { inboxDelta }),
  };
}

// ─── projUpdate ──────────────────────────────────────────────────────────────

async function applyProjUpdate(
  tx: Tx,
  userId: string,
  pu: NonNullable<PushBody["projUpdates"]>[number],
  counters: SortCounters,
  seq: number,
): Promise<void> {
  const { projId } = pu;

  // Verify ownership, or create if new.
  let [proj] = await tx
    .select({ id: projTable.id, placement: projTable.placement })
    .from(projTable)
    .where(and(eq(projTable.id, projId), eq(projTable.userId, userId)));

  let isNew = false;
  if (!proj) {
    // New project — INSERT it. Require at least a name/note to distinguish
    // intentional creates from stale pushes referencing a deleted project.
    if (pu.name === undefined && pu.note === undefined) return;
    const inserted = await tx
      .insert(projTable)
      .values({
        id: projId,
        userId,
        placement: "list",
        sortKey: 0, // positioned by the projsArrange in the same push
        name: pu.name ?? "",
        note: pu.note ?? "",
      })
      .onConflictDoNothing()
      .returning({ id: projTable.id });
    // id already taken (by another user's proj) — drop the whole update.
    if (inserted.length === 0) return;
    await tx.insert(projUpdateLog).values({
      userId,
      projId,
      placement: "list",
      update: "enter",
      createdAtSeq: seq,
    });
    proj = { id: projId, placement: "list" };
    isNew = true;
  }

  // Field edits on the project itself (skip if we just inserted with those values).
  if (!isNew) {
    const patch: Partial<{ name: string; note: string }> = {};
    if (pu.name !== undefined) patch.name = pu.name;
    if (pu.note !== undefined) patch.note = pu.note;
    if (Object.keys(patch).length > 0) {
      await tx.update(projTable).set(patch).where(eq(projTable.id, projId));
      for (const field of Object.keys(patch) as ("name" | "note")[]) {
        await tx.insert(projUpdateLog).values({
          userId,
          projId,
          placement: proj.placement,
          update: field,
          createdAtSeq: seq,
        });
      }
    }
  }

  // Hard-delete rows.
  for (const [rowId, kind] of Object.entries(pu.deleteRows ?? {})) {
    if (kind === "todo") await deleteTodo(tx, userId, rowId, seq);
    else await deleteGroup(tx, userId, rowId, seq);
  }

  // Move rows out of the project (todos → inbox, groups → discard).
  for (const [rowId, kind] of Object.entries(pu.moveOutRows ?? {})) {
    if (kind === "todo") await moveTodoToInbox(tx, userId, rowId, counters, seq);
    else await deleteGroup(tx, userId, rowId, seq);
  }

  // Row ordering / moves / creations. Runs BEFORE the field/check edits below
  // so a row created in this same push exists before applyCheckOps writes its
  // checks — check_update_log.todoId is an FK to the todo row.
  const createdRowIds = pu.orderRows?.length
    ? await applyRowOrder(tx, userId, projId, pu.orderRows, pu.editRows ?? {}, seq)
    : new Set<string>();

  // Field/check edits for rows. Rows just created already carry their field
  // values from the INSERT — only their check ops still need applying.
  for (const [rowId, edit] of Object.entries(pu.editRows ?? {})) {
    if (edit.kind === "todo") {
      await applyTodoEditAndChecks(tx, userId, rowId, edit, seq, {
        skipFields: createdRowIds.has(rowId),
      });
    } else if (!createdRowIds.has(rowId)) {
      await applyGroupEdit(tx, userId, rowId, edit, seq);
    }
  }
}

// ─── Row ordering within a project ───────────────────────────────────────────
//
// orderRows enumerates the rows of the project in their intended order. For
// each row the server compares against current state:
//   unknown row + createHere      → INSERT (data from editRows, else a shell)
//   unknown row, no createHere    → skip (stale/foreign reference)
//   known row in another scope    → move: exit log (old scope) + enter log here
//   known row here, index changed → position log
//   known row here, unchanged     → no-op
// Returns the ids of rows actually INSERTed (so field edits can be skipped).

async function applyRowOrder(
  tx: Tx,
  userId: string,
  projId: string,
  orderRows: NonNullable<NonNullable<PushBody["projUpdates"]>[number]["orderRows"]>,
  editRows: NonNullable<NonNullable<PushBody["projUpdates"]>[number]["editRows"]>,
  seq: number,
): Promise<Set<string>> {
  const todoIds = orderRows.filter((e) => e.kind === "todo").map((e) => e.rowId);
  const groupIds = orderRows.filter((e) => e.kind === "group").map((e) => e.rowId);

  const [todos, groups] = await Promise.all([
    todoIds.length
      ? tx
          .select({
            id: todoTable.id,
            placement: todoTable.placement,
            projId: todoTable.projId,
            sortKey: todoTable.sortKey,
          })
          .from(todoTable)
          .where(and(inArray(todoTable.id, todoIds), eq(todoTable.userId, userId)))
      : Promise.resolve([]),
    groupIds.length
      ? // Groups carry no userId; ownership goes through their project.
        tx
          .select({ id: groupTable.id, projId: groupTable.projId, sortKey: groupTable.sortKey })
          .from(groupTable)
          .innerJoin(projTable, eq(groupTable.projId, projTable.id))
          .where(and(inArray(groupTable.id, groupIds), eq(projTable.userId, userId)))
      : Promise.resolve([]),
  ]);
  const todoById = new Map(todos.map((t) => [t.id, t]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const created = new Set<string>();

  for (let i = 0; i < orderRows.length; i++) {
    const entry = orderRows[i];
    const idx = entry.startAtIndex ?? i;

    if (entry.kind === "todo") {
      const todo = todoById.get(entry.rowId);
      if (!todo) {
        if (!entry.createHere) continue;
        const data = editRows[entry.rowId];
        const fields = data?.kind === "todo" ? data : undefined;
        const inserted = await tx
          .insert(todoTable)
          .values({
            id: entry.rowId,
            userId,
            placement: "project",
            projId,
            sortKey: idx,
            title: fields?.title ?? "",
            note: fields?.note ?? "",
            done: fields?.done ?? false,
            planned: fields?.planned ?? null,
          })
          .onConflictDoNothing() // id taken by a foreign row — skip
          .returning({ id: todoTable.id });
        if (inserted.length === 0) continue;
        created.add(entry.rowId);
        await tx.insert(todoUpdateLog).values({
          userId,
          todoId: entry.rowId,
          placement: "project",
          projId,
          update: "enter",
          createdAtSeq: seq,
        });
        continue;
      }

      const scopeChanged = todo.placement !== "project" || todo.projId !== projId;
      if (!scopeChanged && todo.sortKey === idx) continue;
      if (scopeChanged) {
        // Arriving from another project or a placement view: exit its old
        // scope so clients watching that scope see it leave.
        await tx.insert(todoUpdateLog).values({
          userId,
          todoId: entry.rowId,
          placement: todo.placement,
          projId: todo.projId,
          update: "exit",
          createdAtSeq: seq,
        });
      }
      await tx
        .update(todoTable)
        .set({ sortKey: idx, projId, placement: "project" })
        .where(eq(todoTable.id, entry.rowId));
      await tx.insert(todoUpdateLog).values({
        userId,
        todoId: entry.rowId,
        placement: "project",
        projId,
        update: scopeChanged ? "enter" : "position",
        createdAtSeq: seq,
      });
    } else {
      const group = groupById.get(entry.rowId);
      if (!group) {
        if (!entry.createHere) continue;
        const data = editRows[entry.rowId];
        const label = data?.kind === "group" ? (data.label ?? "") : "";
        const inserted = await tx
          .insert(groupTable)
          .values({ id: entry.rowId, projId, label, sortKey: idx })
          .onConflictDoNothing()
          .returning({ id: groupTable.id });
        if (inserted.length === 0) continue;
        created.add(entry.rowId);
        await tx.insert(groupUpdateLog).values({
          userId,
          groupId: entry.rowId,
          projId,
          update: "enter",
          createdAtSeq: seq,
        });
        continue;
      }

      const scopeChanged = group.projId !== projId;
      if (!scopeChanged && group.sortKey === idx) continue;
      if (scopeChanged) {
        await tx.insert(groupUpdateLog).values({
          userId,
          groupId: entry.rowId,
          projId: group.projId,
          update: "exit",
          createdAtSeq: seq,
        });
      }
      await tx
        .update(groupTable)
        .set({ sortKey: idx, projId })
        .where(eq(groupTable.id, entry.rowId));
      await tx.insert(groupUpdateLog).values({
        userId,
        groupId: entry.rowId,
        projId,
        update: scopeChanged ? "enter" : "position",
        createdAtSeq: seq,
      });
    }
  }

  return created;
}

// ─── projsArrange (active project list) ──────────────────────────────────────

async function applyProjsArrange(
  tx: Tx,
  userId: string,
  arrange: NonNullable<PushBody["projsArrange"]>,
  seq: number,
): Promise<void> {
  const ids = arrange.orderProjs.map((e) => e.projId);
  const projs = ids.length
    ? await tx
        .select({ id: projTable.id, placement: projTable.placement, sortKey: projTable.sortKey })
        .from(projTable)
        .where(and(inArray(projTable.id, ids), eq(projTable.userId, userId)))
    : [];
  const projById = new Map(projs.map((p) => [p.id, p]));

  for (let i = 0; i < arrange.orderProjs.length; i++) {
    const entry = arrange.orderProjs[i];
    const idx = entry.startAtIndex ?? i;
    const proj = projById.get(entry.projId);
    if (!proj) continue;

    // A project appearing in the list order that wasn't in the list is a
    // restore from archive/trash; its rows kept placement="project" the whole
    // time, so flipping the proj back to "list" is all that's needed.
    const scopeChanged = proj.placement !== "list";
    if (!scopeChanged && proj.sortKey === idx) continue;
    if (scopeChanged) {
      await tx.insert(projUpdateLog).values({
        userId,
        projId: entry.projId,
        placement: proj.placement,
        update: "exit",
        createdAtSeq: seq,
      });
    }
    await tx
      .update(projTable)
      .set({ sortKey: idx, placement: "list" })
      .where(eq(projTable.id, entry.projId));
    await tx.insert(projUpdateLog).values({
      userId,
      projId: entry.projId,
      placement: "list",
      update: scopeChanged ? "enter" : "position",
      createdAtSeq: seq,
    });
  }
}

// ─── projDelete ───────────────────────────────────────────────────────────────

async function applyProjDelete(tx: Tx, userId: string, projId: string, seq: number): Promise<void> {
  const [proj] = await tx
    .select({ placement: projTable.placement })
    .from(projTable)
    .where(and(eq(projTable.id, projId), eq(projTable.userId, userId)));
  if (!proj) return;

  // Cascade: checks → todos → groups → the proj itself, logging exits so other
  // clients drop them. Includes todos merely associated (archived/trashed with
  // this projId), matching the FK that would otherwise dangle.
  const todos = await tx
    .select({ id: todoTable.id, placement: todoTable.placement, projId: todoTable.projId })
    .from(todoTable)
    .where(and(eq(todoTable.projId, projId), eq(todoTable.userId, userId)));

  if (todos.length > 0) {
    const todoById = new Map(todos.map((t) => [t.id, t]));
    const todoIds = [...todoById.keys()];
    const checks = await tx
      .select({ id: checkTable.id, todoId: checkTable.todoId })
      .from(checkTable)
      .where(inArray(checkTable.todoId, todoIds));
    for (const c of checks) {
      const todo = todoById.get(c.todoId)!;
      await tx.insert(checkUpdateLog).values({
        userId,
        checkId: c.id,
        todoId: todo.id,
        placement: todo.placement,
        projId: todo.projId,
        update: "exit",
        createdAtSeq: seq,
      });
    }
    await tx.delete(checkTable).where(inArray(checkTable.todoId, todoIds));

    for (const t of todos) {
      await tx.insert(todoUpdateLog).values({
        userId,
        todoId: t.id,
        placement: t.placement,
        projId: t.projId,
        update: "exit",
        createdAtSeq: seq,
      });
    }
    await tx.delete(todoTable).where(inArray(todoTable.id, todoIds));
  }

  const groups = await tx
    .select({ id: groupTable.id })
    .from(groupTable)
    .where(eq(groupTable.projId, projId));
  for (const g of groups) {
    await tx.insert(groupUpdateLog).values({
      userId,
      groupId: g.id,
      projId,
      update: "exit",
      createdAtSeq: seq,
    });
  }
  if (groups.length > 0) {
    await tx.delete(groupTable).where(eq(groupTable.projId, projId));
  }

  await tx.insert(projUpdateLog).values({
    userId,
    projId,
    placement: proj.placement,
    update: "exit",
    createdAtSeq: seq,
  });
  await tx.delete(projTable).where(and(eq(projTable.id, projId), eq(projTable.userId, userId)));
}

// ─── Placement arranges (archive / trash / inbox) ─────────────────────────────
// The slice lists entries newly arriving in the placement (createHere); entries
// without createHere are untouched context and skipped. Each arrival takes the
// next per-placement sort counter, so slice order → chronological order.

async function applyPlacementArrange(
  tx: Tx,
  userId: string,
  placement: "archive" | "trash",
  slice: NonNullable<PushBody["archiveArrange"]>["slice"],
  counters: SortCounters,
  seq: number,
): Promise<void> {
  for (const entry of slice) {
    if (!entry.createHere) continue;
    const sortKey = ++counters[placement];
    if (entry.kind === "proj") {
      await moveProjToPlacement(tx, userId, entry.projId, placement, sortKey, seq);
    } else {
      await enterPlacementTodo(
        tx,
        userId,
        entry.todoId,
        placement,
        entry.associateProjId,
        sortKey,
        entry.data,
        seq,
      );
    }
  }
}

async function applyInboxArrange(
  tx: Tx,
  userId: string,
  slice: NonNullable<PushBody["inboxArrange"]>["slice"],
  counters: SortCounters,
  seq: number,
): Promise<void> {
  for (const entry of slice) {
    if (!entry.createHere) continue;
    const sortKey = ++counters.inbox;
    await enterPlacementTodo(
      tx,
      userId,
      entry.todoId,
      "inbox",
      undefined,
      sortKey,
      entry.data,
      seq,
    );
  }
}

// Move an existing proj into archive/trash. Its rows keep placement="project"
// and just ride along.
async function moveProjToPlacement(
  tx: Tx,
  userId: string,
  projId: string,
  placement: "archive" | "trash",
  sortKey: number,
  seq: number,
): Promise<void> {
  const [proj] = await tx
    .select({ placement: projTable.placement })
    .from(projTable)
    .where(and(eq(projTable.id, projId), eq(projTable.userId, userId)));
  if (!proj) return;

  await tx.insert(projUpdateLog).values({
    userId,
    projId,
    placement: proj.placement,
    update: "exit",
    createdAtSeq: seq,
  });
  await tx.update(projTable).set({ placement, sortKey }).where(eq(projTable.id, projId));
  await tx.insert(projUpdateLog).values({
    userId,
    projId,
    placement,
    update: "enter",
    createdAtSeq: seq,
  });
}

// Land a todo in a placement view: move it there if the server knows it,
// otherwise INSERT it from the inline `data` (a brand-new todo created directly
// in the placement — e.g. Space in the inbox, or the sign-up migration).
// `associateProjId` — for archive/trash, the project the todo belonged to at
// archive time (kept for display); the inbox always clears the association.
async function enterPlacementTodo(
  tx: Tx,
  userId: string,
  todoId: string,
  placement: "inbox" | "archive" | "trash",
  associateProjId: string | undefined,
  sortKey: number,
  data: PlacementTodoData,
  seq: number,
): Promise<void> {
  const [todo] = await tx
    .select({ projId: todoTable.projId, placement: todoTable.placement })
    .from(todoTable)
    .where(and(eq(todoTable.id, todoId), eq(todoTable.userId, userId)));

  if (!todo) {
    await createPlacementTodo(
      tx,
      userId,
      todoId,
      placement,
      associateProjId ?? null,
      sortKey,
      data,
      seq,
    );
    return;
  }

  const projId = placement === "inbox" ? null : (associateProjId ?? todo.projId);
  await tx.insert(todoUpdateLog).values({
    userId,
    todoId,
    placement: todo.placement,
    projId: todo.projId,
    update: "exit",
    createdAtSeq: seq,
  });
  await tx.update(todoTable).set({ placement, sortKey, projId }).where(eq(todoTable.id, todoId));
  await tx.insert(todoUpdateLog).values({
    userId,
    todoId,
    placement,
    projId,
    update: "enter",
    createdAtSeq: seq,
  });
}

type PlacementTodoData =
  | {
      title?: string;
      note?: string;
      done?: boolean;
      planned?: string | null;
      checks?: { id: string; content: string; ticked: boolean }[];
    }
  | undefined;

// INSERT a brand-new todo (and its checks, in array order) directly into a
// placement view.
async function createPlacementTodo(
  tx: Tx,
  userId: string,
  todoId: string,
  placement: "inbox" | "archive" | "trash",
  projId: string | null,
  sortKey: number,
  data: PlacementTodoData,
  seq: number,
): Promise<void> {
  const inserted = await tx
    .insert(todoTable)
    .values({
      id: todoId,
      userId,
      placement,
      projId,
      sortKey,
      title: data?.title ?? "",
      note: data?.note ?? "",
      done: data?.done ?? false,
      planned: data?.planned ?? null,
    })
    .onConflictDoNothing() // id taken by a foreign row — skip
    .returning({ id: todoTable.id });
  if (inserted.length === 0) return;
  await tx.insert(todoUpdateLog).values({
    userId,
    todoId,
    placement,
    projId,
    update: "enter",
    createdAtSeq: seq,
  });
  const checks = data?.checks ?? [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const insertedCheck = await tx
      .insert(checkTable)
      .values({ id: c.id, todoId, sortKey: i, content: c.content, ticked: c.ticked })
      .onConflictDoNothing()
      .returning({ id: checkTable.id });
    if (insertedCheck.length === 0) continue;
    await tx.insert(checkUpdateLog).values({
      userId,
      checkId: c.id,
      todoId,
      placement,
      projId,
      update: "enter",
      createdAtSeq: seq,
    });
  }
}

// ─── Todo/check edits ─────────────────────────────────────────────────────────

type TodoEdit = {
  title?: string;
  note?: string;
  done?: boolean;
  planned?: string | null;
  editChecks?: Record<string, { content?: string; ticked?: boolean }>;
  orderChecks?: { checkId: string; startAtIndex?: number; createHere?: boolean }[];
  deleteChecks?: string[];
};

// Apply field edits and check ops to an existing todo, logging into the todo's
// CURRENT scope. No-op (returns null) when the todo doesn't exist or isn't the
// user's. Returns the todo's projId so the caller can mark the scope touched.
async function applyTodoEditAndChecks(
  tx: Tx,
  userId: string,
  todoId: string,
  edit: TodoEdit,
  seq: number,
  opts?: { skipFields?: boolean },
): Promise<string | null> {
  const [todo] = await tx
    .select({ projId: todoTable.projId, placement: todoTable.placement })
    .from(todoTable)
    .where(and(eq(todoTable.id, todoId), eq(todoTable.userId, userId)));
  if (!todo) return null;

  if (!opts?.skipFields) {
    const patch: Partial<{ title: string; note: string; done: boolean; planned: string | null }> =
      {};
    if (edit.title !== undefined) patch.title = edit.title;
    if (edit.note !== undefined) patch.note = edit.note;
    if (edit.done !== undefined) patch.done = edit.done;
    if (edit.planned !== undefined) patch.planned = edit.planned;
    const fields = Object.keys(patch) as ("title" | "note" | "done" | "planned")[];
    if (fields.length > 0) {
      await tx.update(todoTable).set(patch).where(eq(todoTable.id, todoId));
      for (const field of fields) {
        await tx.insert(todoUpdateLog).values({
          userId,
          todoId,
          placement: todo.placement,
          projId: todo.projId,
          update: field,
          createdAtSeq: seq,
        });
      }
    }
  }

  await applyCheckOps(tx, userId, todoId, todo.placement, todo.projId, edit, seq);
  return todo.projId;
}

async function applyGroupEdit(
  tx: Tx,
  userId: string,
  groupId: string,
  edit: { label?: string },
  seq: number,
): Promise<void> {
  if (edit.label === undefined) return;
  // Groups carry no userId; verify ownership through their project.
  const [group] = await tx
    .select({ projId: groupTable.projId })
    .from(groupTable)
    .innerJoin(projTable, eq(groupTable.projId, projTable.id))
    .where(and(eq(groupTable.id, groupId), eq(projTable.userId, userId)));
  if (!group) return;
  await tx.update(groupTable).set({ label: edit.label }).where(eq(groupTable.id, groupId));
  await tx.insert(groupUpdateLog).values({
    userId,
    groupId,
    projId: group.projId,
    update: "label",
    createdAtSeq: seq,
  });
}

// All check mutations for a todo in one pass:
//   - deletes: explicit deleteChecks, plus any check absent from orderChecks
//     (orderChecks is always the COMPLETE desired list when present)
//   - INSERTs createHere checks (field data from editChecks)
//   - UPDATEs existing check fields from editChecks
//   - sets sortKeys per orderChecks, logging "position" only on actual change
// The caller has already verified todo ownership; placement/projId are the
// todo's current scope for the log rows.
async function applyCheckOps(
  tx: Tx,
  userId: string,
  todoId: string,
  placement: TodoPlacement,
  projId: string | null,
  ops: Pick<TodoEdit, "editChecks" | "orderChecks" | "deleteChecks">,
  seq: number,
): Promise<void> {
  const { editChecks, orderChecks, deleteChecks } = ops;
  if (!editChecks && !orderChecks && !deleteChecks?.length) return;

  const existing = await tx
    .select({ id: checkTable.id, sortKey: checkTable.sortKey })
    .from(checkTable)
    .where(eq(checkTable.todoId, todoId));
  const existingById = new Map(existing.map((c) => [c.id, c]));

  // ── Deletes ────────────────────────────────────────────────────────────────
  const toDelete = new Set((deleteChecks ?? []).filter((id) => existingById.has(id)));
  if (orderChecks) {
    const orderedIds = new Set(orderChecks.map((e) => e.checkId));
    for (const c of existing) {
      if (!orderedIds.has(c.id)) toDelete.add(c.id);
    }
  }
  for (const checkId of toDelete) {
    await tx.insert(checkUpdateLog).values({
      userId,
      checkId,
      todoId,
      placement,
      projId,
      update: "exit",
      createdAtSeq: seq,
    });
  }
  if (toDelete.size > 0) {
    await tx.delete(checkTable).where(inArray(checkTable.id, [...toDelete]));
    for (const id of toDelete) existingById.delete(id);
  }

  // ── Creations + orderings ──────────────────────────────────────────────────
  const created = new Set<string>();
  if (orderChecks) {
    for (let i = 0; i < orderChecks.length; i++) {
      const entry = orderChecks[i];
      const idx = entry.startAtIndex ?? i;
      const current = existingById.get(entry.checkId);

      if (!current) {
        // Unknown check: INSERT if the client marked it a creation and sent
        // field data; otherwise it's a stale/foreign reference — skip.
        if (!entry.createHere) continue;
        const data = editChecks?.[entry.checkId];
        if (!data) continue;
        const inserted = await tx
          .insert(checkTable)
          .values({
            id: entry.checkId,
            todoId,
            sortKey: idx,
            content: data.content ?? "",
            ticked: data.ticked ?? false,
          })
          .onConflictDoNothing()
          .returning({ id: checkTable.id });
        if (inserted.length === 0) continue;
        created.add(entry.checkId);
        await tx.insert(checkUpdateLog).values({
          userId,
          checkId: entry.checkId,
          todoId,
          placement,
          projId,
          update: "enter",
          createdAtSeq: seq,
        });
        continue;
      }

      if (current.sortKey !== idx) {
        await tx.update(checkTable).set({ sortKey: idx }).where(eq(checkTable.id, entry.checkId));
        await tx.insert(checkUpdateLog).values({
          userId,
          checkId: entry.checkId,
          todoId,
          placement,
          projId,
          update: "position",
          createdAtSeq: seq,
        });
      }
    }
  }

  // ── Field edits for existing checks ────────────────────────────────────────
  for (const [checkId, data] of Object.entries(editChecks ?? {})) {
    if (created.has(checkId) || !existingById.has(checkId)) continue;
    const patch: Partial<{ content: string; ticked: boolean }> = {};
    if (data.content !== undefined) patch.content = data.content;
    if (data.ticked !== undefined) patch.ticked = data.ticked;
    const fields = Object.keys(patch) as ("content" | "ticked")[];
    if (fields.length === 0) continue;
    await tx.update(checkTable).set(patch).where(eq(checkTable.id, checkId));
    for (const field of fields) {
      await tx.insert(checkUpdateLog).values({
        userId,
        checkId,
        todoId,
        placement,
        projId,
        update: field,
        createdAtSeq: seq,
      });
    }
  }
}

// ─── Deletes / move-out ───────────────────────────────────────────────────────

// Hard-delete a todo (cascading its checks), logging exits in the todo's
// current scope. Returns the todo's projId (scope to refresh), or null when
// the todo doesn't exist — a re-sent delete is a clean no-op.
async function deleteTodo(
  tx: Tx,
  userId: string,
  todoId: string,
  seq: number,
): Promise<string | null> {
  const [todo] = await tx
    .select({ projId: todoTable.projId, placement: todoTable.placement })
    .from(todoTable)
    .where(and(eq(todoTable.id, todoId), eq(todoTable.userId, userId)));
  if (!todo) return null;

  const checks = await tx
    .select({ id: checkTable.id })
    .from(checkTable)
    .where(eq(checkTable.todoId, todoId));
  for (const c of checks) {
    await tx.insert(checkUpdateLog).values({
      userId,
      checkId: c.id,
      todoId,
      placement: todo.placement,
      projId: todo.projId,
      update: "exit",
      createdAtSeq: seq,
    });
  }
  if (checks.length > 0) {
    await tx.delete(checkTable).where(eq(checkTable.todoId, todoId));
  }
  await tx.insert(todoUpdateLog).values({
    userId,
    todoId,
    placement: todo.placement,
    projId: todo.projId,
    update: "exit",
    createdAtSeq: seq,
  });
  await tx.delete(todoTable).where(eq(todoTable.id, todoId));
  return todo.projId;
}

// Hard-delete a group. Groups carry no userId; ownership goes through their
// project. Missing/foreign groups are a clean no-op.
async function deleteGroup(tx: Tx, userId: string, groupId: string, seq: number): Promise<void> {
  const [group] = await tx
    .select({ projId: groupTable.projId })
    .from(groupTable)
    .innerJoin(projTable, eq(groupTable.projId, projTable.id))
    .where(and(eq(groupTable.id, groupId), eq(projTable.userId, userId)));
  if (!group) return;

  await tx.insert(groupUpdateLog).values({
    userId,
    groupId,
    projId: group.projId,
    update: "exit",
    createdAtSeq: seq,
  });
  await tx.delete(groupTable).where(eq(groupTable.id, groupId));
}

// Move a todo out of its project into the inbox (projUpdate.moveOutRows).
async function moveTodoToInbox(
  tx: Tx,
  userId: string,
  todoId: string,
  counters: SortCounters,
  seq: number,
): Promise<void> {
  const [todo] = await tx
    .select({ projId: todoTable.projId, placement: todoTable.placement })
    .from(todoTable)
    .where(and(eq(todoTable.id, todoId), eq(todoTable.userId, userId)));
  if (!todo) return;

  await tx.insert(todoUpdateLog).values({
    userId,
    todoId,
    placement: todo.placement,
    projId: todo.projId,
    update: "exit",
    createdAtSeq: seq,
  });
  await tx
    .update(todoTable)
    .set({ placement: "inbox", projId: null, sortKey: ++counters.inbox })
    .where(eq(todoTable.id, todoId));
  await tx.insert(todoUpdateLog).values({
    userId,
    todoId,
    placement: "inbox",
    projId: null,
    update: "enter",
    createdAtSeq: seq,
  });
}
