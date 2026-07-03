<script lang="ts">
  // Labeled hairline divider ("── or ──") between alternative form paths.
  import type { ClassValue } from "svelte/elements";

  type Props = { label: string; class?: ClassValue };
  let { label, class: className }: Props = $props();
</script>

<div class={["flex items-center gap-3 text-xs text-neutral-400", className]}>
  <span class="h-px flex-1 bg-neutral-200"></span>
  <span>{label}</span>
  <span class="h-px flex-1 bg-neutral-200"></span>
</div>
