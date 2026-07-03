// The signed-in/guest session lifecycle of the SPA: lazy-loading stubbed
// scopes, reacting to auth changes (sign-up / sign-in / sign-out), and the
// manual refresh (push pending, then re-pull). Extracted from +page.svelte —
// the page owns the reactive appState and the currentUserId $state; this
// module drives them through the accessors it's given.

import {
  isProjectInstance,
  newPanelItem,
  newPlacementInstance,
  newProjectInstance,
  type AppState,
  type PlacementName,
} from "./model";
import {
  applyProjDeltaToProject,
  projsFromListDelta,
  pullPlacement,
  pullProj,
  pullProjList,
  resetSyncState,
  settle,
  syncStatus,
  uploadInitialState,
} from "./sync.svelte";
import { inboxFromDelta, placementFromDelta } from "./bootstrap-apply";
import { freshMockProjects, mockPanels } from "./mock";
import { materializeGuestIds } from "./guest-ids";
import { clearPanels } from "./panels-storage";
import { clearPanelCompCookie } from "./panel-comp";
import { loadMe } from "$lib/components/user-panel/UserPanel.svelte";

type SessionOpts = {
  appState: AppState;
  getCurrentUserId: () => string | null;
  setCurrentUserId: (id: string | null) => void;
};

export function createAppSession({ appState, getCurrentUserId, setCurrentUserId }: SessionOpts) {
  // ─── Lazy content loading ───────────────────────────────────────────────────
  // Only the scopes the open panels showed are bootstrapped; every other project
  // / placement is a stub fetched the first time a panel shows it. The page's
  // panel-watching effect calls these; the view components render a "Loading…"
  // placeholder while their scope is stubbed.

  // Scopes with a fetch in flight, so the effect doesn't kick a second one. The
  // stub clears the instant data arrives; the loading indicator's keep-previous /
  // delay / min-visible timing is handled by Panel.
  const loadingScopes = new Set<string>();

  const ensureProjectLoaded = (projId: string) => {
    const key = `proj:${projId}`;
    if (loadingScopes.has(key)) return;
    loadingScopes.add(key);
    void (async () => {
      const delta = await pullProj(projId, { full: true });
      const proj = appState.projects.find((p) => p.id === projId);
      if (proj && delta) applyProjDeltaToProject(proj, delta);
      appState.projStub[projId] = false;
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
      appState.placementStub[kind] = false;
      loadingScopes.delete(key);
    })();
  };

  // ─── Auth wiring ────────────────────────────────────────────────────────────
  async function onAuthChange(userId: string | null, opts?: { newUser?: boolean }) {
    if (userId === getCurrentUserId()) return;
    syncStatus.pinnedUserId = userId;
    // The user is genuinely changing, so the prior session's per-scope
    // syncedAtSeq and any queued overlay mutations are no longer valid — clear
    // them before pulling/uploading so they can't leak into the new session.
    resetSyncState();

    if (userId && opts?.newUser) {
      // Sign-up: the demo state still carries deterministic `guest-` ids
      // (identical across all guests) — rewrite them to fresh UUIDs locally
      // before upload so they don't collide on the server's global primary key.
      materializeGuestIds(appState);
      // Upload the current (possibly edited) demo state, then hand the backing
      // store over to the server — drop the guest cold storage so reopening an
      // archived/trashed project fetches the now-uploaded copy (keeps the
      // "signed in ⟹ stash empty" invariant).
      await uploadInitialState(appState);
      appState.stashedProjects = new Map();
    } else if (userId) {
      // Sign-in: pull only the project list, then switch the panels right away.
      // Every project (and placement view) starts as a stub, so the first panel
      // shows the project list in its sidebar with a loading placeholder in its
      // main area while each scope's content is fetched lazily (by the lazy-load
      // effect / view components). This gates the post-sign-in switch on the
      // list alone — the caller (loadMe) also has the user info by now, and
      // holds the account view until this returns so the account panel and the
      // panels flip together — instead of waiting for every project's rows.
      const listDelta = await pullProjList();
      if (!listDelta) return;

      appState.projects = listDelta.projects.map((entry) => ({
        id: entry.id,
        name: entry.name,
        note: entry.note,
        rows: [],
      }));

      // Stub every project and placement view: each loads lazily the first time
      // a panel shows it. The server is now the backing store, so drop the guest
      // cold storage and clear the local placement data (it reloads on demand).
      const projStub: Record<string, boolean> = {};
      for (const entry of listDelta.projects) projStub[entry.id] = true;
      appState.projStub = projStub;
      appState.inbox = [];
      appState.archive = [];
      appState.trash = [];
      appState.placementStub = { inbox: true, archive: true, trash: true };
      appState.stashedProjects = new Map();

      // Signing in from the guest page is a clean transform of what's on screen,
      // not a resurrection of a saved arrangement: keep the guest panels'
      // dimensions/spacing as-is, point the first panel at the first project
      // (which shows its loading placeholder until content streams in), turn the
      // sign-in panel into the account panel, and close any extra panels. The
      // normal signed-in resume — restoring the saved multi-panel arrangement
      // from the panel_comp cookie + localStorage — still happens on a real
      // signed-in page load (SSR + onMount), not here.
      const proj = appState.projects[0];
      const instance = proj ? newProjectInstance({ project: proj }) : newPlacementInstance("inbox");
      const existingAccount = appState.panels.find((p) => p.instance === "account");
      const accountPanel = existingAccount ?? newPanelItem({ instance: "account" });
      if (appState.panels.length > 0) {
        appState.panels[0].instance = instance;
      } else {
        appState.panels.push(newPanelItem({ instance }));
      }
      appState.panels.splice(1, appState.panels.length - 1, accountPanel);
    } else {
      clearPanels(getCurrentUserId());
      clearPanelCompCookie();
      setCurrentUserId(null);
      appState.projects = freshMockProjects();
      appState.inbox = [];
      appState.archive = [];
      appState.trash = [];
      // Guest mock data is fully present — nothing to lazy-load or cold-store.
      appState.projStub = {};
      appState.placementStub = { inbox: false, archive: false, trash: false };
      appState.stashedProjects = new Map();
      const mockData = mockPanels(appState.projects)[0];
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
    setCurrentUserId(userId);
  }

  // ─── Refresh ────────────────────────────────────────────────────────────────
  async function refresh() {
    if (syncStatus.pinnedUserId != null) {
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

    // Update or add projects from list.
    const knownIds = new Set(appState.projects.map((p) => p.id));
    const newProjects = projsFromListDelta(listDelta, appState.projects);

    // Projects new to this client (created elsewhere) arrive name-only — stub
    // them so their content loads lazily if/when a panel opens them.
    for (const np of newProjects) {
      if (!knownIds.has(np.id)) appState.projStub[np.id] = true;
    }

    // Preserve projects opened from a placement view (archive/trash, so not in
    // the list delta) — dropping them here would close/reset the panel mid-edit.
    for (const p of appState.projects) {
      if (appState.openProjPlacement.has(p.id) && !newProjects.some((np) => np.id === p.id)) {
        newProjects.push(p);
      }
    }

    // Pull a delta for each open project that's already loaded. Closed or
    // stubbed projects are skipped — they load fresh when first opened.
    const openProjIds = new Set(
      appState.panels
        .map((p) => (isProjectInstance(p.instance) ? p.instance.project.id : null))
        .filter(Boolean) as string[],
    );

    await Promise.all(
      newProjects.map(async (proj) => {
        if (!openProjIds.has(proj.id) || appState.projStub[proj.id]) return;
        const delta = await pullProj(proj.id);
        if (delta) applyProjDeltaToProject(proj, delta);
      }),
    );

    appState.projects = newProjects;

    // Re-point panels at the freshly pulled reactive projects.
    const projectsById = new Map(appState.projects.map((p) => [p.id, p] as const));
    for (let i = appState.panels.length - 1; i >= 0; i--) {
      const panel = appState.panels[i];
      const inst = panel.instance;
      if (!isProjectInstance(inst)) continue;
      const proj = projectsById.get(inst.project.id);
      if (proj == null) {
        if (i > 0) {
          appState.panels.splice(i, 1);
        } else {
          panel.instance = appState.projects[0]
            ? newProjectInstance({ project: appState.projects[0] })
            : newPlacementInstance("inbox");
        }
        continue;
      }
      panel.instance = newProjectInstance({
        project: proj,
        rowSelected: inst.rowSelected,
        todoExpanded: inst.todoExpanded,
      });
    }

    // Refresh only placement views that are already loaded; stubbed ones load
    // fresh when first opened.
    const refreshPlacement = async (kind: PlacementName) => {
      if (appState.placementStub[kind]) return;
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
