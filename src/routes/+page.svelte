<script lang="ts">
  import type { Attachment } from "svelte/attachments";
  import {
    ContextMenuPopup,
    PickerPopup,
    SwitcherPopup,
    type ProjectItem,
    type PanelItem,
    mockProjects,
    mockPanels,
  } from "$lib";
  import CheckListInsert from "$lib/components/check-list/CheckListInsert.svelte";
  import TodoListInsert from "$lib/components/todo-panel/TodoListInsert.svelte";
  import { onMount, tick, untrack } from "svelte";

  let projects: ProjectItem[] = $state(mockProjects);
  let panels: PanelItem[] = $state(mockPanels(untrack(() => projects)));

  import ProjectListInsert from "$lib/components/project-list/ProjectListInsert.svelte";
  import ResizeGroup from "$lib/components/ResizeGroup.svelte";
  import Panel from "./Panel.svelte";

  onMount(() => {
    // this to suppress Safari's `scroll to navigate back` behavoir
    const hijack = (ev: WheelEvent) => {};
    document.addEventListener("wheel", hijack);
    return () => document.removeEventListener("wheel", hijack);
  });
</script>

<ContextMenuPopup>
  <SwitcherPopup {projects}>
    <PickerPopup>
      <ProjectListInsert>
        <TodoListInsert>
          <CheckListInsert>
            <ResizeGroup items={panels}>
              {#snippet each(panel, index)}
                <Panel
                  bind:projects
                  bind:panels
                  bind:instance={panel.instance}
                  bind:appear={panel.appear}
                  {index}
                />
              {/snippet}
            </ResizeGroup>
          </CheckListInsert>
        </TodoListInsert>
      </ProjectListInsert>
    </PickerPopup>
  </SwitcherPopup>
</ContextMenuPopup>

<!-- <div class="w-full min-h-screen"></div> -->

<style>
  :global(.dragging-to-insert *) {
    cursor: default !important;
  }
</style>
