<script lang="ts" module>
  import { useCreateProject } from "$lib/client/mutate-remote";
  import {
    useOpenAccountPanel,
    useOpenInNewPanel,
    useSetOperationInPanel,
    useSetProjInPanel,
  } from "$lib/client/mutate-local";

  const useMutator = () => ({
    createProject: useCreateProject(),
    setProjInPanel: useSetProjInPanel(),
    setOperationInPanel: useSetOperationInPanel(),
    openInNewPanel: useOpenInNewPanel(),
    openAccountPanel: useOpenAccountPanel(),
  });
  type Mutator = ReturnType<typeof useMutator>;
</script>

<script lang="ts">
  import type { ClassValue, HTMLAttributes } from "svelte/elements";
  import { activeProjects, drilledFrom, isProjectInstance, operationOf, type Instance } from "$lib";
  import ProjectList from "$lib/components/project-list/ProjectList.svelte";
  import OperationList from "$lib/components/operation-list/OperationList.svelte";
  import BarButton from "./BarButton.svelte";
  import PanelBottomBar from "./PanelBottomBar.svelte";
  import { getAppState, getPanelContext } from "$lib/client/context";
  import { usePanelFocus } from "$lib/components/panel/PanelGroup.svelte";
  type Props = {
    instance: Instance;
    bottomBarHeight: number;
    topBarHeight: number;
    class?: ClassValue;
    newProjIdToReveal: string | null;
    mut?: Mutator;
  };

  let {
    instance,
    newProjIdToReveal = $bindable(),
    bottomBarHeight,
    topBarHeight,
    class: className,
    mut = useMutator(),
  }: Props = $props();

  let projsSelected: Record<string, boolean | undefined> = $state(
    isProjectInstance(instance) ? { [instance.project.id]: true } : {},
  );

  $effect(() => {
    const id = isProjectInstance(instance) ? instance.project.id : null;
    projsSelected = id !== null ? { [id]: true } : {};
  });

  const { panelId } = getPanelContext();
  const panelFocus = usePanelFocus();

  const appState = getAppState();
  let projects = $derived(activeProjects(appState));

  // A project drilled into from a placement view (archive/trash) should keep
  // that view's operation-list row highlighted, mirroring the navbar switcher.
  let operationShown = $derived(
    (isProjectInstance(instance) ? drilledFrom(appState, instance.project.id) : null) ??
      operationOf(instance),
  );

  const insertNew = async () => {
    let lastSelectedIndex = -1;
    for (const [i, proj] of projects.entries()) {
      if (projsSelected[proj.id]) lastSelectedIndex = i;
    }
    const insertIndex = lastSelectedIndex >= 0 ? lastSelectedIndex + 1 : 0;
    const { id } = await mut.createProject(insertIndex);
    projsSelected = { [id]: true };
    newProjIdToReveal = id;
  };
</script>

<div
  class={["flex size-full flex-col bg-teal-100", className]}
  style:padding-top="{topBarHeight}px"
  onpointerdown={() => panelFocus.setFocus(panelId, "side")}
>
  <OperationList
    class="w-full flex-none px-2 pt-5 pb-4 text-sm"
    {operationShown}
    showOperation={(op) => {
      mut.setOperationInPanel(op);
      projsSelected = {};
    }}
    openInNewPanel={(op) => {
      mut.openInNewPanel({ op });
    }}
  ></OperationList>

  <ProjectList
    class="flex min-h-0 flex-1 px-2"
    data={projects}
    bind:selected={projsSelected}
    projIdShown={isProjectInstance(instance) ? instance.project.id : null}
    showProject={(project) => {
      mut.setProjInPanel(project.id);
    }}
    openInNewPanel={(project) => {
      mut.openInNewPanel({ projId: project.id });
    }}
  ></ProjectList>
  <PanelBottomBar height={bottomBarHeight} class="px-2">
    <BarButton class="flex-none px-2 text-sm" onclick={insertNew}>+ New List</BarButton>
    <div class="flex-1"></div>
    <BarButton
      class="flex-none px-2 text-gray-400"
      aria-label="open account"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={mut.openAccountPanel}
    >
      <span class="icon-[mdi--user] size-5"></span>
    </BarButton>
  </PanelBottomBar>
</div>
