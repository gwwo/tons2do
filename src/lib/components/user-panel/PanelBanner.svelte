<script lang="ts">
  // The panel's status line under the heading: shows the current banner, or a
  // resting placeholder. Reserves two lines so flashes don't shift the layout.
  import type { Banner } from "./types";

  type Props = { banner: Banner; placeholder: string };
  let { banner, placeholder }: Props = $props();
</script>

<div
  class={[
    "mx-4 mt-4 min-h-12 text-sm wrap-break-word",
    banner?.kind === "error" ? "text-red-700" : "text-emerald-700",
  ]}
>
  {banner?.text ?? placeholder}
</div>
