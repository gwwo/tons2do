<script lang="ts" module>
  import type { Attachment } from "svelte/attachments";

  type PointerControlOptions<TStart> = {
    onStart: () => TStart;
    onMove: (dx: number, dy: number, start: TStart) => void;
    onFinish: () => void;
    onClick?: () => void;
  };

  const useDragControl = <TStart,>(
    arg: PointerControlOptions<TStart>,
  ): Attachment<HTMLDivElement> => {
    const { onStart, onMove, onFinish, onClick } = arg;
    return (node) => {
      let start: { x: number; y: number } | null = $state.raw(null);

      $effect(() => {
        if (start == null) return;
        const { x, y } = start;
        let startInfo: TStart | null = null;

        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - x;
          const dy = ev.clientY - y;
          if (startInfo == null) {
            if (Math.sqrt(dx ** 2 + dy ** 2) > 4) startInfo = onStart();
          }
          if (startInfo != null) {
            onMove(Math.round(dx), Math.round(dy), startInfo);
          }
        };

        const finish = (ev: PointerEvent) => {
          start = null;
          startInfo == null ? onClick?.() : onFinish();
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
        return () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
        };
      });

      const begin = (ev: PointerEvent) => {
        ev.preventDefault();
        start = { x: ev.clientX, y: ev.clientY };
      };

      node.addEventListener("pointerdown", begin);
      return () => node.removeEventListener("pointerdown", begin);
    };
  };

  const MIN_SIDE_WIDTH = 150;
  const MAX_SIDE_WIDTH = 600;
  const COLLAPSE_WIDTH = MIN_SIDE_WIDTH * (1 / 2);
  const TRANSITION_MS = 500;

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
</script>

<script lang="ts">
  import { untrack } from "svelte";

  type Props = {
    sideShow?: boolean;
    sideWidth?: number | null;
  };

  let { sideShow = $bindable(true), sideWidth = $bindable(200) }: Props = $props();

  let resizingSide = $state(false);
  let sideWidthRaw = $state(clamp(sideWidth ?? 0, 0, MAX_SIDE_WIDTH));

  let sideWidthContent: number | null = $state(clamp(sideWidthRaw, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH));

  let sideTransition: symbol | null = $state(null);
  let lastSideWidthRaw = sideWidthRaw;

  $effect.pre(() => {
    const w = sideWidthRaw;
    untrack(() => {
      const next = clamp(w, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH);
      if (resizingSide || sideWidthContent == null) {
        sideWidthContent = next;
      }
    });
    untrack(() => {
      if (resizingSide) return;
      if (lastSideWidthRaw === w) return;
      // each sideTransition request is uniquely non-null
      sideTransition = Symbol();
    });
    lastSideWidthRaw = w;
  });

  const endTransitionState = () => {
    if (!sideShow) sideWidthContent = null;
    sideTransition = null; // setting sideTransition will clear the timer.
  };

  $effect.pre(() => {
    if (sideTransition == null) return;
    let timer = untrack(() => setTimeout(endTransitionState, TRANSITION_MS + 50));
    return () => clearTimeout(timer);
  });

  $effect.pre(() => {
    sideShow;
    untrack(() => {
      if (sideWidth != null) {
        sideWidthRaw = sideShow ? clamp(sideWidth, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH) : 0;
      }
    });
  });

  $effect(() => {
    if (!resizingSide) {
      // whenever resizing finishes
      untrack(() => {
        sideShow = sideWidthRaw > 0;
        if (sideShow && sideWidth != null) sideWidth = sideWidthRaw;
        if (!sideShow && sideTransition == null) sideWidthContent = null;
      });
    }
  });

  const sideControl = useDragControl({
    onClick: () => {
      sideShow = !sideShow;
    },
    onStart: () => {
      resizingSide = true;
      return { sideWidthRaw };
    },
    onMove: (dx, dy, start) => {
      if (dx === 0) return;
      const freeWidth = start.sideWidthRaw + dx;
      const nextWidth = clamp(freeWidth, 0, MAX_SIDE_WIDTH);
      sideWidthRaw = nextWidth;
    },
    onFinish: () => {
      resizingSide = false;
      const endWidth =
        sideWidthRaw <= COLLAPSE_WIDTH ? 0 : clamp(sideWidthRaw, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH);
      sideWidthRaw = endWidth;
    },
  });
</script>

<div class="fixed top-0 left-0">
  sideShow: {sideShow}; resizingSide: {resizingSide}; sideWidth: {sideWidth ?? "null"};
  sideWidthContent: {sideWidthContent ?? "null"}; sideTransition: {sideTransition != null};
  sideWidthRaw: {sideWidthRaw}
</div>

<div class="relative w-fit">
  <div
    class="mt-40 ml-40 box-border h-80 overflow-hidden border-r-10 border-gray-200 bg-red-500 py-2"
    style:width="{sideWidthRaw}px"
    style:transition={!resizingSide ? `width ${TRANSITION_MS}ms linear` : ""}
    ontransitionend={(ev) => {
      if (ev.target !== ev.currentTarget) return;
      if (ev.propertyName !== "width") return;
      endTransitionState();
    }}
  >
    {#if sideWidth != null && sideWidthContent != null}
      <div class="h-full bg-amber-400" style:width="{sideWidthContent}px">
        !resizingSide && "transition-transform duration-200 ease-linear", !resizingSide &&
        "transition-transform duration-200 ease-linear",
      </div>
    {/if}
  </div>
  {#if sideWidth != null}
    <div
      class="absolute inset-y-4 -right-1 w-2 cursor-col-resize bg-purple-500"
      {@attach sideControl}
    ></div>
  {/if}
</div>
