<script lang="ts">
  // Row label for a credential: provider icon + truncating identifier, with an
  // optional action suffix ("— unlink") that never truncates.
  type Props = { icon: string; text: string; suffix?: string };
  let { icon, text, suffix }: Props = $props();
</script>

<span class="flex min-w-0 items-center gap-1.5">
  <span class={[icon, "size-4 shrink-0"]} aria-hidden="true"></span>
  <span class="truncate text-neutral-500 italic">{text}</span>
  {#if suffix}<span class="shrink-0">— {suffix}</span>{/if}
</span>
