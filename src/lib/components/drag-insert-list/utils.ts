export const capAsymptotic = (absolute: number, limit?: number, halfLimitMove?: number) => {
  limit = limit ?? 20;
  halfLimitMove = halfLimitMove ?? 200;
  const ratio = absolute / halfLimitMove;
  return Math.round(limit * (1 - 1 / (ratio + 1)));
};

export const clampSoft = (value: number, lower: number, upper: number) => {
  const outLowerBound = lower - value;
  const outUpperBound = value - upper;
  return outLowerBound > 0
    ? lower - capAsymptotic(outLowerBound)
    : outUpperBound > 0
      ? upper + capAsymptotic(outUpperBound)
      : value;
};

import { quintOut, cubicOut } from "svelte/easing";

type TransitionConfig = {
  delay?: number;
  duration?: number;
  easing?: (t: number) => number;
  css?: (t: number, u: number) => string;
  tick?: (t: number, u: number) => void;
};

type CrossfadeParams = {
  delay?: number;
  duration?: number | ((d: number) => number);
  easing?: (t: number) => number;
};

export type CrossfadeTransition = (
  node: Element,
  params: CrossfadeParams & {
    key: any;
  },
) => () => TransitionConfig;

// export { crossfade } from "svelte/transition";

export const crossfade = (
  defaults: CrossfadeParams,
): [CrossfadeTransition, CrossfadeTransition] => {
  const toReceive = new Map<any, Element>();
  const toSend = new Map<any, Element>();

  const fallback = (node: Element, params: CrossfadeParams, intro: boolean): TransitionConfig => {
    if (intro === false) return {};

    const style = getComputedStyle(node);
    const transform = style.transform === "none" ? "" : style.transform;
    const dx = 50;

    node.animate(
      [
        { transform: `${transform} translateX(${dx}px)`, opacity: 0 },
        { transform: `${transform}`, opacity: 1 },
      ],
      { duration: 250 },
    );

    return {};
  };

  const crossfadeTransition = (
    fromRect: DOMRect,
    toRect: DOMRect,
    node: Element,
    params: CrossfadeParams,
    intro: boolean,
  ): TransitionConfig => {
    const { duration = (d: number) => Math.sqrt(d) * 30, easing = cubicOut } = Object.assign(
      Object.assign({}, defaults),
      params,
    );

    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    const d = Math.sqrt(dx * dx + dy * dy);
    const style = getComputedStyle(node);
    const transform = style.transform === "none" ? "" : style.transform;

    const dur = typeof duration === "function" ? duration(d) : duration;

    if (intro) {
      // this won't cause phantom scroll in safari when node enters from a outbound position
      node.animate(
        [
          { opacity: 0, offset: 0 },
          { opacity: 0, offset: 1 },
        ],
        { duration: dur, easing: "steps(1, end)" },
      );
      return {};
    }

    // using `animate` is noticably better performance-wise than return css.
    // also alleviate the flash back in safari when inserting with speeding cursor
    node.animate([{ transform: `${transform} translateX(${dx}px) translateY(${dy}px)` }], {
      duration: dur,
      fill: "forwards",
    });

    return { duration: dur };
  };

  const outroRectsCached = new Map<any, DOMRect>();
  const transition = (
    items: Map<any, Element>,
    counterparts: Map<any, Element>,
    intro: boolean,
  ): CrossfadeTransition => {
    return (node, params) => {
      const { key } = params;
      items.set(key, node);
      return () => {
        if (counterparts.has(key)) {
          const other = counterparts.get(key)!;
          counterparts.delete(key);

          const fromRect =
            (intro ? outroRectsCached.get(key) : undefined) ?? other.getBoundingClientRect();
          const toRect = node.getBoundingClientRect();
          // the below relies on intro happenning after outro, to clean up referrence
          if (intro) outroRectsCached.delete(key);
          else {
            // only when intro hasn't happened, we set cache
            if (items.get(key) != undefined) outroRectsCached.set(key, toRect);
          }
          return crossfadeTransition(fromRect, toRect, node, params, intro);
        }
        items.delete(key);
        return fallback(node, params, intro);
      };
    };
  };

  return [transition(toSend, toReceive, false), transition(toReceive, toSend, true)];
};

import { tick } from "svelte";

export type IntroTransition = (node: HTMLElement) => (() => TransitionConfig) | {};
export type OrderTransition = (
  node: HTMLElement,
  { from, to }: { from: DOMRect; to: DOMRect },
  params?: any,
) => TransitionConfig;

