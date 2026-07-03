<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  // A panel's bottom action bar: fixed height with the keyboard-focus
  // indication line along its top edge (which the fetch progress bar replaces
  // while loading — see Panel).
  type Props = {
    height: number;
    focused?: boolean;
    // Grey out and ignore clicks (page still loading).
    dimmed?: boolean;
    class?: ClassValue;
    children: Snippet;
  };

  let { height, focused = false, dimmed = false, class: className, children }: Props = $props();
</script>

<div
  class={[
    "relative flex w-full flex-none items-center text-gray-500",
    dimmed && "pointer-events-none opacity-40",
    className,
  ]}
  style:height="{height}px"
>
  <!-- The indication line is an overlay, not a border: its thickness change on
       focus (1px → 2px) must not resize the bar's content box, which would
       nudge the icons. -->
  <div
    class={[
      "pointer-events-none absolute inset-x-0 top-0 transition-colors duration-200",
      focused ? "h-0.5 bg-teal-500" : "h-px bg-gray-200",
    ]}
  ></div>
  {@render children()}
</div>
