import {
  isTodoItem,
  isProjectInstance,
  isPlacementInstance,
  newPanelItem,
  newProjectInstance,
  newPlacementInstance,
  operationToInstance,
  drilledFrom,
  projOf,
  type AppState,
  type Instance,
  type OperationInstance,
  type PanelLayout,
} from "$lib/client/model";
import { createMutator, getPanelContext, getProjContext } from "./context";
import { getProjectInstance, normalizeIds, pruneDrillIns } from "./utils";
import { signedIn } from "./session.svelte";
import { clearCheckSelection } from "./check-selection";

const MAX_PANEL_COUNT = 3;

export const useUpdateLayout = createMutator(
  getPanelContext,
  (state, ctx, data: Partial<PanelLayout>) => {
    const { panelId } = ctx;
    const layout = state.panels.find((p) => p.id === panelId)?.layout;
    if (layout == null) return;
    Object.assign(
      layout,
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    );
  },
);

export const useSetRowSelected = createMutator(
  () => ({ ...getPanelContext(), ...getProjContext() }),
  (state, ctx, rowIds: string | Set<string> | null) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    const selected: Record<string, boolean> = {};
    for (const rowId of normalizeIds(rowIds)) {
      selected[rowId] = true;
    }
    instance.rowSelected = selected;
    // Row and check selections are exclusive: selecting rows drops any
    // selected checks (the reverse lives in useClearRowSelections).
    if (Object.keys(selected).length > 0) clearCheckSelection();
  },
);

export const useSelectRow = createMutator(
  () => ({ ...getPanelContext(), ...getProjContext() }),
  (state, ctx, rowIds: string | Set<string>) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    const ids = normalizeIds(rowIds);
    for (const rowId of ids) {
      instance.rowSelected[rowId] = true;
    }
    if (ids.size > 0) clearCheckSelection();
  },
);

// Selecting checks (in a CheckList) clears every row selection — project rows
// and placement entries alike — so a visible check selection is never
// shadowed by a row selection when Delete/Backspace fires. The reverse
// direction lives in the row-selection mutators, which clearCheckSelection.
export const useClearRowSelections = createMutator(
  () => null,
  (state) => {
    for (const { instance } of state.panels) {
      if (isProjectInstance(instance)) instance.rowSelected = {};
      else if (isPlacementInstance(instance)) instance.selected = new Set();
    }
  },
);

export const useUnselectRow = createMutator(
  () => ({ ...getPanelContext(), ...getProjContext() }),
  (state, ctx, rowIds: string | Set<string>) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    for (const rowId of normalizeIds(rowIds)) {
      delete instance.rowSelected[rowId];
    }
  },
);

export const useSetTodoExpanded = createMutator(
  () => ({ ...getPanelContext(), ...getProjContext() }),
  (state, ctx, rowIds: string | Set<string>) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    const expanded: Record<string, boolean> = {};
    for (const rowId of normalizeIds(rowIds)) {
      const row = instance.project.rows.find(({ id }) => id === rowId);
      if (row && isTodoItem(row)) {
        expanded[rowId] = true;
      }
    }
    instance.todoExpanded = expanded;
  },
);

export const useExpandTodo = createMutator(
  () => ({ ...getPanelContext(), ...getProjContext() }),
  (state, ctx, rowIds: string | Set<string>) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    for (const rowId of normalizeIds(rowIds)) {
      const row = instance.project.rows.find(({ id }) => id === rowId);
      if (row && isTodoItem(row)) {
        instance.todoExpanded[rowId] = true;
      }
    }
  },
);

export const useUnexpandTodo = createMutator(
  () => ({ ...getPanelContext(), ...getProjContext() }),
  (state, ctx, rowIds: string | string[]) => {
    const instance = getProjectInstance(state, ctx);
    if (instance == null) return;
    for (const rowId of normalizeIds(rowIds)) {
      delete instance.todoExpanded[rowId];
    }
  },
);

export const useClosePanel = createMutator(getPanelContext, (state, ctx) => {
  const panelIndex = state.panels.findIndex(({ id }) => id === ctx.panelId);
  if (panelIndex <= 0) return;
  if (state.panels.length <= 1) return;
  state.panels.splice(panelIndex, 1);
  pruneDrillIns(state);
});

