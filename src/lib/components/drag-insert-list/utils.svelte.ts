export const createCallbackComposer = () => {
  type Callback = {
    onDragEnd?: () => void;
    onDragging?: (dx: number, dy: number) => void;
  };
  const callbacks: Callback[] = [];
  const add = (callback: Callback | undefined) => {
    if (callback) callbacks.push(callback);
    return { add, compose };
  };
  const compose = () => ({
    onDragging: (dx: number, dy: number) => callbacks.forEach((cb) => cb?.onDragging?.(dx, dy)),
    onDragEnd: () => callbacks.forEach((cb) => cb?.onDragEnd?.()),
  });
  return { add, compose };
};

type ActiveCallBack = {
  onDragging?: (dx: number, dy: number) => void;
  onDragEnd?: () => void;
};

export function useDragGesture<T extends any[]>(
  onDragActive: (
    dx: number,
    dy: number,
    mouseDownX: number,
    mouseDownY: number,
    ...args: T
  ) => ActiveCallBack | undefined,
) {
  let info: { mouseDownX: number; mouseDownY: number; argsOnActive: T } | null = $state.raw(null);

  $effect(() => {
    if (info == null) return;
    const { mouseDownX, mouseDownY, argsOnActive } = info;

    // the following callback will all be freed once the effect reruns
    let callback: ActiveCallBack | undefined;

    // using untrack will still mess up the order transition
    setTimeout(() => (callback = onDragActive(0, 0, mouseDownX, mouseDownY, ...argsOnActive)));

    const handleMouseMove = (ev: MouseEvent) => {
      const { clientX, clientY } = ev;
      const dx = clientX - mouseDownX;
      const dy = clientY - mouseDownY;
      if (callback == undefined) {
        callback = onDragActive(dx, dy, mouseDownX, mouseDownY, ...argsOnActive);
      } else {
        callback.onDragging?.(dx, dy);
      }
    };
    const handleMouseUp = (ev: MouseEvent) => {
      callback?.onDragEnd?.();
      info = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  });
  const prepareDrag = (mouseDownX: number, mouseDownY: number, ...argsOnActive: T) => {
    info = { mouseDownX, mouseDownY, argsOnActive };
  };

  return prepareDrag;
}

import { tick, untrack } from "svelte";
import { type Attachment } from "svelte/attachments";

const setupAutoScroll = (node: HTMLElement, getDirection: () => "none" | "up" | "down") => {
  $effect(() => {
    const direction = getDirection();

    if (direction === "none") return;
    const { scrollHeight, clientHeight } = node;
    const maxScrollTop = scrollHeight - clientHeight;
    const speed = 2;

    let lastTime: number = performance.now();

    const scroll = (currentTime: number) => {
      const { scrollTop } = node;
      const move = Math.ceil(speed * (currentTime - lastTime)) / 10;
      lastTime = currentTime;
      if (direction === "up") {
        if (scrollTop <= 0) return;
        node.scrollTop = Math.max(0, scrollTop - move);
      }
      if (direction === "down") {
        if (scrollTop >= maxScrollTop) return;
        node.scrollTop = Math.min(maxScrollTop, scrollTop + move);
      }
      animateId = requestAnimationFrame(scroll);
    };
    let animateId = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(animateId);
  });
};

type InsertYController = {
  getInsertY: () => number | undefined;
  getInsertYFor: (mouseY: number) => number | undefined;
  getScrollTop: () => number;
};

export const useInsertListYProvider = (getActive: () => boolean) => {
  // the controller needs to be reactive
  let controller: InsertYController | undefined = $state.raw();

  const setup: Attachment<HTMLElement> = (node) => {
    let scrollSeek: number = $state(0);
    let mouseOverAtY: number | undefined = $state();

    let activeMouseOver = $derived(getActive() && mouseOverAtY != null);
    let distance = $derived.by(() => {
      if (!activeMouseOver) return undefined;
      const Y = mouseOverAtY!;
      const { top, bottom } = node.getBoundingClientRect();
      return { toTop: Y - top, toBottom: bottom - Y };
    });

    const triggerZone = 40;
    let autoScroll: "none" | "up" | "down" = $derived(
      distance == undefined
        ? "none"
        : distance.toTop <= triggerZone
          ? "up"
          : distance.toBottom <= triggerZone
            ? "down"
            : "none",
    );

    $effect.pre(() => {
      if (!activeMouseOver) return;
      setupAutoScroll(node, () => autoScroll);
      const handleScroll = () => (scrollSeek = node.scrollTop);
      node.addEventListener("scroll", handleScroll);
      return () => node.removeEventListener("scroll", handleScroll);
    });

    const getScrollTop = () => {
      scrollSeek;
      // return from the source to prevent stale scrollSeek
      return node.scrollTop;
    };

    controller = {
      getInsertY: () => {
        if (distance == undefined) return undefined;
        return distance.toTop + getScrollTop();
      },
      getInsertYFor: (mouseY: number) => {
        const { top } = node.getBoundingClientRect();
        return mouseY - top + getScrollTop();
      },
      getScrollTop,
    };

    const handleMouseMove = (ev: MouseEvent) => (mouseOverAtY = ev.clientY);
    const handleMouseLeave = () => (mouseOverAtY = undefined);
    node.addEventListener("mousemove", handleMouseMove);
    node.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      controller = undefined;
      node.removeEventListener("mousemove", handleMouseMove);
      node.removeEventListener("mouseleave", handleMouseLeave);
    };
  };

  return {
    getInsertY: () => controller?.getInsertY(),
    getInsertYFor: (mouseY: number) => controller?.getInsertYFor(mouseY),
    getScrollTop: () => controller?.getScrollTop(),
    setup,
  };
};
