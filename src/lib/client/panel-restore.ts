// Rebuilding the open panels on page load: from the panel-composition cookie
// (SSR + first client render) and from localStorage (per-row UI overlay /
// fallback when the two drifted). Pure panel builders — the page component
// owns the $state they mutate.

import {
  isPlacementInstance,
  isProjectInstance,
  newPanelItem,
  newPlacementInstance,
  newProjectInstance,
  type AppState,
  type ArchiveProjEntry,
  type Instance,
  type PanelItem,
  type ProjectItem,
} from "./model";
import type { PanelComposition } from "./panel-comp";
import type { StoredPanelData } from "./panels-storage";
import { syncStatus } from "./sync.svelte";

// Stable id for the default main panel so its SSR and hydration `{#each}` keys
// match (a random id would differ between the two renders). Composition-built
// panels carry their own ids from the cookie.
export const MAIN_PANEL_ID = "main-panel";

export const makeMainPanel = (projs: ProjectItem[]): PanelItem => {
  const instance: Instance =
    projs.length > 0 ? newProjectInstance({ project: projs[0] }) : newPlacementInstance("inbox");
  return newPanelItem({
    id: MAIN_PANEL_ID,
    instance,
    layout: { sideShow: true, sideWidth: 200, spacerLeft: "disabled" },
  });
};

// Rebuild the open panels from the cookie composition (signed-in SSR + first
// client render, so they agree and hydrate cleanly). Per-row UI state isn't in
// the composition — it's overlaid from localStorage at hydration. Each project
// panel resolves its project from the bootstrapped list; a project the server
// couldn't prefetch (deleted / stale cookie) falls back to its origin placement
// view, else the panel is dropped — mirroring loadPanels.
export const panelsFromComposition = (
  comp: PanelComposition,
  projs: ProjectItem[],
): PanelItem[] => {
  const byId = new Map(projs.map((p) => [p.id, p] as const));
  const out: PanelItem[] = [];
  for (const e of comp) {
    const c = e.content;
    if (c.t === "operation") {
      out.push(newPanelItem({ id: e.id, layout: e.layout, instance: c.op }));
    } else if (c.t === "placement") {
      out.push(
        newPanelItem({ id: e.id, layout: e.layout, instance: newPlacementInstance(c.name) }),
      );
    } else {
      const project = byId.get(c.projectId);
      if (project) {
        out.push(
          newPanelItem({ id: e.id, layout: e.layout, instance: newProjectInstance({ project }) }),
        );
      } else if (c.placement) {
        out.push(
          newPanelItem({ id: e.id, layout: e.layout, instance: newPlacementInstance(c.placement) }),
        );
      }
    }
  }
  return out;
};

export const ensureMainData = (
  data: StoredPanelData[],
  projs: ProjectItem[],
): StoredPanelData[] => {
  if (data.length === 0 || data[0].instance === "account") {
    const main = makeMainPanel(projs);
    return [{ layout: main.layout, instance: main.instance }, ...data];
  }
  return data;
};

export const applyStoredPanels = (panels: PanelItem[], stored: StoredPanelData[]) => {
  while (panels.length > stored.length) panels.pop();
  for (let i = 0; i < Math.min(panels.length, stored.length); i++) {
    panels[i].instance = stored[i].instance;
    Object.assign(panels[i].layout, stored[i].layout);
  }
  while (panels.length < stored.length) {
    const d = stored[panels.length];
    panels.push(newPanelItem({ layout: d.layout, instance: d.instance }));
  }
};

// Whether two instances show the same scope (ignoring per-row UI state) — used
// to decide whether the SSR-built panels already match what localStorage holds.
const sameContent = (a: Instance, b: Instance): boolean => {
  if (isProjectInstance(a)) return isProjectInstance(b) && a.project.id === b.project.id;
  if (isPlacementInstance(a)) return isPlacementInstance(b) && a.kind === b.kind;
  return a === b; // simple-operation strings
};

// True when the SSR-rendered panels (built from the cookie) line up with what
// localStorage holds — same count, same scope per slot. The common case: the
// cookie and localStorage are written together so they agree.
export const compositionMatches = (panels: PanelItem[], stored: StoredPanelData[]): boolean =>
  panels.length === stored.length &&
  panels.every((p, i) => sameContent(p.instance, stored[i].instance));

// Overlay the per-row UI state (kept out of the cookie) from localStorage onto
// the already-rendered panels. Reassigns the row-state fields only — not the
// instance object — so the panel view isn't re-keyed/remounted (Panel keys on
// instance identity); the selection/expansion just lights up reactively.
export const overlayRowState = (panels: PanelItem[], stored: StoredPanelData[]) => {
  for (let i = 0; i < panels.length; i++) {
    const inst = panels[i].instance;
    const si = stored[i].instance;
    if (isProjectInstance(inst) && isProjectInstance(si)) {
      inst.rowSelected = si.rowSelected;
      inst.todoExpanded = si.todoExpanded;
    } else if (isPlacementInstance(inst) && isPlacementInstance(si)) {
      inst.selected = si.selected;
      inst.expandedId = si.expandedId;
    }
  }
};

// Re-open projects that were drilled-into from archive/trash. applyStoredPanels
// rendered each as its origin placement view (so layout/indexes stay correct);
// here we register a placeholder project + its placement origin and swap the
// panel to the project view. The project is marked as a stub, so the lazy
// loader fetches its content and the panel shows the loading placeholder until
// it arrives — same path as any other not-yet-loaded project.
export const restorePlacementProjects = (
  appState: AppState,
  panels: PanelItem[],
  stored: StoredPanelData[],
) => {
  for (let i = 0; i < stored.length; i++) {
    const info = stored[i].pendingPlacementProject;
    const panel = panels[i];
    if (info == null || panel == null) continue;
    const list = info.placement === "trash" ? appState.trash : appState.archive;
    const entry = list.find((e) => e.kind === "proj" && e.id === info.projectId) as
      | ArchiveProjEntry
      | undefined;
    // Already present means it was prefetched (cookie hit) — keep it loaded.
    // Otherwise register a placeholder and stub it for the lazy loader.
    if (!appState.projects.some((p) => p.id === info.projectId)) {
      appState.projects.push({ id: info.projectId, name: entry?.name ?? "", note: "", rows: [] });
      // Signed out there is no server to lazy-load from, so don't stub it (a
      // stub would just flash the loading indicator forever); mirrors
      // useOpenPlacementProject.
      if (syncStatus.pinnedUserId != null) appState.projStub[info.projectId] = true;
    }
    appState.openProjPlacement.set(info.projectId, info.placement);
    const project = appState.projects.find((p) => p.id === info.projectId)!;
    if (isPlacementInstance(panel.instance) && panel.instance.kind === info.placement) {
      panel.instance = newProjectInstance({
        project,
        rowSelected: info.rowSelected,
        todoExpanded: info.todoExpanded,
      });
    }
  }
};
