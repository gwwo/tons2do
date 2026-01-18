<script lang="ts">
  import {
    isProjectInstance,
    type Instance,
    type PanelAppear,
    type PanelItem,
    type ProjectInstance,
    type ProjectItem,
  } from "$lib";
  import NavBar from "$lib/components/NavBar.svelte";
  import OperationPage from "$lib/components/operation-list/OperationPage.svelte";
  import PanelMain from "$lib/components/PanelMain.svelte";
  import PanelSide from "$lib/components/PanelSide.svelte";
  import ResizePanel from "$lib/components/ResizePanel.svelte";

  type Props = {
    index: number;
    appear: PanelAppear;
    instance: Instance;
    projects: ProjectItem[];
    panels: PanelItem[];
  };

  let {
    index,
    appear = $bindable(),
    instance = $bindable(),
    projects = $bindable(),
    panels = $bindable(),
  }: Props = $props();

  let newProjIdToReveal: string | null = $state(null);
</script>

<ResizePanel bind:appear>
  {#snippet side(topBarHeight, bottomBarHeight)}
    <PanelSide
      bind:newProjIdToReveal
      bind:projects
      bind:instance
      {topBarHeight}
      {bottomBarHeight}
    />
  {/snippet}
  {#snippet main(topBarHeight, bottomBarHeight)}
    {#key instance}
      {#if isProjectInstance(instance)}
        <PanelMain bind:newProjIdToReveal bind:instance {topBarHeight} {bottomBarHeight} />
      {:else}
        <OperationPage {instance}></OperationPage>
      {/if}
    {/key}
  {/snippet}
  {#snippet top(resizingSide, sideReveal)}
    <NavBar
      {index}
      bind:panels
      swicherOpacity={0.01 * Math.round(100 * (1 - sideReveal))}
      opacityTransition={!resizingSide}
      disable={appear.sideShow}
    ></NavBar>
  {/snippet}
</ResizePanel>
