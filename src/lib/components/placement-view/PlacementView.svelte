<script lang="ts" module>
  import type {
    ArchiveEntry,
    ArchiveProjEntry,
    ArchiveTodoEntry,
    PlacementInstance,
    PlacementName,
  } from "$lib/client/model";
  import type { TodoItem, CheckItem, CheckInitData } from "$lib";

  // A placement view renders one of three data sources: the inbox holds live
  // TodoItem rows, archive/trash hold ArchiveEntry rows (todos + project stubs).
  export type PlacementEntry = TodoItem | ArchiveEntry;
  type PlacementTodo = TodoItem | ArchiveTodoEntry;

  const isProjEntry = (e: PlacementEntry): e is ArchiveProjEntry =>
    "kind" in e && e.kind === "proj";
  const isTodoEntry = (e: PlacementEntry): e is PlacementTodo => !isProjEntry(e);

  const PLACEMENT_TITLE: Record<PlacementName, string> = {
    inbox: "Inbox",
    archive: "Archive",
    trash: "Trash",
  };

  // Per-placement hue of a project row / its dragged pile (inbox has none).
  const PROJ_TONE: Record<"archive" | "trash", { row: string; hover: string }> = {
    archive: { row: "text-cyan-600", hover: "group-hover:bg-cyan-600/15" },
    trash: { row: "text-gray-400", hover: "group-hover:bg-gray-400/20" },
  };

  const placementNames = new Set<PlacementName>(["inbox", "archive", "trash"]);
  const asPlacement = (id: string): PlacementName | null =>
    placementNames.has(id as PlacementName) ? (id as PlacementName) : null;

  const markLabel = (count: number, allDone: boolean) =>
    allDone
      ? count === 1
        ? "Undo it"
        : `Undo ${count} todos`
      : count === 1
        ? "Mark as done"
        : `Mark ${count} todos done`;
</script>

