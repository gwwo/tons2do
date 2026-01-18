<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { circInOut } from "svelte/easing";
  import { draw } from "svelte/transition";
  import { type TodoStatus } from "$lib";

  type Props = {
    class?: string;
    status?: TodoStatus;
  };

  let { status = $bindable("todo"), class: className }: Props = $props();
</script>

<div class={["group relative", className]}>
  <label>
    <input
      class="hidden appearance-none"
      type="checkbox"
      bind:checked={
        () => status === "complete",
        // "canceled" status is not settable by clicking on input label
        (v) => (status = v ? "complete" : "todo")
      }
    />
    <!-- expand clickable area to the whole div -->
    <div class="absolute inset-0"></div>
    <div class={["relative size-full select-none"]}>
      <div
        class={[
          "absolute inset-0 rounded-sm border-1 transition-colors",
          "transition-transform group-active:scale-110",
          status === "complete" && "border-transparent bg-teal-500",
          status === "todo" && "border-gray-500",
        ]}
      ></div>
      <!-- p-[1px] to account for border-1 of the previous div -->
      <div class="absolute inset-0 p-[1px]">
        <div class="flex size-full place-content-center text-white">
          {#if status === "complete"}
            {@render CheckMark()}
            <!-- {:else if status === "canceled"}
            {@render CrossMark()} -->
          {/if}
        </div>
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
      in:draw={{ duration: 150, easing: circInOut }}
    ></polyline>
  </svg>
{/snippet}

{#snippet CrossMark()}
  <svg class="h-auto w-[80%]" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 25" fill="none">
    <path
      in:draw={{ duration: 100, easing: circInOut }}
      stroke-width="4"
      d="M0.5 1L23.5 24"
      stroke="currentColor"
    />
    <path
      in:draw={{ delay: 100, duration: 100, easing: circInOut }}
      stroke-width="4"
      d="M23.5 1L0.5 24"
      stroke="currentColor"
    />
  </svg>
{/snippet}
