# UI Refactor Recommendations

> **Status (2026-07-03): implemented.** Steps 1–5 of the sequencing below are done
> in full; P4 items done: semantic color tokens (`bg-selection`/`bg-surface` in
> app.css `@theme`), `BarButton`/`PanelBottomBar`, shared expand constants and
> `trans-margin` utility. Deliberately deferred (still opportunistic): selection-
> model unification, layout-prop context, `RowStack` for UserView, zod at the
> sync boundary, and the `$lib` barrel decision (kept; the reported `PopupArg`
> collision turned out to be already handled by aliasing in `popups/index.ts`).
> ProjectList's mousedown selection kept its bespoke logic (shown-project rules).
> Verified: svelte-check 0 errors, production build, and a headless-browser
> end-to-end pass (inbox→archive→trash flows, context menus, keyboard nav).

Reviewed: all of `src/routes/*.svelte`, `src/lib/components/**`, and the client
state layer they lean on (`mutate-remote.ts`, `mutate-local.ts`, `context.ts`).
~13k lines of Svelte 5 across 66 files.

**Overall shape is good.** The layered architecture is sound: `DragList`/`InsertPile`
as a generic drag engine, context-provided mutator hooks, panel chrome
(`ResizePanel`/`PanelGroup`) separated from content views, popups as context
providers. The problems are not architectural — they are *replication*: the same
behaviors have been copy-pasted into 3–5 places and have started to drift.

Priorities below are ordered by payoff ÷ risk.

---

## P1 — Merge the three placement views (biggest single win)

[InboxView.svelte](src/lib/components/operation-list/InboxView.svelte) (520 lines),
[ArchiveView.svelte](src/lib/components/operation-list/ArchiveView.svelte) (626),
[TrashView.svelte](src/lib/components/operation-list/TrashView.svelte) (666)
are ~90% identical, line for line:

