<script lang="ts">
  import {
    ContextMenuPopup,
    PickerPopup,
    SwitcherPopup,
    ConfirmPopup,
    type ProjectItem,
  } from "$lib";
  import CheckListInsert from "$lib/components/check-list/CheckListInsert.svelte";
  import TodoListInsert from "$lib/components/todo-panel/TodoListInsert.svelte";
  import { onMount, untrack } from "svelte";

  import ProjectListInsert from "$lib/components/project-list/ProjectListInsert.svelte";
  import PanelGroup from "$lib/components/panel/PanelGroup.svelte";
  import Panel from "$lib/components/panel/Panel.svelte";
  import {
    newPanelItem,
    isProjectInstance,
    isPlacementInstance,
    type PanelItem,
    type TodoItem,
    type ArchiveEntry,
  } from "$lib/client/model";
  import {
    serializePanelComp,
    writePanelCompCookie,
    clearPanelCompCookie,
  } from "$lib/client/panel-comp";
  import { markInteractive } from "$lib/client/interactive";
  import {
    setAppStateContext,
    setAuthHooksContext,
    setSyncHooksContext,
  } from "$lib/client/context";
  import { initSync, syncStatus } from "$lib/client/sync.svelte";
  import {
    projectsFromBootstrap,
    inboxFromDelta,
    placementFromDelta,
    initProjStub,
    initPlacementStub,
    seedSyncedAtSeq,
  } from "$lib/client/bootstrap-apply";
  import {
    makeMainPanel,
    panelsFromComposition,
    ensureMainData,
    applyStoredPanels,
    compositionMatches,
    overlayRowState,
    restorePlacementProjects,
  } from "$lib/client/panel-restore";
  import { createAppSession } from "$lib/client/app-session";
  import { freshMockProjects, mockPanels, GUEST_ID_PREFIX } from "$lib/client/mock";
  import { loadPanels, serializePanels, writePanels } from "$lib/client/panels-storage";
  import { seedMe } from "$lib/components/user-panel/UserPanel.svelte";
  import type { PageProps } from "./$types";

  const { data }: PageProps = $props();

  // ─── Initial state ────────────────────────────────────────────────────────
  const projects: ProjectItem[] = $state(
    data.user && data.state ? projectsFromBootstrap(data.state) : freshMockProjects(),
  );

  const defaultPanels = (): PanelItem[] => {
    if (!data.user) {
      return [
        ...mockPanels(projects),
        newPanelItem({ id: `${GUEST_ID_PREFIX}panel-account`, instance: "account" }),
      ];
    }
    // Signed in: rebuild the panels the cookie says were open, so the server
    // renders them and the client's first render matches. No cookie (first
    // visit) → the default main panel, whose first project the server prefetched.
    if (data.panels) {
      const built = panelsFromComposition(data.panels, projects);
      if (built.length > 0) return built;
    }
    return [makeMainPanel(projects)];
  };

  const appState = $state({
    projects,
    panels: untrack<PanelItem[]>(defaultPanels),
    inbox: data.state?.inbox ? inboxFromDelta(data.state.inbox) : ([] as TodoItem[]),
    archive: data.state?.archive ? placementFromDelta(data.state.archive) : ([] as ArchiveEntry[]),
    trash: data.state?.trash ? placementFromDelta(data.state.trash) : ([] as ArchiveEntry[]),
    openProjPlacement: new Map<string, "archive" | "trash">(
      Object.entries(data.state?.projPlacements ?? {}),
    ),
    stashedProjects: new Map<string, ProjectItem>(),
    projStub: untrack(() => initProjStub(data.state)),
    placementStub: untrack(() => initPlacementStub(data.state)),
  });
  setAppStateContext(appState);

  let currentUserId: string | null = $state(untrack(() => data.user?.id ?? null));
  let hydrated = $state(false);

  const session = createAppSession({
    appState,
    getCurrentUserId: () => currentUserId,
    setCurrentUserId: (id) => (currentUserId = id),
  });
  setAuthHooksContext({ onAuthChange: session.onAuthChange });
  setSyncHooksContext({ refresh: session.refresh });

  // Persist the full panel state (incl. per-row UI) to localStorage.
  $effect(() => {
    const snapshot = serializePanels(appState.panels, appState.openProjPlacement);
    const userId = currentUserId;
    if (!hydrated) return;
    writePanels(userId, snapshot);
  });

  // Mirror the panel composition (no per-row state) into a cookie so the next
  // SSR can render these panels server-side and prefetch their content. Separate
  // from the localStorage write so it only re-fires on composition changes, not
  // on every row selection. Signed-in only; guests render from the mock panels.
  $effect(() => {
    const comp = serializePanelComp(appState.panels, appState.openProjPlacement);
    const userId = currentUserId;
    if (!hydrated) return;
    if (userId) writePanelCompCookie(comp);
    else clearPanelCompCookie();
  });

  // Watch the open panels and lazily load any stubbed scope they show.
  $effect(() => {
    if (!hydrated) return;
    for (const panel of appState.panels) {
      const inst = panel.instance;
      if (isProjectInstance(inst)) {
        if (appState.projStub[inst.project.id]) session.ensureProjectLoaded(inst.project.id);
      } else if (isPlacementInstance(inst)) {
        if (appState.placementStub[inst.kind]) session.ensurePlacementLoaded(inst.kind);
      }
    }
  });

  // Seed the requesting user's own, request-scoped state during render (server +
  // the client's first render) so the page server-renders its real, signed-in
  // shape instead of a flash that only resolves after hydration — as safe to SSR
  // as the project data, which is equally request-scoped.
  //  - `me`: the account panel renders the real account / Welcome view, not
  //    "Loading…". seedMe re-seeds per request on the server (see its note).
  //  - `pinnedUserId`: the sync engine boots in onMount (initSync), so without
  //    this it stays null through SSR/hydration and the sync icon paints its
  //    demo-mode "offline" look until then. Seeding it here matches the SSR and
  //    first client render; initSync re-sets the same value and drives sync.
  seedMe(data.me);
  syncStatus.pinnedUserId = currentUserId;

  onMount(() => {
    initSync(currentUserId);
    // Seed syncedAtSeq from SSR load so first push sends the right seq.
    if (data.state) seedSyncedAtSeq(data.state);
    const stored = loadPanels(currentUserId, appState.projects);
    if (stored) {
      if (compositionMatches(appState.panels, stored)) {
        // The panels were already server-rendered from the cookie and match
        // localStorage — just overlay the per-row UI state (selection/expansion),
        // which the cookie omits, without remounting any panel view.
        overlayRowState(appState.panels, stored);
      } else {
        // Cookie/localStorage drift (e.g. cookies cleared, or first load after
        // this feature shipped): rebuild from localStorage. May briefly remount
        // the SSR'd panels, but keeps every saved panel.
        const finalStored = ensureMainData(stored, appState.projects);
        applyStoredPanels(appState.panels, finalStored);
        restorePlacementProjects(appState, appState.panels, finalStored);
      }
    }
    hydrated = true;
    // Reveal the panels (fallback for app.html's parse-end script) and mark the
    // page interactive — handlers are now attached, so the "making interactive"
    // banner hides, after its minimum show time has elapsed.
    markInteractive();
    const hijack = (_ev: WheelEvent) => {};
    document.addEventListener("wheel", hijack);
    return () => document.removeEventListener("wheel", hijack);
  });
