<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { tick, type Snippet } from "svelte";
  import { circInOut } from "svelte/easing";
  import { draw } from "svelte/transition";

  type Props = {
    class?: string;
    ticked?: boolean;
  };

  let { ticked = $bindable(false), class: className }: Props = $props();
</script>

<div class={["group relative", className]}>
  <label>
    <input class="hidden appearance-none" type="checkbox" bind:checked={ticked} />
    <div
      class="absolute inset-0 flex items-center justify-center transition-transform group-active:scale-120"
    >
      <div class={["relative size-[40%] select-none", ticked ? "text-gray-400" : "text-teal-600"]}>
        {#if ticked}
          {@render CheckMark()}
        {:else}
          {@render CircleMark()}
        {/if}
      </div>
    </div>
  </label>
</div>

{#snippet CheckMark()}
  <svg class="h-auto w-full" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 10" fill="none">
    <polyline
      stroke-linejoin="round"
      stroke-linecap="round"
      stroke-width="2"
      stroke="currentColor"
      points="1.5 6 4.5 9 10.5 1"
    ></polyline>
  </svg>
{/snippet}

{#snippet CircleMark()}
  <svg class="h-auto w-full" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="3" />
  </svg>
{/snippet}
