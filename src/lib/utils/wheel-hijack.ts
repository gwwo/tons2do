import { isSafari } from "$lib";
import type { Attachment } from "svelte/attachments";

export const wheelHijack: Attachment<HTMLDivElement> = (node) => {
  const scrollPage = (by: number) => {
    const scroller = document.scrollingElement;
    if (scroller) {
      scroller.scrollTop += by;
    } else {
      window.scrollBy(0, by);
    }
  };
  const handler = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    const maxScrollLeft = node.scrollWidth - node.clientWidth;
    if (maxScrollLeft <= 0) {
      if (isSafari) scrollPage(event.deltaY);
      return;
    }
    const current = node.scrollLeft;
    let deltaY = event.deltaY;
    if (event.deltaMode === 1) deltaY *= 16;
    if (event.deltaMode === 2) deltaY *= window.innerHeight;
    if (deltaY > 0) {
      const remaining = maxScrollLeft - current;
      if (remaining > 0) {
        const consume = Math.min(remaining, deltaY);
        node.scrollLeft = current + consume;
        const leftover = deltaY - consume;
        if (leftover !== 0) scrollPage(leftover);
      } else {
        scrollPage(deltaY);
      }
    } else {
      const remaining = current;
      if (remaining > 0) {
        const consume = Math.min(remaining, -deltaY);
        node.scrollLeft = current - consume;
        const leftover = -deltaY - consume;
        if (leftover !== 0) scrollPage(-leftover);
      } else {
        scrollPage(deltaY);
      }
    }
    if (event.cancelable) event.preventDefault();
  };
  node.addEventListener("wheel", handler, { passive: false });
  return () => node.removeEventListener("wheel", handler);
};
