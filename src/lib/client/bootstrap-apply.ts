// Converts the server-prefetched bootstrap payload (see ./bootstrap.ts) into
// the client's reactive app-state shapes. Pure helpers — the page component
// wires their results into $state.

import type { PlacementDelta } from "$lib/server/sync/types";
import type { BootstrapState } from "./bootstrap";
import type { ArchiveEntry, PlacementName, ProjectItem, TodoItem } from "./model";
import { newCheckItem } from "./model";
import { parsePlanned, projectFromDelta, syncedAtSeq } from "./sync.svelte";

export const projectsFromBootstrap = (state: BootstrapState): ProjectItem[] => {
  const projects = state.projList.projects.map((entry) => {
    const delta = state.projContents[entry.id];
    if (!delta) return { id: entry.id, name: entry.name, note: entry.note, rows: [] };
    return projectFromDelta(entry.id, entry.name, entry.note, delta);
  });
  // Projects drilled into from archive/trash were also prefetched but aren't in
  // the active list — build them from their delta (name comes from projFields).
  const activeIds = new Set(state.projList.projects.map((p) => p.id));
  for (const [projId, delta] of Object.entries(state.projContents)) {
    if (activeIds.has(projId)) continue;
    projects.push(
      projectFromDelta(projId, delta.projFields?.name ?? "", delta.projFields?.note ?? "", delta),
    );
  }
  return projects;
};

export const inboxFromDelta = (delta: PlacementDelta): TodoItem[] =>
  delta.entries
    .filter((e) => e.kind === "todo")
    .map((e) => {
      const t = e as {
        kind: "todo";
        id: string;
        title: string;
        note: string;
        done: boolean;
        planned: string | null;
        checks?: { id: string; text: string; ticked: boolean; sortKey: number }[];
      };
      const checks = (t.checks ?? []).map((c) => ({
        ...newCheckItem({ text: c.text, ticked: c.ticked }),
        id: c.id,
      }));
      return {
        id: t.id,
        title: t.title,
        note: t.note,
        status: t.done ? ("complete" as const) : ("todo" as const),
        planned: parsePlanned(t.planned),
        checks,
      };
    });

export const placementFromDelta = (delta: PlacementDelta): ArchiveEntry[] =>
  delta.entries as ArchiveEntry[];

// Projects in the list whose content wasn't prefetched start stubbed (name +
// order known, rows fetched on first open).
export const initProjStub = (state: BootstrapState | null | undefined): Record<string, boolean> => {
  const stub: Record<string, boolean> = {};
  if (state) {
    for (const entry of state.projList.projects) {
      if (!state.projContents[entry.id]) stub[entry.id] = true;
    }
  }
  return stub;
};

// A placement is stubbed when there's a signed-in user but it wasn't
// prefetched. Guests have no placements, so nothing to load (not stubbed).
export const initPlacementStub = (
  state: BootstrapState | null | undefined,
): Record<PlacementName, boolean> => ({
  inbox: !!(state && !state.inbox),
  archive: !!(state && !state.archive),
  trash: !!(state && !state.trash),
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
