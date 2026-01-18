<script lang="ts" module>
  import { createContext } from "$lib/utils/context";

  type PileAppear = {
    width: number;
    height: number;
    mouseDownOffset: { x: number; y: number };
  };

  export type Insertion<T> = Readonly<{
    items: T[];
    itemIds: Set<string>;
    itemsToRender: { item: T; offsetTop: number }[];
    pile: PileAppear;
    getComfine?: () => DOMRect | undefined;
    sever: () => void;
    fromComponentId: string;
  }>;

  type Request<T> = Readonly<{
    mouseDown: { x: number; y: number };
    condition: (dx: number, dy: number) => boolean;
    initiate: () => Insertion<T> | undefined;
  }>;

  type Target<T> = Readonly<
    {
      toComponentId: string;
      insert?: () => void;
    } & T
  >;

  export type Inserter<TItem, TInfo> = {
    register: (req: Request<TItem>) => void;
    getInsertion: () => Insertion<TItem> | undefined;
    getTarget: () => { toComponentId: string } | null;
    setTarget: (t: Target<TInfo> | null) => void;
    receive: CrossfadeTransition;
    getPileComfinedOffsetTop: () => number | undefined;
  };

  export function createInserterContext<TItem, TAppear>() {
    return createContext<Inserter<TItem, TAppear>>();
  }

  import { tick, untrack, type Snippet } from "svelte";
</script>

<script lang="ts" generics="ItemInsert extends {id: string}, TargetInfo">
  import { fly } from "svelte/transition";
  import { clampSoft, crossfade, type CrossfadeTransition } from "./utils";
  import { isChromium, isSafari } from "$lib/utils/dom";

  type Props = {
    row: Snippet<
      [item: ItemInsert, index: number, alive: boolean, pile: PileAppear, target: TargetInfo | null]
    >;
    setInserter: (cxt: Inserter<ItemInsert, TargetInfo>) => void;
    pileRenderOffset?: { x: number; y: number };
    children: Snippet;
  };

  let { row, children, setInserter, pileRenderOffset = { x: 0, y: 0 } }: Props = $props();

  const [send, receive] = crossfade({
    duration: (d) => Math.max((400 * d) / (d + 100), 200),
  });

  const slideTo = (
    node: HTMLElement,
    params: { duration?: number; dx?: number; dy?: number } = {},
  ) => {
    const { duration = 200, dx = 0, dy = 0 } = params;
    if (dx === 0 && dy === 0) return {};
    return {
      duration,
      css: (t: number) => `transform: translate(${t * dx}px, ${t * dy}px);`,
    };
  };

  let insertion: Insertion<ItemInsert> | undefined = $state.raw();

  $effect(() => {
    const classesWhenDrag = ["cursor-default", "dragging-to-insert"];
    if (typeof document === "undefined") return; // SSR guard
    const root = document.documentElement;

    if (insertion) root.classList.add(...classesWhenDrag);
    else root.classList.remove(...classesWhenDrag);
    return () => root.classList.remove(...classesWhenDrag);
  });

  let request: Request<ItemInsert> | undefined = $state.raw();

  let mouseMove:
    | { x: number; y: number; vv?: { offsetTop: number; offsetLeft: number } }
    | undefined = $state.raw();

  let vvTracked: { offsetTop: number; offsetLeft: number } | undefined = $state.raw();

  // calculate the pile top left corner position relative to layout viewport
  let pileTranslate: { x: number; y: number } | undefined = $derived.by(() => {
    if (insertion == undefined || mouseMove == undefined) return;
    const { mouseDownOffset } = insertion.pile;
    const x = mouseMove.x - mouseDownOffset.x;
    const y = mouseMove.y - mouseDownOffset.y;
    if (vvTracked && mouseMove.vv) {
      // const vvSinceLastMouseMove = mouseMove.vv;
      const { offsetTop, offsetLeft } = mouseMove.vv;
      const dx = vvTracked.offsetLeft - offsetLeft;
      const dy = vvTracked.offsetTop - offsetTop;
      return { x: x + dx, y: y + dy };
    }
    return { x, y };
  });

  let pileComfined: { x: number; y: number; offsetTop: number } | undefined = $derived.by(() => {
    if (insertion?.getComfine == undefined || pileTranslate == undefined) return;
    const comfineRect = insertion.getComfine();
    if (comfineRect == undefined) return;
    const { height, width } = insertion.pile;
    const { left, right, bottom, top } = comfineRect;
    const { x, y } = pileTranslate;
    // In our use case, this will aways be `insertion.pile.width` not `target.pileWidth`
    const centeredLeft = (left + right - width) / 2;
    const clampedY = clampSoft(y, top, bottom - height);
    return {
      x: clampSoft(x, centeredLeft, centeredLeft),
      y: clampedY,
      offsetTop: clampedY - top,
    };
  });

  let alive = $state(false);

  let target: Target<TargetInfo> | null = $state.raw(null);
  let defaultToComponentId: string | null = $state(null);

  setInserter({
    register: (req) => {
      request = req;
      alive = false;
      insertion = undefined;
      target = null;
      defaultToComponentId = null;
      mouseMove = undefined;
      vvTracked = undefined;
    },
    getInsertion: () => insertion,
    getPileComfinedOffsetTop: () => pileComfined?.offsetTop,
    setTarget: (t) => (target = t),
    getTarget: () => {
      return target ? { toComponentId: target.toComponentId } : null;
    },
    receive,
  });

  const setMouseMove = (clientX: number, clientY: number) => {
    const { offsetLeft, offsetTop } = window.visualViewport ?? {};
    const vv = offsetLeft == null || offsetTop == null ? undefined : { offsetLeft, offsetTop };
    mouseMove =
      vv && isSafari
        ? {
            x: clientX + vv.offsetLeft,
            y: clientY + vv.offsetTop,
            vv,
          }
        : { x: clientX, y: clientY, vv };
  };

  $effect(() => {
    if (request == undefined) return;

    const { mouseDown, condition, initiate } = request;

    const doInitiate = () => {
      insertion = initiate();
      if (insertion == undefined) request = undefined;
      else tick().then(() => (alive = true));
      defaultToComponentId = insertion?.fromComponentId ?? null;
    };

    setTimeout(() => {
      if (condition(0, 0)) {
        doInitiate();
        if (insertion) setMouseMove(mouseDown.x, mouseDown.y);
      }
    });

    const onMouseMove = (ev: MouseEvent) => {
      const { clientX: x, clientY: y } = ev;
      if (insertion == undefined) {
        if (condition(x - mouseDown.x, y - mouseDown.y)) doInitiate();
      }
      if (insertion) setMouseMove(x, y);
    };

    const onMouseUp = async (ev: MouseEvent) => {
      alive = false;
      await tick();
      request = undefined;
      if (insertion) {
        if (target?.insert) {
          insertion.sever();
          target.insert();
        }
        insertion = undefined;
      }
    };

    const onVVScroll = (ev: Event) => {
      const vv = ev.currentTarget as VisualViewport;
      const { offsetLeft, offsetTop } = vv;
      vvTracked = { offsetLeft, offsetTop };
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.visualViewport?.addEventListener("scroll", onVVScroll);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.visualViewport?.removeEventListener("scroll", onVVScroll);
    };
  });
