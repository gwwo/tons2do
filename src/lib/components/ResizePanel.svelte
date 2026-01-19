<script lang="ts" module>
  import type { PanelAppear } from "$lib";

  const MIN_SIDE_WIDTH = 150;
  const MAX_SIDE_WIDTH = 600;
  const MIN_MAIN_WIDTH = 300;
  const MAX_MAIN_WIDTH = 600;
  const COLLAPSE_WIDTH = MIN_SIDE_WIDTH * (1 / 2);
  const MIN_HEIGHT = 300;
  const MAX_HEIGHT = 800;

  const MIN_MARGIN_LEFT = 10;
  const MAX_MARGIN_LEFT = 400;

  export const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const topBarHeight = 30;
  const bottomBarHeight = 40;

  const SIDE_TRANSITION_MS = 300;
</script>

<script lang="ts">
  import type { Attachment } from "svelte/attachments";
  import { capAsymptotic } from "$lib/components/drag-insert-list/utils";
  import { untrack, type Snippet } from "svelte";
  import { useDragControl } from "$lib/utils/drag-control.svelte";
  import { useNotifier } from "./ResizeGroup.svelte";

  type Props = {
    side?: Snippet<[topBarHeight: number, bottomBarHeight: number]>;
    main?: Snippet<[topBarHeight: number, bottomBarHeight: number]>;
    top?: Snippet<[resizingSide: boolean, sideReveal: number]>;
    appear: PanelAppear;
  };

  let { side, main, top, appear: ap = $bindable() }: Props = $props();

  const { notifyResizeStart, notifyResizeFinish } = useNotifier();

  let panelTranslateX: number | null = $state(null);
  let panelTranslateY: number | null = $state(null);

  let resizingSide = $state(false);
  let resizingMain = $state(false);
  let resizing = $derived(resizingSide || resizingMain);
  let resizingSpacer = $state(false);

  // the side width at the first render
  let sideWidthRaw = $state(clamp(ap.sideWidth ?? 0, 0, MAX_SIDE_WIDTH));
  let sideContentWidth: number | null = $state(clamp(sideWidthRaw, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH));

  let sideTransition: symbol | null = $state(null);
  let lastSideWidthRaw: number = sideWidthRaw;

  $effect.pre(() => {
    const w = sideWidthRaw;
    untrack(() => {
      const next = clamp(w, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH);
      if (resizing || sideContentWidth == null) {
        sideContentWidth = next;
      }
    });
    untrack(() => {
      if (resizing) return;
      if (lastSideWidthRaw === w) return;
      // each sideTransition request is uniquely non-null
      sideTransition = Symbol();
    });
    lastSideWidthRaw = w;
  });

  const endTransitionState = () => {
    if (!ap.sideShow) sideContentWidth = null;
    sideTransition = null; // setting sideTransition will clear the timer.
  };

  $effect.pre(() => {
    if (sideTransition == null) return;
    let timer = untrack(() => setTimeout(endTransitionState, SIDE_TRANSITION_MS + 50));
    return () => clearTimeout(timer);
  });

  $effect.pre(() => {
    ap.sideShow;
    untrack(() => {
      if (ap.sideWidth != null) {
        sideWidthRaw = ap.sideShow ? clamp(ap.sideWidth, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH) : 0;
      }
    });
  });

  $effect(() => {
    if (!resizing) {
      // whenever resizing finishes
      untrack(() => {
        ap.sideShow = sideWidthRaw > 0;
        if (ap.sideShow && ap.sideWidth != null) ap.sideWidth = sideWidthRaw;
        if (!ap.sideShow && sideTransition == null) sideContentWidth = null;
      });
    }
  });

  const sideControl = useDragControl({
    cursorStyle: "col-resize",
    onClick: () => {
      ap.sideShow = !ap.sideShow;
    },
    onStart: () => {
      notifyResizeStart();
      resizingSide = true;
      return { sideWidthRaw };
    },
    onMove: (dx, dy, start) => {
      if (dx === 0) return;
      const freeWidth = start.sideWidthRaw + dx;
      const nextWidth = clamp(freeWidth, 0, MAX_SIDE_WIDTH);
      const overshoot = Math.abs(freeWidth - nextWidth);
      panelTranslateX =
        overshoot !== 0
          ? freeWidth > nextWidth
            ? capAsymptotic(overshoot)
            : -capAsymptotic(overshoot)
          : null;
      sideWidthRaw = nextWidth;
    },
    onFinish: () => {
      resizingSide = false;
      panelTranslateX = null;
      const endWidth =
        sideWidthRaw <= COLLAPSE_WIDTH ? 0 : clamp(sideWidthRaw, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH);
      notifyResizeFinish({ dw: endWidth - sideWidthRaw });
      sideWidthRaw = endWidth;
    },
  });

  function mainControl(
    direction: "nwse-resize" | "ew-resize" | "ns-resize",
  ): Attachment<HTMLDivElement> {
    const resizeWidth = (dx: number, start: { mainWidth: number; sideWidthRaw: number | null }) => {
      const freeMainWidth = start.mainWidth + dx;
      const nextMainWidth = clamp(freeMainWidth, MIN_MAIN_WIDTH, MAX_MAIN_WIDTH);
      const excess = Math.abs(freeMainWidth - nextMainWidth);
      const sideShrinkable = (start.sideWidthRaw ?? 0) - MIN_SIDE_WIDTH;
      const sideShrink =
        sideShrinkable > 0 && freeMainWidth < nextMainWidth ? Math.min(excess, sideShrinkable) : 0;
      const overshoot = excess - sideShrink;

      if (start.sideWidthRaw != null) {
        sideWidthRaw = start.sideWidthRaw - sideShrink;
      }
      panelTranslateX =
        overshoot !== 0
          ? freeMainWidth > nextMainWidth
            ? capAsymptotic(overshoot)
            : -capAsymptotic(overshoot)
          : null;
      ap.mainWidth = nextMainWidth;
    };
    const resizeHeight = (dy: number, start: { height: number }) => {
      const freeHeight = start.height + dy;
      const nextHeight = clamp(freeHeight, MIN_HEIGHT, MAX_HEIGHT);
      const overshoot = Math.abs(freeHeight - nextHeight);
      panelTranslateY =
        overshoot !== 0
          ? freeHeight > nextHeight
            ? capAsymptotic(overshoot)
            : -capAsymptotic(overshoot)
          : null;
      ap.height = nextHeight;
    };

    return useDragControl({
      cursorStyle: direction,
      onStart: () => {
        notifyResizeStart();
        resizingMain = true;
        const { height, mainWidth, sideWidth } = ap;
        // we directly manage mainWidth, but use sideWidthRaw to affect sideWidth when sideWidth != null
        return { height, mainWidth, sideWidthRaw: sideWidth == null ? null : sideWidthRaw };
      },
      onMove: (dx, dy, start) => {
        if (direction === "ew-resize" || direction === "nwse-resize") {
          if (dx !== 0) resizeWidth(dx, start);
        }
        if (direction === "ns-resize" || direction === "nwse-resize") {
          if (dy !== 0) resizeHeight(dy, start);
        }
      },
      onFinish: () => {
        resizingMain = false;
        panelTranslateX = null;
        panelTranslateY = null;
        notifyResizeFinish();
      },
    });
  }

  const spacerControl = useDragControl({
    cursorStyle: "ew-resize",
    onStart: () => {
      notifyResizeStart();
      resizingSpacer = true;
      return { spacerLeft: ap.spacerLeft };
    },
    onMove: (dx, dy, start) => {
      if (dx === 0) return;
      if (start.spacerLeft == null) return;
      const free = start.spacerLeft + dx;
      const next = clamp(free, MIN_MARGIN_LEFT, MAX_MARGIN_LEFT);
      const overshoot = Math.abs(free - next);

      panelTranslateX =
        overshoot !== 0
          ? free > next
            ? capAsymptotic(overshoot)
            : -capAsymptotic(overshoot)
          : null;
      ap.spacerLeft = next;
    },
    onFinish: () => {
      resizingSpacer = false;
      panelTranslateX = null;
      notifyResizeFinish();
    },
  });