export const useClonePanel = createMutator(getPanelContext, (state, ctx) => {
  const panelIndex = state.panels.findIndex(({ id }) => id === ctx.panelId);
  if (panelIndex === -1) return;
  const { layout, instance } = state.panels[panelIndex];
  const spacerLeft = state.panels.at(panelIndex + 1)?.layout.spacerLeft ?? undefined;
  if (state.panels.length >= MAX_PANEL_COUNT) {
    state.panels.splice(state.panels.length - 1, 1);
  }
  const { height } = layout;
  // Inherit the source panel's height, but give the new panel a default width.
  // spacerLeft inherits the gap that preceded the original next panel (default
  // when there was none).
  state.panels.splice(
    panelIndex + 1,
    0,
    newPanelItem({
      layout: { height, spacerLeft },
      instance: isProjectInstance(instance)
        ? newProjectInstance({ project: instance.project })
        : isPlacementInstance(instance)
          ? newPlacementInstance(instance.kind)
          : instance,
    }),
  );
});

export const useSetProjInPanel = createMutator(getPanelContext, (state, ctx, projId: string) => {
  const panel = state.panels.find(({ id }) => id === ctx.panelId);
  if (panel == null) return;
  const project = projOf(state, projId);
  if (project == null) return;
  panel.instance = newProjectInstance({ project });
  pruneDrillIns(state);
});

// Open a project or operation in a fresh panel inserted right after this one,
// instead of replacing this panel's instance (see useSetProjInPanel /
// useSetOperationInPanel). Mirrors useClonePanel's layout inheritance: keep this
// panel's height, take a default width, and inherit the gap that preceded the
// original next panel.
export const useOpenInNewPanel = createMutator(
  getPanelContext,
  (state, ctx, target: { projId: string } | { op: OperationInstance }) => {
    const panelIndex = state.panels.findIndex(({ id }) => id === ctx.panelId);
    if (panelIndex === -1) return;
    // Resolve what to open before mutating panels, so a missing project bails
    // out without having evicted anything. Projects resolve by id to the
    // reactive object in state (like useSetProjInPanel); operations don't.
    let instance: Instance;
    if ("projId" in target) {
      const project = projOf(state, target.projId);
      if (project == null) return;
      instance = newProjectInstance({ project });
    } else {
      instance = operationToInstance(target.op);
    }
    const { height } = state.panels[panelIndex].layout;
    const spacerLeft = state.panels.at(panelIndex + 1)?.layout.spacerLeft ?? undefined;
    if (state.panels.length >= MAX_PANEL_COUNT) {
      state.panels.splice(state.panels.length - 1, 1);
    }
    state.panels.splice(
      panelIndex + 1,
      0,
      newPanelItem({ layout: { height, spacerLeft }, instance }),
    );
  },
);

export const useSetOperationInPanel = createMutator(
  getPanelContext,
  (state, ctx, instance: OperationInstance) => {
    const panel = state.panels.find(({ id }) => id === ctx.panelId);
    if (panel == null) return;
    panel.instance = operationToInstance(instance);
    pruneDrillIns(state);
  },
);

// ─── Placement-project drill-in ──────────────────────────────────────────────
// Open a project living in a placement view (archive/trash) as a normal,
// fully-editable project page in this panel. Its projs entry may already exist
// (signed out it always does, with its full rows; signed in when another panel
// has it open) — otherwise register a name-only entry. Signed in that entry is
// unloaded, so the panel shows the "Back to …" bar + a Loading… placeholder
// while the lazy loader fetches its rows; signed out there is nothing to fetch
// and the entry opens as-is. The entry's placement keeps it out of the active
// list and tells "back" which view to return to.

const ensurePlacementProj = (
  state: AppState,
  projId: string,
  name: string,
  placement: "archive" | "trash",
) => {
  if (!state.projs[projId]) {
    state.projs[projId] = {
      project: { id: projId, name, note: "", rows: [] },
      placement,
      loaded: !signedIn(),
    };
  }
  return state.projs[projId].project;
};

