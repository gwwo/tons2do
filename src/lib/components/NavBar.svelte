<script lang="ts" module>
  export const MAX_PANEL_COUNT = 3;
</script>

<script lang="ts">
  import {
    useSwitcher,
    type ProjectItem,
    type PanelItem,
    newPanelItem,
    newProjectInstance,
    placeholder,
    isProjectInstance,
    type ProjectInstance,
  } from "$lib";

  type Props = {
    index: number;
    panels: PanelItem[];
    swicherOpacity: number;
    opacityTransition: boolean;
    disable?: boolean;
  };

  let {
    index,
    panels = $bindable(),
    swicherOpacity,
    disable = false,
    opacityTransition,
  }: Props = $props();

  let panel = $derived(panels[index]);

  const switcher = useSwitcher();

  const duplicate = async (project: ProjectItem) => {
    const spacerLeft = panels.at(index + 1)?.appear.spacerLeft ?? undefined;

    if (panels.length >= MAX_PANEL_COUNT) {
      panels.splice(panels.length - 1, 1);
    }
    const { height, mainWidth } = panel.appear;
    panels.splice(
      index + 1,
      0,
      newPanelItem({
        appear: { height, mainWidth, spacerLeft },
        instance: { project },
      }),
    );
  };

  const close = () => {
    panels.splice(index, 1);
  };

  const popup = (ev: MouseEvent & { currentTarget: EventTarget & HTMLElement }) => {
    if (disable) return;
    if (!isProjectInstance(panel.instance)) return;
    const { project } = panel.instance;
    switcher.popup({
      anchor: ev.currentTarget,
      getProjectShwon: () => project,
      setProjectShown: (project) => (panels[index].instance = newProjectInstance({ project })),
    });
  };
</script>

<div class="flex h-full items-center gap-2 px-4 pt-1 text-gray-400">
  <div class="size-5 flex-none">
    {#if index === 0}
      <button
        onclick={() => {}}
        class="flex size-full items-center justify-center"
        aria-label="to check sync info"
      >
        <span class="icon-[tabler--cloud-off] size-4.5"></span>
      </button>
    {:else}
      <button
        onclick={close}
        class="group flex size-full items-center justify-center rounded-md hover:border hover:border-gray-400 active:bg-gray-400/20"
        aria-label="to close panel"
      >
        <!-- <span class="icon-[material-symbols--tab-close-outline]"></span> -->
        <span class="icon-[iconamoon--close] size-4"></span>
      </button>
    {/if}
  </div>

  <div class="flex flex-1 justify-center overflow-hidden">
    {#if isProjectInstance(panel.instance)}
      <button
        style:opacity={swicherOpacity}
        class={[
          "flex cursor-default items-center gap-1 overflow-hidden rounded-sm pl-1 select-none",
          "border border-transparent hover:border-gray-300 active:bg-gray-200",
          opacityTransition && "transition-opacity duration-250 ease-linear",
        ]}
        onclick={popup}
      >
        <span class="truncate leading-6">
          {panel.instance.project.name || placeholder.project.name}
        </span>
        <span class="icon-[mi--select] shrink-0"></span>
      </button>
    {/if}
  </div>
  <div class="size-5 flex-none">
    {#if index === 0 && isProjectInstance(panel.instance)}
      {@const { project } = panel.instance}
      <button
        onclick={() => duplicate(project)}
        class="group flex size-full items-center justify-center"
        aria-label="to duplicate list"
      >
        <span
          class="icon-[mingcute--copy-2-line] group-hover:icon-[icon-park-solid--copy] size-4 group-active:bg-teal-500"
        ></span>
      </button>
    {/if}
  </div>
</div>
