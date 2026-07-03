<script lang="ts">
  // Submit button for server-rendered auth forms whose handlers only attach at
  // hydration: shows a "Loading…" spinner (and stays disabled) until then, so
  // the form reads as not-yet-ready rather than looking submittable.
  type Props = { hydrated: boolean; busy: boolean; disabled?: boolean; label: string };
  let { hydrated, busy, disabled = false, label }: Props = $props();
</script>

<button
  type="submit"
  class="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900 py-2 text-sm text-white disabled:opacity-50"
  disabled={busy || !hydrated || disabled}
>
  {#if !hydrated}
    <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
    Loading…
  {:else if busy}
    …
  {:else}
    {label}
  {/if}
</button>
