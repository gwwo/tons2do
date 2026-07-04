// The signed-in/guest session lifecycle of the SPA: lazy-loading unloaded
// scopes, reacting to auth changes (sign-up / sign-in / sign-out), and the
// manual refresh (push pending, then re-pull). Extracted from +page.svelte —
// the page owns the reactive appState; this module drives it.

import {
  activeProjects,
  isProjectInstance,
  newPanelItem,
  newPlacementInstance,
  newProjectInstance,
  projOf,
  projsFromList,
  type AppState,
  type PlacementName,
  type ProjEntry,
} from "./model";
import {
  applyProjDeltaToProject,
  pullPlacement,
  pullProj,
  pullProjList,
  resetSyncState,
  settle,
  syncStatus,
  uploadInitialState,
} from "./sync.svelte";
import { session } from "./session.svelte";
import { inboxFromDelta, placementFromDelta } from "./bootstrap-apply";
import { freshMockProjects, mockPanels } from "./mock";
import { materializeGuestIds } from "./guest-ids";
import { pruneDrillIns } from "./utils";
import { clearPanels } from "./panels-storage";
import { clearPanelCompCookie } from "./panel-comp";
import { loadMe } from "$lib/components/user-panel/UserPanel.svelte";

export function createAppSession(appState: AppState) {
  // ─── Lazy content loading ───────────────────────────────────────────────────
  // Only the scopes the open panels showed are bootstrapped; every other project
  // / placement starts unloaded and is fetched the first time a panel shows it.
  // The page's panel-watching effect calls these; the view components render a
  // "Loading…" placeholder while their scope loads.

  // Scopes with a fetch in flight, so the effect doesn't kick a second one. The
  // loaded flag flips the instant data arrives; the loading indicator's
  // keep-previous / delay / min-visible timing is handled by Panel.
  const loadingScopes = new Set<string>();

  const ensureProjectLoaded = (projId: string) => {
    const key = `proj:${projId}`;
    if (loadingScopes.has(key)) return;
    loadingScopes.add(key);
    void (async () => {
      // Full fetch: an unloaded project has no usable base to apply an
      // incremental delta to.
      const delta = await pullProj(projId, { full: true });
      const entry = appState.projs[projId];
      if (entry) {
        if (delta) applyProjDeltaToProject(entry.project, delta);
        entry.loaded = true;
      }
      loadingScopes.delete(key);
    })();
  };

  const ensurePlacementLoaded = (kind: PlacementName) => {
    const key = `placement:${kind}`;
    if (loadingScopes.has(key)) return;
    loadingScopes.add(key);
    void (async () => {
      const delta = await pullPlacement(kind);
      if (delta) {
        if (kind === "inbox") appState.inbox = inboxFromDelta(delta);
        else appState[kind] = placementFromDelta(delta);
      }
      appState.placementLoaded[kind] = true;
      loadingScopes.delete(key);
    })();
  };

  // ─── Auth wiring ────────────────────────────────────────────────────────────
  async function onAuthChange(userId: string | null, opts?: { newUser?: boolean }) {
    if (userId === session.userId) return;
    const prevUserId = session.userId;
    // Flip the sync identity right away (pulls below run as the new account),
    // and hold persistence effects off while appState still shows the old one.
    session.userId = userId;
    session.switching = true;
    // The user is genuinely changing, so the prior session's per-scope
    // syncedAtSeq and any queued overlay mutations are no longer valid — clear
    // them before pulling/uploading so they can't leak into the new session.
    resetSyncState();
    try {
      if (userId && opts?.newUser) {
        // Sign-up: the demo state still carries deterministic `guest-` ids
        // (identical across all guests) — rewrite them to fresh UUIDs locally
        // before upload so they don't collide on the server's global primary key.
        materializeGuestIds(appState);
        // Upload the current (possibly edited) demo state; the server is the
        // backing store from here on, so unshown archived/trashed entries can
        // drop their local copy (they re-fetch on the next drill-in).
        await uploadInitialState(appState);
        pruneDrillIns(appState);
      } else if (userId) {
        // Sign-in: pull only the project list, then switch the panels right away.
        // Every project (and placement view) starts unloaded, so the first panel
        // shows the project list in its sidebar with a loading placeholder in its
        // main area while each scope's content is fetched lazily (by the lazy-load
        // effect / view components). This gates the post-sign-in switch on the
        // list alone — the caller (loadMe) also has the user info by now, and
        // holds the account view until this returns so the account panel and the
        // panels flip together — instead of waiting for every project's rows.
        const listDelta = await pullProjList();
        if (!listDelta) return;

        const projs: Record<string, ProjEntry> = {};
        for (const entry of listDelta.projects) {
          projs[entry.id] = {
            project: { id: entry.id, name: entry.name, note: entry.note, rows: [] },
            placement: "list",
            loaded: false,
          };
        }
        appState.projs = projs;
        appState.projOrder = listDelta.projects.map((e) => e.id);
        appState.inbox = [];
        appState.archive = [];
        appState.trash = [];
        appState.placementLoaded = { inbox: false, archive: false, trash: false };

        // Signing in from the guest page is a clean transform of what's on screen,
        // not a resurrection of a saved arrangement: keep the guest panels'
        // dimensions/spacing as-is, point the first panel at the first project
        // (which shows its loading placeholder until content streams in), turn the
        // sign-in panel into the account panel, and close any extra panels. The
        // normal signed-in resume — restoring the saved multi-panel arrangement
        // from the panel_comp cookie + localStorage — still happens on a real
        // signed-in page load (SSR + onMount), not here.
        const proj = appState.projOrder.length > 0 ? projOf(appState, appState.projOrder[0]) : null;
        const instance = proj
          ? newProjectInstance({ project: proj })
          : newPlacementInstance("inbox");
        const existingAccount = appState.panels.find((p) => p.instance === "account");
        const accountPanel = existingAccount ?? newPanelItem({ instance: "account" });
        if (appState.panels.length > 0) {
          appState.panels[0].instance = instance;
        } else {
          appState.panels.push(newPanelItem({ instance }));
        }
        appState.panels.splice(1, appState.panels.length - 1, accountPanel);
      } else {
        clearPanels(prevUserId);
        clearPanelCompCookie();
        // Guest mock data is fully present — nothing to lazy-load.
        Object.assign(appState, projsFromList(freshMockProjects()));
        appState.inbox = [];
        appState.archive = [];
        appState.trash = [];
        appState.placementLoaded = { inbox: true, archive: true, trash: true };
        const mockData = mockPanels(activeProjects(appState))[0];
        const existingAccount = appState.panels.find((p) => p.instance === "account");
        const accountPanel = existingAccount ?? newPanelItem({ instance: "account" });
        if (appState.panels.length > 0) {
          appState.panels[0].instance = mockData.instance;
          Object.assign(appState.panels[0].layout, mockData.layout);
        } else {
          appState.panels.push(
            newPanelItem({ layout: mockData.layout, instance: mockData.instance }),
          );
        }
        Object.assign(accountPanel.layout, {
          mainWidth: mockData.layout.mainWidth,
          height: mockData.layout.height,
          sideShow: false,
          sideWidth: "disabled",
          spacerLeft: 60,
        });
        appState.panels.splice(1, appState.panels.length - 1, accountPanel);
      }
    } finally {
      session.switching = false;
    }
  }

  // ─── Refresh ────────────────────────────────────────────────────────────────
  async function refresh() {
    if (session.userId != null) {
      const valid = await loadMe();
      if (!valid) {
        syncStatus.error = "Session ended or changed — open account to re-sign in.";
        return;
      }
      syncStatus.error = null;
    }

    // Push any pending mutations first, then pull fresh state.
    await settle();

    const listDelta = await pullProjList();
    if (!listDelta) return;

    // Fold the list into the project store. Entries keep their identity (and
    // rows), so open panels stay pointed at live objects; projects new to this
    // client arrive name-only and load lazily if/when a panel opens them.
    const listIds = new Set<string>();
    for (const e of listDelta.projects) {
      listIds.add(e.id);
      const entry = appState.projs[e.id];
      if (entry) {
        entry.project.name = e.name;
        entry.project.note = e.note;
        entry.placement = "list";
      } else {
        appState.projs[e.id] = {
          project: { id: e.id, name: e.name, note: e.note, rows: [] },
          placement: "list",
          loaded: false,
        };
      }
    }
    // Active projects that vanished server-side (deleted / archived elsewhere)
    // are dropped. Drilled-in archive/trash entries aren't in the list delta
    // and survive untouched — a drilled panel keeps its project mid-edit.
    for (const [id, entry] of Object.entries(appState.projs)) {
      if (entry.placement === "list" && !listIds.has(id)) delete appState.projs[id];
    }
    appState.projOrder = listDelta.projects.map((e) => e.id);

    // Re-point panels whose project disappeared; drop extra panels, fall the
    // main panel back to the first project / inbox.
    for (let i = appState.panels.length - 1; i >= 0; i--) {
      const panel = appState.panels[i];
      const inst = panel.instance;
      if (!isProjectInstance(inst)) continue;
      if (appState.projs[inst.project.id]) continue;
      if (i > 0) {
        appState.panels.splice(i, 1);
      } else {
        const first =
          appState.projOrder.length > 0 ? projOf(appState, appState.projOrder[0]) : null;
        panel.instance = first
          ? newProjectInstance({ project: first })
          : newPlacementInstance("inbox");
      }
    }

    // Pull a delta for each open, already-loaded project. Closed or unloaded
    // projects are skipped — they load fresh when first opened.
    const openProjIds = new Set(
      appState.panels.flatMap((p) =>
        isProjectInstance(p.instance) ? [p.instance.project.id] : [],
      ),
    );
    await Promise.all(
      [...openProjIds].map(async (projId) => {
        const entry = appState.projs[projId];
        if (!entry?.loaded) return;
        const delta = await pullProj(projId);
        if (delta) applyProjDeltaToProject(entry.project, delta);
      }),
    );

    // Refresh only placement views that are already loaded; unloaded ones load
    // fresh when first opened.
    const refreshPlacement = async (kind: PlacementName) => {
      if (!appState.placementLoaded[kind]) return;
      const delta = await pullPlacement(kind);
      if (!delta) return;
      if (kind === "inbox") appState.inbox = inboxFromDelta(delta);
      else appState[kind] = placementFromDelta(delta);
    };
    await Promise.all([
      refreshPlacement("inbox"),
      refreshPlacement("archive"),
      refreshPlacement("trash"),
    ]);
  }

  return { ensureProjectLoaded, ensurePlacementLoaded, onAuthChange, refresh };
}