export const useOpenPlacementProject = createMutator(
  getPanelContext,
  (state, ctx, projId: string, name: string, placement: "archive" | "trash") => {
    const panel = state.panels.find(({ id }) => id === ctx.panelId);
    if (panel == null) return;
    panel.instance = newProjectInstance({
      project: ensurePlacementProj(state, projId, name, placement),
    });
  },
);

// Same drill-in, but into a fresh panel inserted right after this one, leaving
// this placement view in place — the popup counterpart of useOpenInNewPanel,
// with the same layout inheritance.
export const useOpenPlacementProjectInNewPanel = createMutator(
  getPanelContext,
  (state, ctx, projId: string, name: string, placement: "archive" | "trash") => {
    const panelIndex = state.panels.findIndex(({ id }) => id === ctx.panelId);
    if (panelIndex === -1) return;
    const project = ensurePlacementProj(state, projId, name, placement);
    const { height } = state.panels[panelIndex].layout;
    const spacerLeft = state.panels.at(panelIndex + 1)?.layout.spacerLeft ?? undefined;
    if (state.panels.length >= MAX_PANEL_COUNT) {
      state.panels.splice(state.panels.length - 1, 1);
    }
    state.panels.splice(
      panelIndex + 1,
      0,
      newPanelItem({ layout: { height, spacerLeft }, instance: newProjectInstance({ project }) }),
    );
  },
);

export const useExitPlacementProject = createMutator(getPanelContext, (state, ctx) => {
  const panel = state.panels.find(({ id }) => id === ctx.panelId);
  if (panel == null || !isProjectInstance(panel.instance)) return;
  const projId = panel.instance.project.id;
  const placement = drilledFrom(state, projId) ?? "trash";
  // Return to the placement view with the project row we drilled into preselected
  // so the view can reveal it (as if arrow-navigated to), instead of rendering
  // fresh. Harmless if the row was purged meanwhile — it just matches nothing.
  panel.instance = newPlacementInstance(placement, new Set([projId]));
  pruneDrillIns(state);
});

// Placement view (inbox/archive/trash) row UI state lives on the panel's
// instance, so it is per-panel and dies when the instance is replaced. These
// mutators replace the whole selection / expanded id; callers compute the next
// value from the (read-only) instance prop.
export const useSetPlacementSelected = createMutator(
  getPanelContext,
  (state, ctx, selected: Set<string>) => {
    const panel = state.panels.find(({ id }) => id === ctx.panelId);
    if (panel == null || !isPlacementInstance(panel.instance)) return;
    panel.instance.selected = selected;
    // Same exclusivity rule as useSetRowSelected: entries or checks, not both.
    if (selected.size > 0) clearCheckSelection();
  },
);

export const useSetPlacementExpanded = createMutator(
  getPanelContext,
  (state, ctx, expandedId: string | null) => {
    const panel = state.panels.find(({ id }) => id === ctx.panelId);
    if (panel == null || !isPlacementInstance(panel.instance)) return;
    panel.instance.expandedId = expandedId;
  },
);

// Cloud / account button: if a panel is already showing the account op,
// nothing to do. Otherwise open a new panel for it (evicting the oldest
// non-main panel if we'd exceed MAX_PANEL_COUNT).
export const useOpenAccountPanel = createMutator(
  () => null,
  (state) => {
    const existIdx = state.panels.findIndex((p) => p.instance === "account");
    if (existIdx >= 0) {
      state.panels.splice(existIdx, 1);
    }
    if (state.panels.length >= MAX_PANEL_COUNT) {
      // Drop the last non-main panel to make room.
      state.panels.splice(state.panels.length - 1, 1);
    }
    const { height } = state.panels[0].layout;
    // Inherit the first panel's height, default the width, and inherit the gap
    // that preceded the original second panel (default when there was none).
    const spacerLeft = state.panels.at(1)?.layout.spacerLeft ?? undefined;
    state.panels.splice(
      1,
      0,
      newPanelItem({
        instance: "account",
        layout: { height, spacerLeft },
      }),
    );
  },
);
