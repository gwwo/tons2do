<script lang="ts">
  import type { ClassValue, HTMLAttributes } from "svelte/elements";
  import {
    isProjectInstance,
    newProjectInstance,
    newProjectItem,
    type Instance,
    type ProjectInstance,
    type ProjectItem,
  } from "$lib";
  import ProjectList from "$lib/components/project-list/ProjectList.svelte";
  import OperationList from "./operation-list/OperationList.svelte";

  type Props = {
    projects: ProjectItem[];
    instance: Instance;
    bottomBarHeight: number;
    topBarHeight: number;
    class?: ClassValue;
    newProjIdToReveal: string | null;
  };

  let {
    projects = $bindable(),
    instance = $bindable(),
    newProjIdToReveal = $bindable(),
    bottomBarHeight,
    topBarHeight,
    class: className,
  }: Props = $props();

  let projSelected: Record<string, boolean | undefined> = $state(
    isProjectInstance(instance) ? { [instance.project.id]: true } : {},
  );

  const insertNew = (item: ProjectItem) => {
    let lastSelectedIndex = -1;
    for (const [i, proj] of projects.entries()) {
      if (projSelected[proj.id]) lastSelectedIndex = i;
    }
    const insertIndex = lastSelectedIndex >= 0 ? lastSelectedIndex + 1 : 0;
    projects.splice(insertIndex, 0, item);
    // using the proxied version to keep identity. necesarray?
    instance = newProjectInstance({ project: projects[insertIndex] });
    // projSelected[project.id] = true;
    projSelected = { [item.id]: true };
    newProjIdToReveal = item.id;
  };
</script>

<div
  class={["flex size-full flex-col bg-teal-100", className]}
  style:padding-top="{topBarHeight}px"
>
  <OperationList
    class="w-full flex-none px-2 pt-5 pb-4 text-sm"
    operationShown={isProjectInstance(instance) ? null : instance}
    showOperation={(op) => {
      instance = op;
      projSelected = {};
    }}
  ></OperationList>

  <ProjectList
    class="flex min-h-0 flex-1 px-2"
    bind:data={projects}
    bind:selected={projSelected}
    projIdShown={isProjectInstance(instance) ? instance.project.id : null}
    bind:projIdToReveal={newProjIdToReveal}
    showProject={(project) => {
      instance = newProjectInstance({ project });
    }}
  ></ProjectList>
  <div
    class="flex w-full flex-none items-center border-t border-gray-200 px-2 text-gray-500"
    style:height="{bottomBarHeight}px"
  >
    <button
      class="flex h-7 flex-none items-center justify-center rounded-full border border-transparent px-2 text-sm hover:border-gray-300 active:bg-gray-300/20"
      onclick={() => insertNew(newProjectItem())}
    >
      + New List
    </button>
    <div class="flex-1"></div>
    <button
      class="flex h-7 flex-none items-center justify-center rounded-full border border-transparent px-2 hover:border-gray-300 active:bg-gray-300/20"
      aria-label="go to settings"
    >
      <span class="icon-[basil--settings-adjust-outline] size-5"></span>
    </button>
  </div>
</div>