- `navigateSelection`, `activateFirstSelected`, `focusTitleSoon` — identical ×3
- the global-keydown effect (guard clauses included) — identical ×3 (inbox adds Space/Delete)
- `scrollIntoViewControl` attachment — identical ×3 (and a 4th copy inline in
  [TodoList.svelte:320](src/lib/components/todo-panel/TodoList.svelte#L320))
- `makeDragHandle` (mousedown select/range/duo logic + drag prep) — identical ×3
  except the `fromProjId` string and pile tone
- `collapseRow`, `handleRowDblClick`, `clearSelectionOnBlank`, `getMarginTop`,
  `entryToTodoItem`, `entryToDragRaw`, the `initialExpandedId`/`initialSelectedId`
  mount effects, `expandedSpacing`/`edgePadding` constants — identical ×3
- the entire row template (expanded-overlay button, collapse transition classes,
  `TodoRow` wiring, selected/prev/next rounding, project-row drill-in markup,
  empty-state overlay) — identical ×3 modulo the `data-*-row` attribute,
  a tone class (`text-gray-400` vs `text-cyan-600`), and the empty text

What actually differs is small and enumerable:

| Concern | Inbox | Archive | Trash |
|---|---|---|---|
| entries source | `appState.inbox` (todos only) | `appState.archive` | `appState.trash` |
| accepts on drop | any todo | completed todos + projects | todos + projects |
| context-menu actions | mark/archive/trash | unarchive/trash | mark/restore/purge(confirm) |
| extra exports | `createTodo` | — | `confirmPurge` |
| todo mutators | `*Inbox*` family | `*Archive*` family (status stripped) | `*Trash*` family |

**Recommendation:** one `PlacementView.svelte` + a per-placement config object
(`{ kind, accepts(item), contextMenu(entries, ui): MenuSpec, mut, emptyText, projectTone }`).
Keep the three files as thin (~40-line) wrappers if you want per-placement
exports, or fold them entirely and switch on `kind` in `OperationPage`. This
deletes roughly **1,200 lines** and, more importantly, ends the drift — the three
copies are already subtly inconsistent (Trash clamps its menu height with a
mark-row term, Archive hardcodes `2 * 40`; only Inbox handles Delete/Backspace).

Do this first; several P2 items fall out of it for free.

## P1b — Collapse the per-placement mutator families

[mutate-remote.ts](src/lib/client/mutate-remote.ts) (1,083 lines, 48 hooks) mirrors
the view triplication: `useEditInboxTodo` / `useEditArchiveTodo` / `useEditTrashTodo`,
plus ×3 families for `Edit/Move/Create/DeleteCheck`, `setPlanned`, `mark`. Each
trio differs only in the placement name it writes to.

**Recommendation:** parameterize by placement —
`useEditPlacementTodo(placement)`, `usePlacementCheckMut(placement)`, etc.
This also kills the inline `todoMut` adapter objects each view rebuilds inside
its row snippet ([InboxView.svelte:458](src/lib/components/operation-list/InboxView.svelte#L458)
and twins): define one `TodoMutator` interface (it already implicitly exists as
`TodoRow`/`ExpandedTodo`'s `mut` prop) and one
`makePlacementTodoMut(placement, todoId)` factory next to the hooks.

---

## P2 — Extract the four cross-cutting duplicated behaviors

These recur beyond the placement views and deserve named homes
(suggestion: `src/lib/components/list-kit/` or `src/lib/client/ui/`).

### 1. Panel-scoped keyboard handling
Five components install `document`-level keydown listeners with the same
boilerplate: derive `isKeyboardTarget` from `panelFocus`, bail on
input/textarea/contenteditable targets, key whitelist, `preventDefault`
([PanelGroup.svelte:118](src/lib/components/PanelGroup.svelte#L118),
[PanelMain.svelte:38](src/lib/components/PanelMain.svelte#L38), and the three
placement views). Extract:
- `isEditableTarget(e: KeyboardEvent): boolean` (currently copied 5×)
- `usePanelKeys(keys: string[], handler)` that owns the effect, the focus gate,
  and the guards — call sites shrink to a key→action map.

### 2. Reveal-on-expand scrolling
Three independent implementations of the same "scroll an expanding row into
view, predicting its settled height" algorithm, including the identical
`isRowTall / isRowOutsideView / isRowOverlapsBottom → target` decision tree and
the margin-transition correction:
- [revealOnExpand.svelte.ts](src/lib/components/operation-list/revealOnExpand.svelte.ts)
- [user-panel/reveal.ts](src/lib/components/user-panel/reveal.ts)
- inline in [TodoList.svelte:338-401](src/lib/components/todo-panel/TodoList.svelte#L338-L401)

Extract one `computeRevealTarget({top, bottom, viewTop, viewHeight})` +
`revealInContainer(container, handle, opts, onDone)` and make all three thin
wrappers. The plain `rowIdToScroll` scroller (4 identical copies) folds into the
same module.

### 3. Context-menu placement
Every caller of `contextMenu.popup` hand-estimates the menu size
(`menuWidth = 224`, `menuHeight = N * 40` with a hand-counted N) and clamps
against the viewport — 5 copies ([TodoList.svelte:269](src/lib/components/todo-panel/TodoList.svelte#L269),
[ProjectList.svelte:321](src/lib/components/project-list/ProjectList.svelte#L321),
three placement views). These estimates are fragile: they must be updated by
hand whenever a menu row is added (TrashView's already accounts for its extra
row; ArchiveView's is hardcoded).

**Recommendation:** move clamping into
[ContextMenuPopup.svelte](src/lib/components/popups/ContextMenuPopup.svelte)
itself — measure the rendered menu (`bind:clientWidth/Height`) and clamp, exactly
as [ConfirmPopup.svelte:43-58](src/lib/components/popups/ConfirmPopup.svelte#L43-L58)
already does for its point-positioned bubble. Call sites then pass the raw
event point and delete ~20 lines each.

### 4. Row selection / drag-handle mousedown protocol
The mousedown → (range | toggle | replace | pending-click) → `prepare(drag)`
protocol exists in three near-identical copies (placement views — gone after P1)
plus two structural variants ([TodoList.svelte:404](src/lib/components/todo-panel/TodoList.svelte#L404),
[ProjectList.svelte:183](src/lib/components/project-list/ProjectList.svelte#L183)).
After P1, factor the shared core (`resolveSelectionOnMouseDown(ev, id, selection) →
{ nextSelection?, pendingClick? }`) and keep the grouping-expansion (TodoList) and
shown-project (ProjectList) rules as call-site logic. Also extract the shared
agreed-planned-date helper (`getAgreedDate` — 4 copies: PanelMain + 3 views).

---

## P3 — Structure & hygiene

### Decompose `routes/+page.svelte` (660 lines)
It currently owns bootstrap-shape conversion, panel-composition restore,
lazy-load orchestration, the whole auth-change state machine, and `refresh()`.
Almost none of it needs to be in a component. Move to `src/lib/client/`:
- `bootstrap-apply.ts` — `projectsFromBootstrap`, `inboxFromDelta`, stub init,
  `seedSyncedAtSeq`
- `panel-restore.ts` — `panelsFromComposition`, `applyStoredPanels`,
  `overlayRowState`, `restorePlacementProjects`, `compositionMatches`
- `app-session.ts` — `onAuthChange` + `refresh` (they mutate `appState` which
  can be passed in)

The route then shrinks to: build `appState`, register contexts, three effects,
`onMount`. This also makes the auth flows unit-testable.

### Kill the `$lib` barrel or commit to it
[index.ts](src/lib/index.ts) re-exports a mix of model types, some component
folders, and DOM utils — so imports are inconsistent everywhere (same file pulls
`Input` from `$lib` but `TodoList` by full path; `usePicker` from `$lib` but
`useSetPlacementSelected` by full path). Two popup modules also both export a
type named `PopupArg`, which `export *` handles by silently dropping the name.
Either make the barrel complete and canonical, or (simpler) drop it and import
from real paths. Pick one; today it's both.

### Panel chrome placement & naming
- [routes/Panel.svelte](src/routes/Panel.svelte) is the only panel component
  living in `routes/`; move it next to `PanelGroup`/`PanelMain`/`PanelSide`/
  `ResizePanel` (e.g. `lib/components/panel/`). Those five + `NavBar` are one
  subsystem and deserve a folder.
- Two components named `NavBar`: the real one and
  [todo-panel/NavBar.svelte](src/lib/components/todo-panel/NavBar.svelte), which
  is an **empty 1-line file** — delete it.
- `operation-list/` contains the placement *pages* (Inbox/Archive/Trash/
  OperationPage) and also the sidebar operation *list* — after P1, split into
  `placement-view/` and keep `OperationList` with the sidebar.

### Dead code / leftovers (quick cleanup pass)
- [Inputbar.svelte:2](src/lib/components/Inputbar.svelte#L2) imports `json`
  from `@sveltejs/kit` — unused server import in a client component.
- [PanelMain.svelte:105](src/lib/components/PanelMain.svelte#L105) and
  [PanelMain.svelte:130](src/lib/components/PanelMain.svelte#L130) call
  `setProjContext` twice with the same value.
- [DragList.svelte:91](src/lib/components/drag-insert-list/DragList.svelte#L91)
  imports the concrete `InsertInfo` from check-list while also declaring a
  generic parameter named `InsertInfo` — the import is shadowed; delete it.
- Large commented-out blocks: [PanelGroup.svelte:54-67](src/lib/components/PanelGroup.svelte#L54-L67),
  [Input.svelte:54-61](src/lib/components/Input.svelte#L54-L61) (+ debug line 275),
  commented `projIdToReveal` in ProjectList, commented icon experiments in
  Inputbar/NavBar.
- Public-API typos worth fixing while the surface is still internal:
  `swicherOpacity` (NavBar prop), the `comfine` family (`getComfine`,
  `getPileComfinedOffsetTop` — "confine") and `"internal-guesture"`
  ("gesture") across `drag-insert-list/`.

---

## P4 — Consistency (do opportunistically)

### One selection/expansion model
Project instances use `Record<string, boolean|undefined>` maps
(`rowSelected`, `todoExpanded`, multi-expand allowed); placement instances use
`Set<string>` + single `expandedId`; `PanelSide` keeps its own local
`projsSelected` record. Three shapes for one behavior means every shared helper
above needs adapters. Recommend standardizing on `{ selected: Set<string>,
expandedId: string | null }` (the placement shape — simpler, and multi-expand in
projects appears unused in practice: `activateFirstSelected` collapses others).
This is the enabler that lets P1/P2 helpers stay generic instead of duplicated
per shape.

### Bottom-bar buttons
The `flex h-7 w-16 items-center justify-center rounded-full border
border-transparent hover:border-gray-300 active:bg-gray-300/20` pill button is
repeated 9× across PanelMain, OperationPage, and PanelSide, and the focused
bottom-bar wrapper (`sectionFocused ? "border-t-2 border-t-teal-500" : …`) twice.
Extract a `BarButton.svelte` (icon, label, disabled, onclick) and a
`PanelBottomBar.svelte`.

### Design tokens
Selection pink (`bg-pink-200/100/300`), accent teal, surfaces
`bg-[#f5f5f7]`/`bg-[#f9fafb]`, and the timing constants
(`expandedSpacing = 30`, `expandDuration = 200`, grace/spinner windows, row
heights 32/28) are scattered as literals. Define Tailwind v4 `@theme` tokens
(`--color-selection`, `--color-surface`, `--color-surface-dim`) in `app.css` and a
`src/lib/components/constants.ts` for the shared numbers. Cheap now, near
impossible after more views ship; also the prerequisite for any dark-mode work.

### Layout-prop drilling
`topBarHeight` / `bottomBarHeight` / `sideReveal` / `resizingSide` are threaded
through 3–4 layers (ResizePanel snippets → Panel → PanelMain/OperationPage →
views → PlacementTitle). You already have a panel context
([context.ts](src/lib/client/context.ts)); extend it with a reactive
`panelLayout` (getters) and drop the pass-through props.

### UserView row-margin system
[UserView.svelte:363-437](src/lib/components/user-panel/UserView.svelte#L363-L437)
hand-rolls a `visibleRows`/`getMarginTop`/`margins` system plus ten repeated
`<div style:margin-top class="trans-margin">` wrappers (and `.trans-margin` is
declared twice, in UserView and UserPanel). A small `RowStack.svelte` that takes
`{kind, expanded}` entries and renders children with computed margins would
halve the template. Lower priority — it's self-contained and correct.

### Typing at the sync boundary
The `as ArchiveEntry[]` / inline-shape casts in
[+page.svelte:81-91](src/routes/+page.svelte#L81-L91) and the `any` +
eslint-disable in UserView's `guarded()` push server-shape trust into the UI.
Zod is already a dependency — parse `PlacementDelta` entries and the auth API
responses once at the fetch layer and let components receive typed data.

---

## What NOT to touch

- **`DragList` / `InsertPile` / `ReceiveList` internals.** This is the most
  intricate code in the app, full of hard-won browser-quirk knowledge (Safari
  transform/scroll workarounds, comfine/scroll interplay). The recommendations
  above deliberately refactor *around* it: unify its callers, keep its API.
  Fix the typos, add nothing else.
- **`Input.svelte`'s caret/contenteditable machinery** — same reasoning; the
  dirty-flag and Blink/WebKit comments encode real bugs already fought.
- **Panel spinner/grace/progress timing in `Panel.svelte`** — recently tuned UX;
  fine as is.

## Suggested sequencing

1. Quick hygiene pass (dead file, unused imports, double `setProjContext`,
   commented blocks) — zero risk, do in one commit.
2. P1b mutator families (mechanical, type-checked by `svelte-check`).
3. P1 `PlacementView` merge — the big one; verify drag/drop between all
   placements, keyboard nav, context menus, drill-in/back after.
4. P2 extractions one at a time (keyboard → reveal → context-menu clamp →
   selection handle), converting TodoList/ProjectList/PanelMain as you go.
5. P3 route decomposition + import-path cleanup.
6. P4 opportunistically alongside feature work.

Steps 1–3 alone remove ~1,500 lines and eliminate the main drift hazard.