</script>

{@render children()}

{#if insertion}
  {@const { itemsToRender, pile } = insertion}
  {@const { mouseDownOffset, height, width } = pile}
  {@const len = itemsToRender.length}
  {@const translate = pileComfined ?? pileTranslate ?? { x: 0, y: 0 }}
  <div
    class="pointer-events-none fixed z-30"
    style:left="{translate.x}px"
    style:top="{translate.y}px"
    style:transform="translate({pileRenderOffset.x}px, {pileRenderOffset.y}px)"
    in:slideTo={{ dx: pileRenderOffset.x, dy: pileRenderOffset.y }}
    style:height="{height}px"
    style:width="{width}px"
  >
    {#if len > 1 && pileComfined == null && alive}
      <div
        class="absolute z-99 flex size-4 items-center justify-center rounded-full bg-teal-500 text-xs font-semibold text-white"
        style:transform="translate({mouseDownOffset.x + 15}px, {mouseDownOffset.y}px)"
      >
        {len}
      </div>
    {/if}

    {#each itemsToRender.toReversed() as { item, offsetTop }, index (item.id)}
      <div
        in:fly|global={{ y: offsetTop, duration: 300, opacity: 1 }}
        out:send|global={{
          // ensure that when defaultToComponentId is nullible, it doesn't read insertion.fromComponentId,
          // as it would be undefined after out triggered by `{#if insertion}`
          key: `${target?.toComponentId ?? defaultToComponentId}//${item.id}`,
        }}
        class="absolute h-fit w-full"
      >
        {@render row(item, len - 1 - index, alive, pile, target)}
      </div>
    {/each}
  </div>
{/if}
