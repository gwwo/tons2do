<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";

  // The pill-shaped action button used in the panel bars (bottom toolbars and
  // the sidebar footer). Sizing beyond the shared height comes from `class`
  // (w-16 for the icon toolbars, px-2 for text buttons).
  type Props = {
    class?: ClassValue;
    children: Snippet;
  } & HTMLButtonAttributes;

  let { class: className, children, ...restProps }: Props = $props();
</script>

<button
  {...restProps}
  class={[
    "flex h-7 items-center justify-center rounded-full border border-transparent",
    "enabled:hover:border-gray-300 enabled:active:bg-gray-300/20 disabled:opacity-40",
    className,
  ]}
>
  {@render children()}
</button>
