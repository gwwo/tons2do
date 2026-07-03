<script lang="ts">
  // Full-width confirm button shared by the panel's expanded-row forms: shows
  // "…" while the wrapped request is in flight, tinted by severity.
  import type { Snippet } from "svelte";

  type Props = {
    busy: boolean;
    disabled?: boolean;
    variant?: "default" | "danger" | "warning";
    type?: "submit" | "button";
    onclick?: () => void;
    children: Snippet;
  };
  let {
    busy,
    disabled = false,
    variant = "default",
    type = "submit",
    onclick,
    children,
  }: Props = $props();

  const bg = $derived(
    variant === "danger" ? "bg-red-600" : variant === "warning" ? "bg-amber-700" : "bg-neutral-900",
  );
</script>

<button
  {type}
  {onclick}
  class={["w-full rounded-md py-2 text-sm text-white disabled:opacity-50", bg]}
  disabled={busy || disabled}
>
  {#if busy}…{:else}{@render children()}{/if}
</button>
