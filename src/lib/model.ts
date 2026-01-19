import { CalendarDate } from "@internationalized/date";
import { getToday } from "./components/calendar/utils";

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
  deadline?: CalendarDate;
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

const newId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);

export const newTodoItem = (data: Partial<Raw<TodoItem>> = {}): TodoItem => {
  const { title, note, checks, status, deadline } = data;
  return {
    id: newId(),
    title: title ?? "",
    note: note ?? "",
    checks: checks ?? [],
    status: status ?? "todo",
    deadline: deadline ?? undefined,
  };
};

export const newGroupingItem = (data: Partial<Raw<GroupingItem>> = {}): GroupingItem => ({
  id: newId(),
  label: data.label ?? "",
});

export const newCheckItem = (data: Partial<Raw<CheckItem>> = {}): CheckItem => ({
  id: newId(),
  ticked: data.ticked ?? false,
  text: data.text ?? "",
});

export const newProjectItem = (data: Partial<Raw<ProjectItem>> = {}): ProjectItem => ({
  id: newId(),
  name: data.name ?? "",
  note: data.note ?? "",
  rows: data.rows ?? [],
});

export type PanelAppear = {
  mainWidth: number;
  height: number;
  // maybe, instead of using null, use number | "disable" ?
  sideShow: boolean;
  sideWidth: number | null; // if of type number, then refers to the stable clamped width
  spacerLeft: number | null;
};

export type ProjectInstance = {
  // must reassign the whole instance to change project
  readonly project: ProjectItem;
  rowSelected: Record<string, boolean | undefined>;
  todoExpanded: Record<string, boolean | undefined>;
};

type InstanceInitData = { project: ProjectItem } & Partial<ProjectInstance>;

export type OperationInstance = "clutter" | "timeline" | "archive" | "trash" | "search";

export type Instance = ProjectInstance | OperationInstance;

export const isProjectInstance = (inst: Instance): inst is ProjectInstance => {
  return typeof inst === "object" && inst !== null;
};

