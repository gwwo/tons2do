<script lang="ts">
  import { json } from "@sveltejs/kit";
  import { tick, untrack } from "svelte";

  type Props = {
    class: string;
    placeholder?: string;
    text?: string;
    onExpand?: (shell: HTMLElement) => void;
    expanded?: boolean;
  };

  let {
    class: className,
    placeholder,
    text = $bindable(""),
    expanded = $bindable(false),
    onExpand,
  }: Props = $props();

  let shell: HTMLElement;

  let inputBar: HTMLInputElement | undefined = $state.raw();

  $effect(() => {
    if (inputBar) {
      tick().then(() => inputBar?.focus({ preventScroll: true }));
    }
  });

  $effect.pre(() => {
    // Blur the field before collapsing so Safari no longer yanks the scroll position
    // when expanded flips to false.
    if (!expanded) {
      inputBar?.blur();
    }
  });

  const onfocusout = (e: FocusEvent) => {
    expanded = false;
  };

  import { cubicOut } from "svelte/easing";

  const duration = 350;

  const slide = (
    node: HTMLElement,
    options = {},
    { direction }: { direction: "in" | "out" | "both" },
  ) => {
    const { opacity, width } = getComputedStyle(node);
    if (direction === "in") onExpand?.(shell);
    const properOpacity = parseInt(opacity);
    const properWidth = parseFloat(width);
    return {
      duration,
      easing: cubicOut,
      css: (t: number) =>
        "overflow: hidden;" +
        `opacity: ${Math.min(t * 20, 1) * properOpacity};` +
        `width: ${t * properWidth}px;` +
        `min-width: 0`,
    };
  };
</script>

<div
  bind:this={shell}
  class={[
    "border-box flex rounded-sm border-1 border-transparent transition-[background-color]",
    expanded ? "bg-gray-100" : "hover:border-gray-300",
  ]}
  style:transition-duration="{duration}ms"
  tabindex="-1"
  {onfocusout}
>
  <button
    aria-label="toggle input-show"
    class={["size-7", !expanded && "active:bg-gray-100/20"]}
    onmousedown={(e) => e.preventDefault()}
    onclick={(ev) => (expanded = true)}
  >
    <span
      class={[
        className,
        "m-auto block size-6 bg-gray-400",
        // "icon-[material-symbols--star-rounded]",
        // "icon-[si--moon-fill]",
      ]}
    ></span>
  </button>
  {#if expanded}
    <input
      in:slide
      out:slide
      bind:this={inputBar}
      type="text"
      {placeholder}
      bind:value={text}
      class="h-7 w-30 py-2 placeholder:text-gray-400 focus:outline-none"
    />
  {/if}
</div>