<script lang="ts">
  import { getAppState, getPanelContext } from "$lib/client/context";
  import { usePanelFocus } from "$lib/components/panel/PanelGroup.svelte";
  import DragList, {
    type DragPrep,
    type TargetPrep,
  } from "$lib/components/drag-insert-list/DragList.svelte";
  import {
    useTodoListInserter,
    isGroupingItem,
    type ItemInsert,
    type InsertInfo,
    type TargetInfo,
  } from "$lib/components/todo-panel/TodoListInsert.svelte";
  import {
    useMoveToPlacementFrom,
    useMovePlacementToPlacement,
    useMoveProjectBetweenPlacements,
    useRestoreProjects,
    useEditPlacementTodo,
    useEditPlacementCheck,
    useMovePlacementCheck,
    useCreatePlacementCheck,
    useDeletePlacementCheck,
    useSetPlannedPlacement,
    useMarkPlacementTodo,
    useCreateInboxTodo,
    usePurgeTrash,
  } from "$lib/client/mutate-remote";
  import { usePicker, useConfirm, useContextMenu, toLayoutPoint, placeholder } from "$lib";
  import type { CalendarDate } from "@internationalized/date";
  import {
    useSetPlacementSelected,
    useSetPlacementExpanded,
    useOpenPlacementProject,
  } from "$lib/client/mutate-local";
  import { parsePlanned } from "$lib/client/sync.svelte";
  import type { Insertion } from "$lib/components/drag-insert-list/InsertPile.svelte";
  import TodoRow from "$lib/components/todo-row/TodoRow.svelte";
  import PlacementTitle from "./PlacementTitle.svelte";
  import { revealOnExpand } from "./revealOnExpand.svelte";
  import { usePanelKeydown } from "$lib/components/list-kit/keys.svelte";
  import {
    EXPANDED_SPACING as expandedSpacing,
    scrollRowIntoView,
  } from "$lib/components/list-kit/reveal";
  import { resolveRowMouseDown } from "$lib/components/list-kit/selection";
  import { agreedPlannedDate } from "$lib/components/list-kit/planned";
  import { untrack, tick } from "svelte";
  import type { Attachment } from "svelte/attachments";

  type Props = {
    instance: PlacementInstance;
    topBarHeight?: number;
    // 0..1 reveal of this panel's side bar; tracks the live drag. The navbar
    // switcher fades out as this grows, so the title fades in to mirror it.
    // Non-main panels have no side bar, so this stays 0 and the title never shows.
    sideReveal?: number;
    // True while the side bar is being drag-resized: suppress the CSS transition
    // so the title tracks the cursor instead of easing after release.
    resizingSide?: boolean;
  };
  let { instance: ui, topBarHeight = 0, sideReveal = 0, resizingSide = false }: Props = $props();

  const appState = getAppState();
  // The panel remounts this view per placement (Panel keys on the instance), so
  // ui.kind is stable for this component's lifetime.
  const entries = $derived<PlacementEntry[]>(
    ui.kind === "inbox" ? appState.inbox : appState[ui.kind],
  );
  const title = $derived(PLACEMENT_TITLE[ui.kind]);

  const moveToPlacement = useMoveToPlacementFrom();
  const movePlacement = useMovePlacementToPlacement();
  const moveProjectBetweenPlacements = useMoveProjectBetweenPlacements();
  const restoreProjects = useRestoreProjects();
  const editPlacementTodo = useEditPlacementTodo();
  const editPlacementCheck = useEditPlacementCheck();
  const movePlacementCheck = useMovePlacementCheck();
  const createPlacementCheck = useCreatePlacementCheck();
  const deletePlacementCheck = useDeletePlacementCheck();
  const setPlannedPlacement = useSetPlannedPlacement();
  const markPlacementTodo = useMarkPlacementTodo();
  const createInboxTodo = useCreateInboxTodo();
  const purgeTrash = usePurgeTrash();
  const setSelected = useSetPlacementSelected();
  const setExpanded = useSetPlacementExpanded();
  const openPlacementProject = useOpenPlacementProject();
  const picker = usePicker();
  const confirm = useConfirm();
  const contextMenu = useContextMenu();

  const { panelId } = getPanelContext();
  const panelFocus = usePanelFocus();

  // The inbox stores TodoItem directly; archive/trash entries convert on read.
  function asTodoItem(entry: PlacementTodo): TodoItem {
    if (!("kind" in entry)) return entry;
    return {
      id: entry.id,
      title: entry.title,
      note: entry.note,
      status: entry.done ? "complete" : "todo",
      planned: parsePlanned(entry.planned),
      checks: entry.checks,
    };
  }

  function entryToDragRaw(entry: PlacementEntry): ItemInsert["raw"] {
    // Project entries map as GroupingItem-shaped so non-placement lists reject them.
    if (isProjEntry(entry)) return { id: entry.id, label: entry.name || "" };
    return asTodoItem(entry);
  }

  // What this placement accepts from a drag: the inbox takes any todo, the
  // archive completed todos + projects, the trash todos + projects. Projects
  // only ever arrive from the other of archive/trash (same-placement drags are
  // a no-op); groupings are never insertable.
  const acceptsItem = (it: ItemInsert): boolean => {
    if (it.snapBack) return false;
    if (it.kind === "proj") return ui.kind !== "inbox";
    if (isGroupingItem(it.raw)) return false;
    if (ui.kind === "archive") return (it.raw as TodoItem).status === "complete";
    return true;
  };

  // TodoRow/ExpandedTodo mutator bound to one placement todo. Archive strips
  // status edits: archived todos are complete by definition, so the tickbox is
  // inert there (matching the pre-merge behavior).
  const todoMutFor = (id: string) => ({
    editTodo: (data: Partial<Omit<TodoItem, "checks" | "id">>) => {
      if (ui.kind === "archive") {
        const rest = { ...data };
        delete rest.status;
        if (Object.keys(rest).length > 0) editPlacementTodo(ui.kind, id, rest);
      } else {
        editPlacementTodo(ui.kind, id, data);
      }
    },
    editCheck: (checkId: string, data: Partial<Omit<CheckItem, "id">>) =>
      editPlacementCheck(ui.kind, id, checkId, data),
    moveCheck: (checkIds: string[], index: number) =>
      movePlacementCheck(ui.kind, id, checkIds, index),
    createCheck: (checks: CheckInitData[], index: number) =>
      createPlacementCheck(ui.kind, id, checks, index),
    deleteCheck: (checkId: string) => deletePlacementCheck(ui.kind, id, checkId),
  });

  // ─── Context menu ───────────────────────────────────────────────────────────

  const openContextMenu = (ev: MouseEvent, id: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!ui.selected.has(id)) setSelected(new Set([id]));
    const selectedEntries = entries.filter((e) => ui.selected.has(e.id));
    if (selectedEntries.length === 0) return;
    // The menu clamps itself to the viewport (ContextMenuPopup); pass the raw point.
    const { x, y } = toLayoutPoint(ev.clientX, ev.clientY);

    const todos = selectedEntries.filter(isTodoEntry);
    const todoIds = todos.map((e) => e.id);
    const projIds = selectedEntries.filter(isProjEntry).map((e) => e.id);
    const count = selectedEntries.length;
    const allDone = todos.length > 0 && todos.every((e) => asTodoItem(e).status === "complete");

    if (ui.kind === "inbox") {
      // Inbox holds only todos: mark/undo, archive the completed, move to trash.
      const completedIds = todos
        .filter((e) => asTodoItem(e).status === "complete")
        .map((e) => e.id);
      contextMenu.popup({
        x,
        y,
        count,
        itemLabel: "todo",
        secondaryAction: {
          label: markLabel(count, allDone),
          onAction: () =>
            markPlacementTodo("inbox", new Set(todoIds), allDone ? "todo" : "complete"),
        },
        extraActions:
          completedIds.length > 0
            ? [
                {
                  label:
                    completedIds.length === 1
                      ? "Archive completed todo"
                      : `Archive ${completedIds.length} completed todos`,
                  onAction: () => movePlacement("inbox", new Set(completedIds), "archive"),
                },
              ]
            : [],
        deleteLabel: count === 1 ? "Move todo to trash" : `Move ${count} todos to trash`,
        onDelete: () => movePlacement("inbox", new Set(todoIds), "trash"),
      });
      return;
    }

    // Archive/trash restore action: projects → front of the active project
    // list, todos → front of the inbox.
    const restore = () => {
      if (projIds.length > 0) restoreProjects(projIds, 0);
      if (todoIds.length > 0) movePlacement(ui.kind, new Set(todoIds), "inbox");
      setSelected(new Set());
    };

    if (ui.kind === "archive") {
      contextMenu.popup({
        x,
        y,
        count,
        itemLabel: "row",
        secondaryAction: {
          label: count === 1 ? "Move row out of archive" : `Move ${count} rows out of archive`,
          onAction: restore,
        },
        deleteLabel: count === 1 ? "Move row to trash" : `Move ${count} rows to trash`,
        onDelete: () => {
          if (projIds.length > 0)
            moveProjectBetweenPlacements("archive", new Set(projIds), "trash");
          if (todoIds.length > 0) movePlacement("archive", new Set(todoIds), "trash");
          setSelected(new Set());
        },
      });
      return;
    }

    // Trash: optional mark/undo, restore, and permanently delete (confirmed).
    const ids = new Set(selectedEntries.map((e) => e.id));
    contextMenu.popup({
      x,
      y,
      count,
      itemLabel: "row",
      secondaryAction:
        todoIds.length > 0
          ? {
              label: markLabel(todoIds.length, allDone),
              onAction: () =>
                markPlacementTodo("trash", new Set(todoIds), allDone ? "todo" : "complete"),
            }
          : undefined,
      extraActions: [
        {
          label: count === 1 ? "Move row out of trash" : `Move ${count} rows out of trash`,
          onAction: restore,
        },
      ],
      deleteLabel: count === 1 ? "Delete row" : `Delete ${count} rows`,
      onDelete: () => {
        // Confirm before purging, mirroring the bottom-bar delete button. The
        // context menu has no lasting anchor, so place the bubble at the same
        // point (it clamps itself on-screen).
        confirm.popup({
          point: { x, y },
          title: count === 1 ? "Permanently delete this row?" : `Permanently delete ${count} rows?`,
          description: "This can't be undone.",
          confirmLabel: "Delete",
          onConfirm: () => {
            purgeTrash(ids);
            setSelected(new Set());
          },
        });
      },
    });
  };

  // ─── Bottom-bar actions (exposed to OperationPage via bind:this) ────────────

  // Create a new inbox todo, then reveal + focus its title. Shared by the Space
  // shortcut and the bottom-bar "add todo" button.
  export function createTodo() {
    if (ui.kind !== "inbox") return;
    const created = createInboxTodo();
    if (created) {
      rowIdToReveal = created.id;
      focusTitleSoon(created.id);
    }
  }

  // Open the date picker for the selected todos. Project entries are ignored.
  export function scheduleDate(anchor: HTMLElement) {
    const selectedTodos = entries.filter(isTodoEntry).filter((e) => ui.selected.has(e.id));
    if (selectedTodos.length === 0) return;
    const ids = new Set(selectedTodos.map((e) => e.id));
    picker.popup({
      anchor,
      getDate: () => agreedPlannedDate(selectedTodos.map((e) => asTodoItem(e).planned)),
      setDate: (planned: CalendarDate) => setPlannedPlacement(ui.kind, ids, planned),
    });
  }

  // Confirm-then-purge: permanently delete the selected entries, or empty the
  // whole trash when nothing is selected. Trash only.
  export function confirmPurge(anchor: HTMLElement) {
    if (ui.kind !== "trash") return;
    const selectedIds = entries.filter((e) => ui.selected.has(e.id)).map((e) => e.id);
    const hasSelection = selectedIds.length > 0;
    const ids = new Set(hasSelection ? selectedIds : entries.map((e) => e.id));
    if (ids.size === 0) return;
    const count = ids.size;
    confirm.popup({
      anchor,
      title: hasSelection
        ? count === 1
          ? "Permanently delete this row?"
          : `Permanently delete ${count} rows?`
        : "Empty trash?",
      description: hasSelection
        ? "This can't be undone."
        : `Permanently delete all ${count} ${count === 1 ? "row" : "rows"} in the trash. This can't be undone.`,
      confirmLabel: hasSelection ? "Delete" : "Empty trash",
      onConfirm: () => {
        purgeTrash(ids);
        setSelected(new Set());
      },
    });
  }

  // ─── Project drill-in ────────────────────────────────────────────────────────
  // Double-clicking a project row (archive/trash) opens it as a normal, fully-
  // editable project page in this same panel: a name-only stub is registered
  // (useOpenPlacementProject) and the panel points at it, showing the standard
  // project view's "Back to …" bar + a Loading… placeholder while the lazy
  // loader fetches its rows.
  function enterProject(entry: ArchiveProjEntry) {
    if (ui.kind === "inbox") return;
    openPlacementProject(entry.id, entry.name, ui.kind);
  }

  let rowIdToReveal = $state<string | null>(null);
  // Plain selection-navigation scroll target (distinct from rowIdToReveal, which
  // is for freshly-expanded rows).
  let rowIdToScroll = $state<string | null>(null);

  // Reveal a row that was restored as expanded from a previous session, once,
  // on mount — mirrors PanelMain's behaviour. Read the expansion when the timer
  // fires, not at init: on the signed-in SSR path this view mounts from the
  // cookie composition (no row state) and expandedId is only overlaid from
  // localStorage during the page's onMount (overlayRowState) — within this
  // timer's window, since it doesn't remount us.
  $effect(() => {
    const t = setTimeout(() => {
      const id = untrack(() => ui.expandedId);
      if (id) rowIdToReveal = id;
    }, 150);
    return () => clearTimeout(t);
  });

  // Returning from a drilled-in project ("Back to …") preselects that project's
  // row (useExitPlacementProject). On mount, scroll it into view — as if arrow-
  // navigated to — once the rows have mounted. Read at timer fire for the same
  // hydration-overlay reason as above.
  $effect(() => {
    const t = setTimeout(() => {
      const id = untrack(() => (ui.selected.size === 1 ? [...ui.selected][0] : null));
      if (id) rowIdToScroll = id;
    }, 150);
    return () => clearTimeout(t);
  });

  let collapsing: Record<string, boolean> = $state({});
  let todoRowElements: Record<string, TodoRow | null> = $state({});
  let rowDivElements: Record<string, HTMLElement | null> = $state({});

  // Focus a todo's title input once its expanded view has mounted.
  function focusTitleSoon(id: string) {
    tick().then(() => todoRowElements[id]?.focusTitleInput());
  }

  // ─── Keyboard navigation ─────────────────────────────────────────────────────

  // Move the single selection up/down through the entries (todos + projects),
  // skipping the expanded row. Mirrors TodoList navigation.
  function navigateSelection(direction: "up" | "down") {
    const rows = entries;
    if (rows.length === 0) return;
    const selectedIndices = rows.reduce<number[]>((acc, e, i) => {
      if (ui.selected.has(e.id)) acc.push(i);
      return acc;
    }, []);
    const step = direction === "up" ? -1 : 1;
    let targetIndex =
      selectedIndices.length === 0
        ? direction === "up"
          ? rows.length - 1
          : 0
        : direction === "up"
          ? selectedIndices[0] - 1
          : selectedIndices[selectedIndices.length - 1] + 1;
    while (
      targetIndex >= 0 &&
      targetIndex < rows.length &&
      ui.expandedId === rows[targetIndex].id
    ) {
      targetIndex += step;
    }
    if (targetIndex < 0 || targetIndex >= rows.length) return;
    const target = rows[targetIndex];
    setSelected(new Set([target.id]));
    rowIdToScroll = target.id;
  }

  // Enter: expand the first selected todo (projects don't expand) and focus its
  // title input.
  function activateFirstSelected() {
    const first = entries.find((e) => !isProjEntry(e) && ui.selected.has(e.id));
    if (!first || ui.expandedId === first.id) return;
    setExpanded(first.id);
    rowIdToReveal = first.id;
    setSelected(new Set());
    focusTitleSoon(first.id);
  }

  usePanelKeydown((e) => {
    const base =
      e.key === "Enter" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      (e.key === "a" && (e.metaKey || e.ctrlKey));
    // The inbox additionally creates on Space and trashes on Delete/Backspace.
    const inboxOnly =
      ui.kind === "inbox" && (e.key === " " || e.key === "Delete" || e.key === "Backspace");
    if (!base && !inboxOnly) return;
    e.preventDefault();
    if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
      if (entries.length > 0) setSelected(new Set(entries.map((en) => en.id)));
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      navigateSelection(e.key === "ArrowUp" ? "up" : "down");
      return;
    }
    if (e.key === "Enter") {
      activateFirstSelected();
      return;
    }
    if (e.key === " ") {
      createTodo();
      return;
    }
    // Delete / Backspace → trash the selected inbox todos.
    if (ui.selected.size > 0) {
      movePlacement("inbox", new Set(ui.selected), "trash");
      setSelected(new Set());
    }
  });

  // Scroll the navigation target into view (no expand).
  const scrollIntoViewControl: Attachment<HTMLElement> = (node) => {
    $effect(() => {
      if (rowIdToScroll == null) return;
      const rowId = rowIdToScroll;
      untrack(() => {
        rowIdToScroll = null;
      });
      const el = rowDivElements[rowId];
      if (!el) return;
      scrollRowIntoView(node, el);
    });
  };

  // ─── Layout / drag-insert wiring ─────────────────────────────────────────────

  // Vertical breathing room above the first row and below the last (the
  // DragList forces its own padding-top/bottom to 0, so edge spacing comes from
  // here). Matches the px-4 horizontal padding.
  const edgePadding = 16;

  // Spacing when prev or current entry is the expanded one, plus edge padding at
  // the top of the first row / bottom of the last.
  const getMarginTop = (pre: PlacementEntry | null, cur: PlacementEntry | null) => {
    const expanded =
      (cur != null && !isProjEntry(cur) && ui.expandedId === cur.id) ||
      (pre != null && !isProjEntry(pre) && ui.expandedId === pre.id);
    const edge = pre == null || cur == null;
    return Math.max(edge ? edgePadding : 0, expanded ? expandedSpacing : 0);
  };

  function onInsertActive(
    items: ItemInsert[],
    toRender: PlacementEntry[],
    toDerender: PlacementEntry[],
  ) {
    const hasInsertable = items.some(acceptsItem);
    if (!hasInsertable) return { insertables: [] };
    if (toDerender.length > 0) return { insertables: [] };
    // The edge padding sits above the inserted item (spacePrecede); spaceFollow
    // is only the gap to the next row — non-zero just when the first row is
    // expanded. (getMarginTop(null, first) bundles in the edge padding, so it
    // can't be reused for spaceFollow directly.)
    const first = toRender[0] ?? null;
    const firstExpanded = first != null && !isProjEntry(first) && ui.expandedId === first.id;
    return {
      insertables: [
        { index: 0, spacePrecede: edgePadding, spaceFollow: firstExpanded ? expandedSpacing : 0 },
      ],
    };
  }

  function onInsertTargeted(
    _index: number,
    insertion: Insertion<ItemInsert, InsertInfo>,
    node: HTMLDivElement,
  ): TargetPrep<TargetInfo> {
    const { fromProjId } = insertion.info;
    const fromPlacement = asPlacement(fromProjId);
    // Same-placement drops are a no-op.
    if (fromPlacement === ui.kind) return { move: () => {}, info: {} };
    const projIds = new Set(
      insertion.items.filter((it) => it.kind === "proj" && acceptsItem(it)).map((it) => it.id),
    );
    const todoIds = new Set(
      insertion.items.filter((it) => it.kind !== "proj" && acceptsItem(it)).map((it) => it.id),
    );
    const insertableIds = new Set<string>([...projIds, ...todoIds]);
    const snapBackIds = new Set(
      insertion.items.filter((it) => !insertableIds.has(it.id)).map((it) => it.id),
    );
    return {
      move: () => {
        // Project rows only exist in archive/trash, so a project drop is always
        // a move between those two.
        if (
          projIds.size > 0 &&
          ui.kind !== "inbox" &&
          (fromPlacement === "archive" || fromPlacement === "trash")
        ) {
          moveProjectBetweenPlacements(fromPlacement, projIds, ui.kind);
        }
        if (todoIds.size > 0) {
          if (fromPlacement != null) movePlacement(fromPlacement, todoIds, ui.kind);
          else moveToPlacement(fromProjId, todoIds, ui.kind);
        }
        setSelected(insertableIds);
        // Shift keyboard focus to this panel on drop, mirroring TodoList.
        panelFocus.setFocus(panelId, "main");
      },
      info: { pileWidth: node.getBoundingClientRect().width },
      snapBackIds,
    };
  }

  // ─── Row interaction ─────────────────────────────────────────────────────────

  function collapseRow(id: string) {
    // Flush any pending title/note edit (Input updates on blur) before tearing
    // down the expanded view, then collapse and select the row — mirrors the
    // project page (TodoList), where collapsing reselects the row.
    (document.activeElement as HTMLElement | null)?.blur?.();
    setExpanded(null);
    collapsing[id] = true;
    setSelected(new Set([id]));
  }

  function makeDragHandle(
    entry: PlacementEntry,
    prepare: (p: DragPrep<ItemInsert, InsertInfo>) => void,
  ) {
    return (node: HTMLElement) => {
      let pendingClick: (() => void) | undefined;

      const handleMouseDown = (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        // Selecting another row blurs the focused title input of an expanded
        // todo — the preventDefault above would otherwise keep it focused. This
        // matches the project page, where mousedown moves focus to the row.
        (document.activeElement as HTMLElement | null)?.blur?.();

        const plan = resolveRowMouseDown(
          ev,
          entry.id,
          entries.map((e) => e.id),
          ui.selected,
        );
        if (plan.apply) setSelected(plan.apply);
        const onClick = plan.onClick;
        pendingClick = onClick ? () => setSelected(onClick(ui.selected)) : undefined;

        const dragIds = plan.apply ?? ui.selected;
        const dragEntries = entries.filter((e) => dragIds.has(e.id));
        const items: ItemInsert[] = dragEntries.map((e) => ({
          raw: entryToDragRaw(e),
          id: e.id,
          isSelected: true,
          ...(isProjEntry(e) &&
            ui.kind !== "inbox" && { kind: "proj" as const, tone: PROJ_TONE[ui.kind].row }),
        }));

        if (items.length > 0)
          prepare({
            items,
            anchorId: entry.id,
            mouseDown: { x: ev.clientX, y: ev.clientY },
            condition: (dx, dy) => Math.sqrt(dx ** 2 + dy ** 2) > 4,
            info: { fromProjId: ui.kind },
          });
      };

      const handleClick = () => pendingClick?.();
      node.addEventListener("mousedown", handleMouseDown);
      node.addEventListener("click", handleClick);
      return () => {
        node.removeEventListener("mousedown", handleMouseDown);
        node.removeEventListener("click", handleClick);
      };
    };
  }

  function handleRowDblClick(entry: PlacementEntry) {
    if (ui.expandedId === entry.id) {
      collapseRow(entry.id);
    } else {
      setExpanded(entry.id);
      rowIdToReveal = entry.id;
      setSelected(new Set());
      focusTitleSoon(entry.id);
    }
  }

  function clearSelectionOnBlank(node: HTMLElement) {
    const handler = (ev: MouseEvent) => {
      if (!(ev.target as Element).closest("[data-placement-row]")) {
        setSelected(new Set());
      }
    };
    node.addEventListener("mousedown", handler);
    return () => node.removeEventListener("mousedown", handler);
  }