export const reorder = (
  node: HTMLElement,
  { from, to }: { from: DOMRect; to: DOMRect },
  params: {
    translateY: number;
    panelRect?: DOMRect;
    shortcut?: boolean;
  },
) => {
  const { translateY, panelRect, shortcut } = params;
  if (shortcut) return {};
  if (panelRect) {
    const { top, bottom } = panelRect;
    const fromOutSight = top >= from.bottom || bottom <= from.top;
    const toOutSight = top >= to.bottom || bottom <= to.top;
    if (fromOutSight && toOutSight) return {};
  }

  const dy = from.top - to.top;
  const { transform } = getComputedStyle(node);
  const dyFinal = new DOMMatrix(transform).m42;

  const startValueRaw = dyFinal + dy;
  const endValue = translateY;

  // if startValue == endValue, there will be animation jitter
  // which probably is due to the browser's optimisation behaviour.
  const minDelta = 1 / (devicePixelRatio * 10);
  const startValue =
    Math.abs(startValueRaw - endValue) < minDelta
      ? endValue + (startValueRaw > endValue ? minDelta : -minDelta)
      : startValueRaw;
  node.style.transition = `transform 0s, margin 0s`;
  node.style.transform = `translateY(${startValue}px)`;
  // console.log("margin top", getComputedStyle(node).marginTop)
  node.offsetHeight;
  tick().then(() => {
    node.style.transition = ``;
    node.style.transform = `translateY(${endValue}px)`;
  });
  return {};
};

export const fixSizeOnDrag = (node: HTMLDivElement, tailwindClass?: string | string[]) => {
  const className = Array.isArray(tailwindClass) ? tailwindClass.join(" ") : tailwindClass;
  const autoHeight =
    className == undefined ||
    /\b(h-auto|size-auto)\b/.test(className) ||
    !/\b(h-\d+|h-\[[^\]]+\]|size-\d+|size-\[[^\]]+\])\b/.test(className);
  const autoWidth =
    className == undefined ||
    /\b(w-auto|size-auto)\b/.test(className) ||
    !/\b(w-\d+|w-\[[^\]]+\]|size-\d+|size-\[[^\]]+\])\b/.test(className);

  if (!autoHeight && !autoWidth) return;
  const { height, width } = node.getBoundingClientRect();
  if (autoHeight) node.style.height = `${height}px`;
  if (autoWidth) node.style.width = `${width}px`;
  return {
    onDragEnd: () => {
      tick().then(() => {
        if (autoHeight) node.style.height = `auto`;
        if (autoWidth) node.style.width = `auto`;
      });
    },
  };
};

const calcBoundary = (arg: {
  pileUpTop: number;
  pileDownTop: number;
  pileHeight: number;
  blockDownTop: number;
  blockUpTop: number;
  blockHeight: number;
}) => {
  const { pileUpTop, pileDownTop, pileHeight, blockDownTop, blockUpTop, blockHeight } = arg;
  const minMove = 5;
  const clipTop = pileUpTop + minMove;
  const clipBottom = pileDownTop - minMove;
  if (clipTop >= clipBottom) return (pileUpTop + pileDownTop) / 2;
  // const boundary = blockUpTop + blockHeight - erosion;
  // const boundary = blockDownTop + erosion - pileHeight;
  // combine the two above, eliminate erosion
  const boundary = (blockUpTop + blockDownTop + blockHeight - pileHeight) / 2;
  return Math.min(clipBottom, Math.max(boundary, clipTop));
};

export type Insertable = {
  index: number;
  spacePrecede: number;
  spaceFollow: number;
};

export type InsertPreview = {
  precedeBlockBottom: number;
  followBlockTop: number;
  insertTop: number;
  spaceFollow: number;
};

export function calcInsertMoves(
  previews: readonly InsertPreview[],
  insertHeight: number,
): {
  blockMoveDown: number;
  borderNext?: number;
}[] {
  const len = previews.length;
  return previews.map(({ insertTop, followBlockTop, spaceFollow }, i) => {
    const blockUpTop = followBlockTop;
    const blockDownTop = insertTop + insertHeight + spaceFollow;
    const blockMoveDown = blockDownTop - blockUpTop;

    if (i < len - 1) {
      const next = previews[i + 1];
      const blockHeight = next.precedeBlockBottom - followBlockTop;
      const borderNext = calcBoundary({
        pileUpTop: insertTop,
        pileDownTop: next.insertTop,
        pileHeight: insertHeight,
        blockDownTop,
        blockHeight,
        blockUpTop,
      });
      return { blockMoveDown, borderNext };
    }
    return { blockMoveDown };
  });
}