</script>

{#if !hydrated}
  <!-- Phase 1 skeleton (removed at hydration): panel-shaped cards where the real
       panels will appear, so the HTML-download phase shows the layout taking
       shape instead of a blank page. Server-rendered for guests and signed-in
       users alike, sized from each panel's layout. CSS swaps it for the real
       panels at parse-end (see app.html). -->
  <div class="panel-placeholder">
    <div class="mx-auto flex">
      {#each appState.panels as p (p.id)}
        <div
          class="skeleton-card"
          style:margin-left="{typeof p.layout.spacerLeft === 'number' ? p.layout.spacerLeft : 0}px"
          style:width="{(p.layout.sideWidth === 'disabled' ? 0 : p.layout.sideWidth) +
            p.layout.mainWidth +
            2}px"
          style:height="{p.layout.height}px"
        ></div>
      {/each}
    </div>
  </div>
{/if}

<ContextMenuPopup>
  <ConfirmPopup>
    <SwitcherPopup>
      <PickerPopup>
        <ProjectListInsert>
          <TodoListInsert>
            <CheckListInsert>
              <!-- Panels render server-side for everyone now: guests from the
                   mock panels, signed-in users from the cookie composition the
                   server prefetched. Held hidden (panel-stage) until parse-end. -->
              <PanelGroup>
                {#snippet each(panel, index)}
                  <Panel {panel} isMainPanel={index === 0} />
                {/snippet}
              </PanelGroup>
            </CheckListInsert>
          </TodoListInsert>
        </ProjectListInsert>
      </PickerPopup>
    </SwitcherPopup>
  </ConfirmPopup>
</ContextMenuPopup>

<style>
  :global(.dragging-to-insert *) {
    cursor: default !important;
  }
</style>
