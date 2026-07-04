<script lang="ts">
  import type { PlacementInstance, SimpleOperation } from "$lib/client/model";
  import { operations } from "./OperationList.svelte";
  import UserPanel from "../user-panel/UserPanel.svelte";
  import PlacementView from "../placement-view/PlacementView.svelte";
  import PlacementTitle from "../placement-view/PlacementTitle.svelte";
  import BarButton from "../panel/BarButton.svelte";
  import PanelBottomBar from "../panel/PanelBottomBar.svelte";
  import { getAuthHooks, getPanelContext, getAppState } from "$lib/client/context";
  import { usePanelFocus } from "$lib/components/panel/PanelGroup.svelte";

  type Props = {
    instance: PlacementInstance | SimpleOperation;
    topBarHeight?: number;
    bottomBarHeight?: number;
    sideReveal?: number;
    resizingSide?: boolean;
    // Show the loading spinner. Owned by Panel (delay/min timing); the previous
    // page stays up during a fast load and the spinner shows only for a slow one.
    showSpinner?: boolean;
  };
  let {
    instance,
    topBarHeight = 0,
    bottomBarHeight = 0,
    sideReveal = 0,
    resizingSide = false,
    showSpinner = false,
  }: Props = $props();

  // The view-selector string (placement kind or simple-operation name).
  let value = $derived(typeof instance === "string" ? instance : instance.kind);
  let placement = $derived(typeof instance === "string" ? null : instance);

  let iconClass = $derived(
    operations.find((operation) => operation.value === value)?.iconClass ?? "",
  );

  const auth = getAuthHooks();
  const appState = getAppState();

  // Placement entries are lazy-loaded; hold a placeholder until they arrive so
  // the list mounts with its data already present (no per-row intro animation).
  let placementLoading = $derived(placement != null && !appState.placementLoaded[placement.kind]);
  let placementTitle = $derived(
    placement?.kind === "inbox" ? "Inbox" : placement?.kind === "archive" ? "Archive" : "Trash",
  );

  // Darken the panel while a placement row is expanded, mirroring PanelMain.
  let darkenBackground = $derived(placement?.expandedId != null);

  const { panelId } = getPanelContext();
  const panelFocus = usePanelFocus();
  let sectionFocused = $derived(panelFocus.panelId === panelId);

  // Bottom-bar wiring: the PlacementView owns the create/schedule/purge logic;
  // this page just renders the buttons and delegates via bind:this.
  let placementViewEl = $state<PlacementView | null>(null);
  let selectedTodoCount = $derived.by(() => {
    if (placement == null) return 0;
    if (placement.kind === "inbox") {
      return appState.inbox.filter((t) => placement.selected.has(t.id)).length;
    }
    return appState[placement.kind].filter((e) => e.kind === "todo" && placement.selected.has(e.id))
      .length;
  });
  let trashEntryCount = $derived(placement?.kind === "trash" ? appState.trash.length : 0);
  let trashSelectedCount = $derived(
    placement?.kind === "trash"
      ? appState.trash.filter((e) => placement.selected.has(e.id)).length
      : 0,
  );
</script>

{#if value === "account"}
  <UserPanel onAuthChange={auth?.onAuthChange} {topBarHeight} />
{:else if placement}
  <div
    class={[
      "flex size-full flex-col transition-[background-color]",
      darkenBackground ? "bg-surface-dim" : "bg-surface",
    ]}
    style:padding-top="{topBarHeight}px"
    onpointerdown={() => panelFocus.setFocus(panelId, "main")}
  >
    <div class="flex min-h-0 flex-1 flex-col">
      {#if placementLoading || showSpinner}
        <!-- Keep the title; show the spinner only when Panel says so (slow load).
             During the grace window the area stays blank — but Panel is usually
             still showing the previous page, so this isn't seen. -->
        <PlacementTitle title={placementTitle} {topBarHeight} {sideReveal} {resizingSide} />
        <div class="flex min-h-0 flex-1 items-center justify-center">
          {#if showSpinner}<p class="text-sm text-neutral-500">Loading…</p>{/if}
        </div>
      {:else}
        <PlacementView
          bind:this={placementViewEl}
          instance={placement}
          {topBarHeight}
          {sideReveal}
          {resizingSide}
        />
      {/if}
    </div>
    {#if !placementLoading || showSpinner}
      <!-- Hidden only during the fast grace/blank window; shown (with the focus
           line / progress bar on top) once the spinner is up or entries are ready. -->
      <PanelBottomBar
        height={bottomBarHeight}
        focused={sectionFocused}
        dimmed={showSpinner}
        class="justify-center gap-2"
      >
        {#if placement.kind === "inbox"}
          <BarButton
            class="w-16"
            aria-label="create a new todo"
            onclick={() => placementViewEl?.createTodo()}
          >
            <span class="icon-[material-symbols--add-rounded] size-5"></span>
          </BarButton>
        {/if}
        <BarButton
          class="w-16"
          aria-label="assign a date"
          disabled={selectedTodoCount === 0}
          onclick={(ev) => placementViewEl?.scheduleDate(ev.currentTarget)}
        >
          <span class="icon-[stash--calendar-solid] size-5 opacity-80"></span>
        </BarButton>
        {#if placement.kind === "trash"}
          <BarButton
            class="w-16"
            aria-label={trashSelectedCount > 0 ? "permanently delete selected" : "empty trash"}
            disabled={trashEntryCount === 0}
            onclick={(ev) => placementViewEl?.confirmPurge(ev.currentTarget)}
          >
            <span class="icon-[material-symbols--delete-forever-outline] size-5 opacity-80"></span>
          </BarButton>
        {/if}
      </PanelBottomBar>
    {/if}
  </div>
{:else}
  <div class="bg-surface flex size-full items-center justify-center gap-3">
    {#if iconClass}
      <span class={[iconClass, "size-6"]}></span>
    {/if}
    <span class="font-semibold text-gray-700">Under Construction</span>
  </div>
{/if}
