// Converts the server-prefetched bootstrap payload (see ./bootstrap.ts) into
// the client's reactive app-state shapes. Pure helpers — the page component
// wires their results into $state.

import type { PlacementDelta, PlacementTodoEntry, PullCheck } from "$lib/server/sync/types";
import type { BootstrapState } from "./bootstrap";
import type {
  AppState,
  ArchiveEntry,
  ArchiveTodoEntry,
  CheckItem,
  PlacementName,
  ProjEntry,
  TodoItem,
} from "./model";
import { parsePlanned, projectFromDelta, syncedAtSeq } from "./sync.svelte";

// Build the project store from the bootstrap: the active list in order (rows
// present only for the prefetched ones), plus any prefetched drill-in from
// archive/trash (its placement comes from projPlacements).
export const projsFromBootstrap = (
  state: BootstrapState,
): Pick<AppState, "projs" | "projOrder"> => {
  const projs: Record<string, ProjEntry> = {};
  const projOrder: string[] = [];
  for (const entry of state.projList.projects) {
    const delta = state.projContents[entry.id];
    projs[entry.id] = {
      project: delta
        ? projectFromDelta(entry.id, entry.name, entry.note, delta)
        : { id: entry.id, name: entry.name, note: entry.note, rows: [] },
      placement: "list",
      loaded: !!delta,
    };
    projOrder.push(entry.id);
  }
  for (const [projId, delta] of Object.entries(state.projContents)) {
    if (projs[projId]) continue;
    projs[projId] = {
      project: projectFromDelta(
        projId,
        delta.projFields?.name ?? "",
        delta.projFields?.note ?? "",
        delta,
      ),
      placement: state.projPlacements[projId] ?? "archive",
      loaded: true,
    };
  }
  return { projs, projOrder };
};

const checkFromPull = (c: PullCheck): CheckItem => ({
  id: c.id,
  text: c.content,
  ticked: c.ticked,
});

const todoEntryFromPull = (t: PlacementTodoEntry): ArchiveTodoEntry => ({
  kind: "todo",
  id: t.id,
  title: t.title,
  note: t.note,
  done: t.done,
  planned: t.planned,
  projId: t.projId,
  checks: t.checks.map(checkFromPull),
});

export const inboxFromDelta = (delta: PlacementDelta): TodoItem[] =>
  delta.entries
    .filter((e): e is PlacementTodoEntry => e.kind === "todo")
    .map((t) => ({
      id: t.id,
      title: t.title,
      note: t.note,
      status: t.done ? ("complete" as const) : ("todo" as const),
      planned: parsePlanned(t.planned),
      checks: t.checks.map(checkFromPull),
    }));

export const placementFromDelta = (delta: PlacementDelta): ArchiveEntry[] =>
  delta.entries.map((e) =>
    e.kind === "todo" ? todoEntryFromPull(e) : { kind: "proj", id: e.id, name: e.name },
  );

// A placement view is loaded when it was prefetched. Guests have no server
// data at all — everything is local, so nothing ever needs loading.
export const initPlacementLoaded = (
  state: BootstrapState | null | undefined,
): Record<PlacementName, boolean> => ({
  inbox: !state || !!state.inbox,
  archive: !state || !!state.archive,
  trash: !state || !!state.trash,
});

// Seed the per-scope sync sequence numbers from the SSR load so the first push
// sends the right seq.
export const seedSyncedAtSeq = (state: BootstrapState) => {
  syncedAtSeq["projList"] = state.projList.newSeq;
  for (const [projId, delta] of Object.entries(state.projContents)) {
    syncedAtSeq[`proj:${projId}`] = delta.newSeq;
  }
  if (state.inbox) syncedAtSeq["inbox"] = state.inbox.newSeq;
  if (state.archive) syncedAtSeq["archive"] = state.archive.newSeq;
  if (state.trash) syncedAtSeq["trash"] = state.trash.newSeq;
};