export type PanelItem = Item & {
  appear: PanelAppear;
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

export const newPanelItem = (data: {
  appear?: Partial<PanelAppear>;
  instance: InstanceInitData;
}): PanelItem => {
  const { appear, instance } = data;
  const { mainWidth, height, sideWidth, spacerLeft, sideShow } = appear ?? {};
  return {
    id: newId(),
    appear: {
      mainWidth: mainWidth ?? 400,
      height: height ?? 650,
      sideShow: sideShow ?? false,
      // default to side disabled
      sideWidth: sideWidth === undefined ? null : sideWidth,
      // spacerLeft === undefined, then use default
      // preserve spacerLeft === null, which carries meaning of disabling spacer
      spacerLeft: spacerLeft === undefined ? 60 : spacerLeft,
    },
    instance: newProjectInstance(instance),
  };
};

export const mockProjects: ProjectItem[] = [
  newProjectItem({
    name: "Work & Study",
    note: "Light daily tasks",
    rows: [
      newTodoItem({ title: "Read email" }),
      newTodoItem({ title: "Sync calendar" }),
      newTodoItem({
        title: "Plan today",
        checks: [
          newCheckItem({ text: "Review yesterday tasks" }),
          newCheckItem({ text: "Pick top 3 priorities" }),
          newCheckItem({ text: "Time block morning session" }),
        ],
      }),

      newGroupingItem({ label: "Focus Work" }),
      newTodoItem({
        title: "Finish report draft",
        checks: [
          newCheckItem({ text: "Outline sections" }),
          newCheckItem({ text: "Write introduction" }),
          newCheckItem({ text: "Add figures" }),
          newCheckItem({ text: "Proofread" }),
        ],
      }),
      newTodoItem({
        title: "Review lecture notes",
        checks: [
          newCheckItem({ text: "Re-read slides" }),
          newCheckItem({ text: "Summarize key points" }),
          newCheckItem({ text: "Write questions to follow up" }),
        ],
      }),
      newTodoItem({
        title: "Practice coding",
        deadline: getToday().add({ days: 7 }),
        checks: [
          newCheckItem({ text: "Warm up problem" }),
          newCheckItem({ text: "Main task" }),
          newCheckItem({ text: "Refactor solution" }),
          newCheckItem({ text: "Write small test cases" }),
        ],
      }),

      newGroupingItem({ label: "Admin" }),
      newTodoItem({ title: "Update timesheet" }),
      newTodoItem({
        title: "Prep for meeting",
        checks: [
          newCheckItem({ text: "Review agenda" }),
          newCheckItem({ text: "Write talking points" }),
          newCheckItem({ text: "Share documents" }),
        ],
      }),

      newGroupingItem({ label: "Learning" }),
      newTodoItem({
        title: "Read research article",
        checks: [
          newCheckItem({ text: "Abstract and intro" }),
          newCheckItem({ text: "Method section" }),
          newCheckItem({ text: "Highlight contributions" }),
          newCheckItem({ text: "Write two insights" }),
        ],
      }),
      newTodoItem({
        title: "Watch tutorial",
        checks: [
          newCheckItem({ text: "Pick topic" }),
          newCheckItem({ text: "Take notes" }),
          newCheckItem({ text: "Apply in small mini project" }),
        ],
      }),
    ],
  }),
  newProjectItem({
    name: "Groceries",
    note: "Weekly shopping",
    rows: [
      newGroupingItem({ label: "Produce" }),
      newTodoItem({ title: "Bananas", status: "complete" }),
      newTodoItem({ title: "Broccoli", status: "complete" }),
      newTodoItem({ title: "Carrots", status: "complete" }),
      newGroupingItem({ label: "Protein" }),
      newTodoItem({ title: "Chicken thighs" }),
      newTodoItem({ title: "Eggs", status: "complete" }),
      newTodoItem({ title: "Tofu", status: "complete" }),
      newGroupingItem({ label: "Pantry" }),
      newTodoItem({ title: "Rice" }),
      newTodoItem({ title: "Canned tomatoes" }),
      newTodoItem({ title: "Olive oil" }),
    ],
  }),

  newProjectItem({
    name: "House Chores",
    rows: [
      newGroupingItem({ label: "Daily" }),
      newTodoItem({ title: "Wash dishes" }),
      newTodoItem({ title: "Take out trash" }),
      newGroupingItem({ label: "Weekly" }),
      newTodoItem({ title: "Vacuum floors" }),
      newTodoItem({ title: "Clean bathroom" }),
      newTodoItem({ title: "Laundry" }),
    ],
  }),

  newProjectItem({
    name: "Errands",
    rows: [
      newTodoItem({ title: "Post office" }),
      newTodoItem({ title: "Pick up parcel" }),
      newTodoItem({ title: "Refill prescription" }),
      newGroupingItem({ label: "99 Problems" }),
      ...Array.from({ length: 99 }, (_, i) => newTodoItem({ title: `Problem #${i + 1}` })),
    ],
  }),
];

// important to wire projects to panel's instance, so it actually controls it globally.
export const mockPanels = (projects: ProjectItem[]): PanelItem[] => {
  const proj = projects[0];
  const todoExpanded = { [proj.rows[6].id]: true };
  return [
    newPanelItem({
      instance: { project: proj, todoExpanded },
      appear: { sideShow: true, sideWidth: 200, spacerLeft: null },
    }),
    newPanelItem({
      instance: { project: projects[1] },
    }),
  ];
};

export const placeholder: Readonly<{
  project: Pick<ProjectItem, "name" | "note">;
  todo: Pick<TodoItem, "title" | "note">;
  grouping: Pick<GroupingItem, "label">;
}> = {
  project: { name: "New Project", note: "Notes" },
  todo: { title: "New To-Do", note: "Notes" },
  grouping: { label: "New Heading" },
};