</script>

<div class="flex size-full flex-col">
  <PlacementTitle {title} {topBarHeight} {sideReveal} {resizingSide} />
  <div class="relative min-h-0 flex-1">
    <DragList
      class="h-full overflow-y-auto px-4"
      data={entries}
      allowInsert="all"
      transitionMarginTop
      transitionRearrange="data-change"
      {getMarginTop}
      {onInsertActive}
      {onInsertTargeted}
      useInserter={useTodoListInserter}
      compositeContent
      keepDraggedRows
      {@attach clearSelectionOnBlank}
      {@attach scrollIntoViewControl}
      {@attach revealOnExpand({
        rowIdToReveal: () => rowIdToReveal,
        clear: () => {
          rowIdToReveal = null;
        },
        rowEl: (id) => rowDivElements[id],
        endHeight: (id) => todoRowElements[id]?.getEndHeight(),
      })}
    >
      {#snippet phantom()}
        <div class="mx-2 h-full rounded-md bg-gray-200"></div>
      {/snippet}
      {#snippet row(items, entry, index, prepare)}
        {@const dragHandle = makeDragHandle(entry, prepare)}
        {@const isSelected = ui.selected.has(entry.id)}
        {@const prevSelected = index > 0 && ui.selected.has(items[index - 1].id)}
        {@const nextSelected = index < items.length - 1 && ui.selected.has(items[index + 1].id)}
        {#if isProjEntry(entry) && ui.kind !== "inbox"}
          {@const tone = PROJ_TONE[ui.kind]}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            data-placement-row
            bind:this={rowDivElements[entry.id]}
            class={[
              "mx-2 flex h-8 items-center overflow-hidden rounded-md",
              tone.row,
              isSelected && "bg-selection",
              prevSelected && "rounded-t-none",
              nextSelected && "rounded-b-none",
            ]}
            ondblclick={() => enterProject(entry)}
            oncontextmenu={(ev) => openContextMenu(ev, entry.id)}
          >
            <!-- Clickable drill-in. Matches a todo row's tickbox geometry
                 (size-8 box, 16px glyph) so the icon lines up with the checkbox.
                 The drag/select handle covers only the name (below), so a click
                 on the icon opens the project without selecting the row — like a
                 todo's tickbox sitting outside the todo's drag overlay. -->
            <button
              class="group flex size-8 shrink-0 cursor-pointer items-center justify-center"
              aria-label="Open project"
              onclick={() => enterProject(entry)}
            >
              <!-- size-8 button keeps the hit area and checkbox alignment; the
                   darkened hover region is the slightly smaller inner square. -->
              <span class={["flex size-7 items-center justify-center rounded-md", tone.hover]}>
                <span class="icon-[ri--folder-fill] size-4"></span>
              </span>
            </button>
            <!-- Fills the row height so the drag/select area is flush with the
                 adjacent rows' (no dead band between them); pl/pr match a todo
                 title's so the names line up too. -->
            <span
              class="flex h-full min-w-0 grow cursor-default items-center pr-1.5 pl-0.5 text-sm font-medium select-none"
              {@attach dragHandle}
            >
              <span class="truncate">{entry.name || placeholder.project.name}</span>
            </span>
          </div>
        {:else if !isProjEntry(entry)}
          {@const todo = asTodoItem(entry)}
          {@const todoMut = todoMutFor(entry.id)}
          {@const isExpanded = ui.expandedId === entry.id}
          {@const isCollapsing = collapsing[entry.id]}
          {@const topOffset = getMarginTop(items[index - 1] ?? null, entry)}
          {@const bottomOffset = getMarginTop(entry, items[index + 1] ?? null)}
          {#if isExpanded}
            <!-- svelte-ignore a11y_consider_explicit_label -->
            <button
              class="absolute inset-x-0"
              style:top="-{topOffset}px"
              style:bottom="-{bottomOffset}px"
              onmousedown={() => {
                (document.activeElement as HTMLElement | null)?.blur?.();
              }}
              onclick={() => collapseRow(entry.id)}
            ></button>
          {/if}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            data-placement-row
            bind:this={rowDivElements[entry.id]}
            ontransitionend={isCollapsing
              ? (e) => {
                  if (e.propertyName !== "background-color") return;
                  collapsing[entry.id] = false;
                }
              : null}
            class={[
              "relative h-fit overflow-hidden rounded-md",
              isExpanded
                ? "bg-white px-2 py-2 shadow-lg"
                : isSelected
                  ? "bg-selection mx-2"
                  : "mx-2",
              !isExpanded && prevSelected && "rounded-t-none",
              !isExpanded && nextSelected && "rounded-b-none",
              (isExpanded || isCollapsing) &&
                "transition-[margin,padding,background-color,box-shadow] duration-200",
            ]}
            ondblclick={!isExpanded ? () => handleRowDblClick(entry) : null}
            oncontextmenu={!isExpanded ? (ev) => openContextMenu(ev, entry.id) : null}
          >
            <TodoRow
              bind:this={todoRowElements[entry.id]}
              {todo}
              expanded={isExpanded}
              draghandle={isExpanded ? undefined : dragHandle}
              mut={todoMut}
              onEnter={() => collapseRow(entry.id)}
              onEscape={() => collapseRow(entry.id)}
            />
          </div>
        {/if}
      {/snippet}
    </DragList>
    {#if entries.length === 0}
      <div
        class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-400"
      >
        {title} is empty
      </div>
    {/if}
  </div>
</div>
