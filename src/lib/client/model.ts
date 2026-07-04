import { CalendarDate } from "@internationalized/date";
import type { ReadonlyDeep } from "../utils/type-gymnastics";

type Item = { id: string };

export type CheckItem = Item & {
  ticked: boolean;
  text: string;
};

export type TodoStatus = "complete" | "todo";

export type TodoItem = Item & {
  title: string;
  note: string;
  checks: CheckItem[];
  status: TodoStatus;
  planned: CalendarDate | null;
};

export type GroupingItem = Item & {
  label: string;
};

export type RowItem = GroupingItem | TodoItem;

export const isGroupingItem = (item: RowItem): item is GroupingItem => {
  return "label" in item;
};

export const isTodoItem = (item: RowItem): item is TodoItem => {
  return "title" in item && "status" in item;
};

export type ProjectItem = Item & {
  name: string;
  note: string;
  rows: RowItem[];
};

type Raw<T> = Omit<T, "id">;

export type TodoInitData = Partial<Raw<TodoItem>>;

export type GroupingInitData = Partial<Raw<GroupingItem>>;

export type CheckInitData = Partial<Raw<CheckItem>>;

export type ProjectInitData = Partial<Raw<ProjectItem>>;

const fallbackUuid = (): string => {
  const bytes = new Uint8Array(16);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

export const newId = (): string => globalThis.crypto?.randomUUID?.() ?? fallbackUuid();

export const newTodoItem = (data: TodoInitData = {}): TodoItem => {
  const { title, note, checks, status, planned } = data;
  return {
    id: newId(),
    title: title ?? "",
    note: note ?? "",
    checks: checks ?? [],
    status: status ?? "todo",
    planned: planned ?? null,
  };
};

export const newGroupingItem = (data: GroupingInitData = {}): GroupingItem => ({
  id: newId(),
  label: data.label ?? "",
});

export const newCheckItem = (data: CheckInitData = {}): CheckItem => ({
  id: newId(),
  ticked: data.ticked ?? false,
  text: data.text ?? "",
});

export const newProjectItem = (data: ProjectInitData = {}): ProjectItem => ({
  id: newId(),
  name: data.name ?? "",
  note: data.note ?? "",
  rows: data.rows ?? [],
});

export type PanelLayout = {
  mainWidth: number;
  height: number;
  sideShow: boolean;
  sideWidth: number | "disabled";
  spacerLeft: number | "disabled";
};

export type ProjectInstance = {
  // must reassign the whole instance to change project
  readonly project: ProjectItem;
  rowSelected: Record<string, boolean | undefined>;
  todoExpanded: Record<string, boolean | undefined>;
};

type InstanceInitData = { project: ProjectItem } & Partial<ProjectInstance>;

// Placement views (inbox/archive/trash) carry per-panel row UI state, just like
// a ProjectInstance — selecting/expanding in one panel must not bleed into
// another panel showing the same placement, and the state dies with the
// instance when the panel switches away or closes.
export type PlacementName = "inbox" | "archive" | "trash";

// Operations with no per-row UI state; stored on a panel as bare strings.
export type SimpleOperation = "planned" | "search" | "account";

// The string identifier for a view a panel can show (used by the navbar /
// switcher / sidebar menus). Distinct from the panel's stored instance, which
// is an object for projects and placements.
export type OperationInstance = PlacementName | SimpleOperation;

export type PlacementInstance = {
  readonly kind: PlacementName;
  selected: Set<string>;
  expandedId: string | null;
};

export type Instance = ProjectInstance | PlacementInstance | SimpleOperation;

export const isProjectInstance = (inst: Instance): inst is ProjectInstance => {
  return typeof inst === "object" && inst !== null && "project" in inst;
};

export const isPlacementInstance = (inst: Instance): inst is PlacementInstance => {
  return typeof inst === "object" && inst !== null && "kind" in inst;
};

const placementNames = new Set<OperationInstance>(["inbox", "archive", "trash"]);

export const isPlacementName = (op: OperationInstance): op is PlacementName =>
  placementNames.has(op);

// The view-selector string for a panel instance: a placement/simple-operation
// name, or null for a project instance.
export const operationOf = (inst: Instance): OperationInstance | null => {
  if (isProjectInstance(inst)) return null;
  return isPlacementInstance(inst) ? inst.kind : inst;
};

// Turn a menu selection (OperationInstance string) into a panel instance:
// placements become fresh objects with their own UI state, simple operations
// stay as strings.
export const operationToInstance = (op: OperationInstance): PlacementInstance | SimpleOperation =>
  isPlacementName(op) ? newPlacementInstance(op) : op;

export type PanelItem = Item & {
  layout: PanelLayout;
  instance: Instance;
};

export const newProjectInstance = (data: InstanceInitData): ProjectInstance => {
  const { project, rowSelected, todoExpanded } = data;
  return {
    project, // will keep project's identity
    rowSelected: rowSelected ?? {},
    todoExpanded: todoExpanded ?? {},
  };
};

export const newPlacementInstance = (
  kind: PlacementName,
  selected: Set<string> = new Set(),
  expandedId: string | null = null,
): PlacementInstance => ({ kind, selected, expandedId });

export const newPanelItem = (data: {
  id?: string;
  layout?: Partial<PanelLayout>;
  instance: Instance;
}): PanelItem => {
  const { id, layout, instance } = data;
  const { mainWidth, height, sideWidth, spacerLeft, sideShow } = layout ?? {};
  return {
    id: id ?? newId(),
    layout: {
      mainWidth: mainWidth ?? 450,
      height: height ?? 680,
      sideShow: sideShow ?? false,
      sideWidth: sideWidth === undefined ? "disabled" : sideWidth,
      spacerLeft: spacerLeft === undefined ? 60 : spacerLeft,
    },
    instance,
  };
};

export const placeholder: Readonly<{
  project: Pick<ProjectItem, "name" | "note">;
  todo: Pick<TodoItem, "title" | "note">;
  grouping: Pick<GroupingItem, "label">;
}> = {
  project: { name: "Some Project", note: "Notes" },
  todo: { title: "New To-Do", note: "Notes" },
  grouping: { label: "New Heading" },
};

// ─── Placement view entry types ───────────────────────────────────────────────

export type ArchiveTodoEntry = {
  kind: "todo";
  id: string;
  title: string;
  note: string;
  done: boolean;
  planned: string | null;
  projId: string | null;
  checks: CheckItem[];
};

export type ArchiveProjEntry = {
  kind: "proj";
  id: string;
  name: string;
};

export type ArchiveEntry = ArchiveTodoEntry | ArchiveProjEntry;

// ─── App state ────────────────────────────────────────────────────────────────

// Where a project lives, mirroring the server's proj placement: the active
// project list, or filed under archive/trash.
export type ProjPlacement = "list" | "archive" | "trash";

// Everything the client tracks about one project, in one place.
export type ProjEntry = {
  // The reactive project object. Panels hold references to it, so it keeps its
  // identity for as long as the entry lives.
  project: ProjectItem;
  placement: ProjPlacement;
  // Whether `project.rows` holds the project's content. False = a name-only
  // entry whose rows are fetched when a panel first shows it. Signed out there
  // is no server to fetch from, so entries are always loaded.
  loaded: boolean;
};

export type AppState = {
  panels: PanelItem[];
  // Every project the client knows, keyed by id:
  //  - the active list (placement "list", ordered by `projOrder`), and
  //  - archived/trashed projects a panel has drilled into.
  // Signed out, archived/trashed entries additionally serve as the backing
  // store for their rows (there is no server to hold them), so they are never
  // evicted; signed in, a drill-in entry is dropped once no panel shows it and
  // its rows are re-fetched fresh on the next open (see pruneDrillIns).
  projs: Record<string, ProjEntry>;
  // The active project list, in display order. An id is here iff its entry's
  // placement is "list".
  projOrder: string[];
  inbox: TodoItem[];
  archive: ArchiveEntry[];
  trash: ArchiveEntry[];
  // Whether each placement view's entries have been fetched. Guests have all
  // their data locally (always true); signed in, only the views the open
  // panels showed are bootstrapped and the rest load on first show.
  placementLoaded: Record<PlacementName, boolean>;
};

export const projOf = (state: AppState, projId: string): ProjectItem | null =>
  state.projs[projId]?.project ?? null;

// The active project list in order (the sidebar / switcher / list-order push).
export const activeProjects = (state: AppState): ProjectItem[] =>
  state.projOrder.flatMap((id) => {
    const entry = state.projs[id];
    return entry ? [entry.project] : [];
  });

// The placement view a project panel drilled in from, or null for an
// active-list project. Such a project renders as a normal project page plus a
// "Back to Archive/Trash" affordance, and stays out of the active list.
export const drilledFrom = (state: AppState, projId: string): "archive" | "trash" | null => {
  const placement = state.projs[projId]?.placement;
  return placement === "archive" || placement === "trash" ? placement : null;
};

// Register a set of fully-loaded active projects (guest/mock bootstrap).
export const projsFromList = (projects: ProjectItem[]): Pick<AppState, "projs" | "projOrder"> => ({
  projs: Object.fromEntries(
    projects.map((p) => [p.id, { project: p, placement: "list" as const, loaded: true }]),
  ),
  projOrder: projects.map((p) => p.id),
});
