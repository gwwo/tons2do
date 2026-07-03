<script lang="ts" module>
  import { setProjContext } from "$lib/client/context";
  import {
    useCreateGrouping,
    useCreateTodo,
    useSetPlanned,
    useDeleteRow,
    useTrashTodo,
  } from "$lib/client/mutate-remote";
  const useMutator = () => ({
    createGrouping: useCreateGrouping(),
    createTodo: useCreateTodo(),
    setPlanned: useSetPlanned(),
    deleteRow: useDeleteRow(),
    trashTodo: useTrashTodo(),
  });
  type Mutator = ReturnType<typeof useMutator>;
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ProjectInstance } from "$lib";
  import TodoList from "$lib/components/todo-panel/TodoList.svelte";
  import ProgressCircle from "$lib/components/ProgressCircle.svelte";
  import BarButton from "./BarButton.svelte";
  import PanelBottomBar from "./PanelBottomBar.svelte";
  import { isTodoItem, usePicker } from "$lib";
  import type { CalendarDate } from "@internationalized/date";
  import { getAppState, getPanelContext } from "$lib/client/context";
  import { useExitPlacementProject } from "$lib/client/mutate-local";
  import { usePanelFocus } from "$lib/components/panel/PanelGroup.svelte";
  import { usePanelKeydown } from "$lib/components/list-kit/keys.svelte";
  import { agreedPlannedDate } from "$lib/components/list-kit/planned";

  const { panelId } = getPanelContext();
  const appState = getAppState();
  const exitPlacement = useExitPlacementProject();
  const panelFocus = usePanelFocus();
  let sectionFocused = $derived(panelFocus.panelId === panelId);

  usePanelKeydown((e) => {
    if (
      e.key !== "Enter" &&
      e.key !== "Delete" &&
      e.key !== "Backspace" &&
      e.key !== "ArrowUp" &&
      e.key !== "ArrowDown" &&
      e.key !== " " &&
      !(e.key === "a" && (e.metaKey || e.ctrlKey))
    )
      return;
    e.preventDefault();
    if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
      todolistEl?.selectAll();
      return;
    }
    if (e.key === " ") {
      mut.createTodo().then((newTodo) => {
        if (newTodo) rowIdToReveal = newTodo.id;
      });
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      todolistEl?.navigateSelection(e.key === "ArrowUp" ? "up" : "down");
      return;
    }
    if (e.key === "Enter") {
      todolistEl?.activateFirstSelected();
      return;
    }
    const selectedRows = instance.project.rows.filter((row) => instance.rowSelected[row.id]);
    const todoIds = new Set(selectedRows.filter((r) => isTodoItem(r)).map((r) => r.id));
    const groupingIds = new Set(selectedRows.filter((r) => !isTodoItem(r)).map((r) => r.id));
    if (todoIds.size > 0) mut.trashTodo(todoIds);
    else if (groupingIds.size > 0) mut.deleteRow(groupingIds);
  });
  type Props = {
    instance: ProjectInstance;
    bottomBarHeight: number;
    topBarHeight: number;
    newProjIdToReveal: string | null;
    // Show the loading spinner. Owned by Panel, which times the delay/min so the
    // previous page stays up during a fast load and the spinner only appears for
    // a slow one.
    showSpinner?: boolean;
    class?: ClassValue;
    mut?: Mutator;
  };

  let {
    instance,
    bottomBarHeight,
    topBarHeight,
    newProjIdToReveal = $bindable(),
    showSpinner = false,
    class: className,
    mut: mutator,
  }: Props = $props();

  setProjContext({ projId: instance.project.id });
  const mut = mutator ?? useMutator();
  const picker = usePicker();

  let selectedTodoIds = $derived.by(() => {
    const ids = new Set<string>();
    for (const row of instance.project.rows) {
      if (isTodoItem(row) && instance.rowSelected[row.id]) {
        ids.add(row.id);
      }
    }
    return ids;
  });

  const firstExpandedId =
    instance.project.rows.find((r) => instance.todoExpanded[r.id])?.id ?? null;
  let rowIdToReveal: string | null = $state(null);

  $effect(() => {
    if (!firstExpandedId) return;
    const t = setTimeout(() => {
      rowIdToReveal = firstExpandedId;
    }, 150);
    return () => clearTimeout(t);
  });

  let todolistEl: TodoList | null = $state(null);

  let progressPercent = $derived.by(() => {
    const todos = instance.project.rows.filter(isTodoItem);
    if (todos.length === 0) return 0;
    const doneCount = todos.filter((todo) => todo.status === "complete").length;
    return (doneCount / todos.length) * 100;
  });

  $effect(() => {
    if (newProjIdToReveal !== instance.project.id) return;
    todolistEl?.focusNameInput();
    newProjIdToReveal = null;
  });

  let darkenBackground = $derived.by(() => Object.values(instance.todoExpanded).some(Boolean));

  // Set when this project was opened from a placement view (archive/trash): it
  // renders as a normal project page, plus a button back to that view.
  let openFrom = $derived(appState.openProjPlacement.get(instance.project.id));

  // Content not fetched yet (lazy load / placement drill-in): the create toolbar
  // is hidden and the list area holds a blank/spinner until rows are ready.
  let loading = $derived(appState.projStub[instance.project.id] ?? false);