</script>

<div
  class={[
    "relative size-fit",
    // will need this when margin-left changes due to reordering,
    // which is not a concern in  the current case
    !resizingSpacer && "transition-[margin] duration-200 ease-linear",
  ]}
  style:margin-left="{ap.spacerLeft ?? 0}px"
>
  <div
    class={[
      "flex overflow-hidden rounded-2xl border border-teal-500 shadow-2xl",
      !resizing && "transition-transform duration-200 ease-linear",
      resizing && "select-none",
    ]}
    style:height="{ap.height}px"
    style:transform="translate({panelTranslateX ?? 0}px, {panelTranslateY ?? 0}px)"
  >
    {#if top != null}
      <div
        class="absolute inset-x-0 top-0 z-1 w-full overflow-hidden"
        style:height="{topBarHeight}px"
      >
        {@render top(
          resizingSide,
          ap.sideWidth == null ? 0 : clamp(sideWidthRaw / MIN_SIDE_WIDTH, 0, 1),
        )}
      </div>
    {/if}
    <div
      class={["relative box-border h-full flex-none overflow-hidden"]}
      style:width="{sideWidthRaw}px"
      style:transition={!resizing ? `width ${SIDE_TRANSITION_MS}ms ease` : ""}
      ontransitionend={(ev) => {
        if (ev.target !== ev.currentTarget) return;
        if (ev.propertyName !== "width") return;
        endTransitionState();
      }}
    >
      {#if ap.sideWidth != null && sideContentWidth != null}
        <div class="h-full" style:width="{sideContentWidth}px">
          {@render side?.(topBarHeight, bottomBarHeight)}
        </div>
      {/if}
      <div class="absolute inset-y-0 right-0 z-10 w-px bg-gray-200"></div>
    </div>

    <div class="relative flex h-full flex-none" style:width="{ap.mainWidth}px">
      {@render main?.(topBarHeight, bottomBarHeight)}
      <!-- `overflow-hidden` here is important for avoiding Safari's quirks on transform with a overlay-->
      <!-- if you absolutely position this side pane slider at the left, in safari,
     it will cause a shift on the previously inserted row when inserting a new row abvove it from another list-->

      {#if ap.sideWidth != null}
        <div
          class="group absolute inset-y-0 left-0 z-2 flex h-full w-4 items-center overflow-hidden"
        >
          <div
            class={[
              "group w-full cursor-col-resize transition-opacity",
              !resizingSide && "opacity-0 group-hover:opacity-100",
            ]}
            {@attach sideControl}
          >
            <div
              class="handle ml-1.5 h-16 w-1.5 rounded-full bg-gray-400 group-active:bg-gray-500"
            ></div>
          </div>
        </div>
      {/if}
    </div>
  </div>
  {#if ap.spacerLeft != null}
    <div
      {@attach spacerControl}
      class="absolute inset-y-[14px] -left-[5px] w-[8px] cursor-ew-resize"
    ></div>
  {/if}
  <div
    {@attach mainControl("ns-resize")}
    class="absolute inset-x-[14px] -bottom-[5px] h-[10px] cursor-ns-resize"
  ></div>
  <div
    {@attach mainControl("ew-resize")}
    class="absolute inset-y-[14px] -right-[5px] w-[10px] cursor-ew-resize"
  ></div>
  <div
    {@attach mainControl("nwse-resize")}
    class="absolute -right-[2px] -bottom-[2px] size-[16px] cursor-nwse-resize"
  ></div>
</div>

<style>
  :global(.force-cursor *) {
    cursor: var(--cursor, auto) !important;
  }
</style>
