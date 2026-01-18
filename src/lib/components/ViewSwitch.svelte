<script lang="ts" generics="T">
  import { fade } from "svelte/transition";
  import { onMount, untrack, type Snippet } from "svelte";

  type Props = {
    key: T;
    duration?: number;
    children: Snippet;
  };

  let { key, children, duration = 300 }: Props = $props();

  let content: HTMLDivElement | undefined;
  let heightForced: number | null = $state(null);

  $effect.pre(() => {
    key;
    untrack(() => {
      if (content == undefined) return;
      heightForced = content.offsetHeight;
    });
  });

  $effect(() => {
    key;
    untrack(() => {
      if (content == undefined || heightForced == null) return;
      heightForced = content.offsetHeight;
    });
  });

  export const getEndHeight = () => content?.offsetHeight ?? 0;
</script>

<div
  class="overflow-hidden"
  style:transition="height {duration}ms ease"
  style:height={heightForced != null ? `${heightForced}px` : "auto"}
  ontransitionend={(ev) => {
    if (ev.currentTarget !== ev.target || ev.propertyName !== "height") return;
    heightForced = null;
  }}
>
  <!-- to measure the height when the content changes, set `flex-col` to avoid margin cascading -->
  <div bind:this={content} class="relative flex flex-col">
    {#key key}
      <div
        transition:fade={{ duration }}
        class="w-full [[inert]]:absolute [[inert]]:top-0 [[inert]]:left-0"
      >
        {@render children()}
      </div>
    {/key}
  </div>
</div>