</script>

<div
  class={[
    className,
    "flex size-full flex-col transition-[background-color]",
    darkenBackground ? "bg-surface-dim" : "bg-surface",
  ]}
  style:padding-top="{topBarHeight}px"
  onpointerdown={() => panelFocus.setFocus(panelId, "main")}
>
  {#if openFrom}
    <button
      class="mt-1 flex h-6 flex-none cursor-pointer items-center gap-1 self-start rounded-md pr-3 pl-8 text-sm text-gray-500 hover:text-gray-700"
      onclick={exitPlacement}
    >
      <span class="icon-[material-symbols--arrow-back-rounded] size-4"></span>
      Back to {openFrom === "archive" ? "Archive" : "Trash"}
    </button>
  {/if}
  {#if showSpinner}
    <!-- Slow load: Panel kept the previous page through the grace window and is
         now showing the spinner (held briefly once shown). -->
    <div class="flex min-h-0 flex-1 items-center justify-center">
      <p class="text-sm text-neutral-500">Loading…</p>
    </div>
  {:else if loading}
    <!-- Grace window: rows not in yet but spinner not due. Hold the area blank
         (Panel still shows the previous page in the common case). -->
    <div class="min-h-0 flex-1"></div>
  {:else}
    <TodoList
      bind:this={todolistEl}
      data={instance.project}
      expanded={instance.todoExpanded}
      selected={instance.rowSelected}
      bind:rowIdToReveal
      class="flex min-h-0 flex-1 px-4 text-gray-800"
    ></TodoList>
  {/if}

  {#if !loading || showSpinner}
    <!-- Hidden only during the fast grace/blank window; shown (with the focus line
       / progress bar on top) once the spinner is up or content is ready. Buttons
       grey out while the page is still loading. -->
    <PanelBottomBar
      height={bottomBarHeight}
      focused={sectionFocused}
      dimmed={loading || showSpinner}
      class="justify-center gap-2"
    >
      <BarButton
        class="w-16"
        aria-label="create a new todo"
        onclick={async () => {
          const newTodo = await mut.createTodo();
          if (newTodo) rowIdToReveal = newTodo.id;
        }}
      >
        <span class="icon-[material-symbols--add-rounded] size-5"></span>
      </BarButton>
      <BarButton
        class="w-16"
        aria-label="create a new heading"
        onclick={async () => {
          const newGrouping = await mut.createGrouping();
          if (newGrouping) rowIdToReveal = newGrouping.id;
        }}
      >
        <span class="icon-[ic--outline-new-label] size-5 opacity-80"></span>
      </BarButton>
      <BarButton
        class="w-16"
        aria-label="assign a date"
        disabled={selectedTodoIds.size === 0}
        onclick={(ev) => {
          const anchor = ev.currentTarget;
          const ids = selectedTodoIds;
          picker.popup({
            anchor,
            getDate: () =>
              agreedPlannedDate(
                instance.project.rows.flatMap((row) =>
                  isTodoItem(row) && ids.has(row.id) ? [row.planned] : [],
                ),
              ),
            setDate: (planned: CalendarDate) => mut.setPlanned(ids, planned),
          });
        }}
      >
        <span class="icon-[stash--calendar-solid] size-5 opacity-80"></span>
      </BarButton>
      <div class="flex h-7 w-16 items-center justify-center">
        <ProgressCircle value={progressPercent} />
      </div>
    </PanelBottomBar>
  {/if}
</div>
