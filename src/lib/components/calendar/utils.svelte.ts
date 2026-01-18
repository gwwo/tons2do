import type { Attachment } from "svelte/attachments";

export const useScrollTopBind = (initialTop: number, onScroll?: (scrollTop: number) => void) => {
  let scrollTop = $state(initialTop);
  let request: { top: number; instant?: boolean }[] = $state.raw([
    { top: initialTop, instant: true },
  ]);
  const scrollTopBind: Attachment<HTMLElement> = (el) => {
    const handler = onScroll
      ? () => {
          scrollTop = el.scrollTop;
          onScroll(el.scrollTop);
        }
      : () => (scrollTop = el.scrollTop);
    el.addEventListener("scroll", handler);

    $effect(() => {
      request.forEach(({ top, instant }) => {
        el.scrollTo({
          top,
          behavior: instant ? "instant" : "smooth",
        });
      });
    });
    return () => el.removeEventListener("scroll", handler);
  };
  const getScrollTop = () => scrollTop;
  const scrollTopTo = (positions: { top: number; instant?: boolean }[]) => {
    request = positions;
  };
  return { scrollTopBind, getScrollTop, scrollTopTo };
};

type Timer = ReturnType<typeof setTimeout>;

export const useScrollingTrack = (thresholdForScrollFar: number, ignoreFirst: boolean = true) => {
  let scrolling = $state(false);
  let far = $state(false);

  let scrollStartPosition: number | undefined;
  let noScrollTimeout: Timer | undefined;
  let earlyStopTimeout: Timer | undefined;
  let cleanFarTimeout: Timer | undefined;

  const clear = (...timeouts: (Timer | undefined)[]) =>
    timeouts.forEach((t) => {
      if (t !== undefined) clearTimeout(t);
    });

  $effect(() => {
    if (scrolling === false) {
      scrollStartPosition = undefined;
      clear(noScrollTimeout, earlyStopTimeout, cleanFarTimeout);
      cleanFarTimeout = setTimeout(() => {
        if (scrolling === false) far = false;
        cleanFarTimeout = undefined;
      }, 100);
    }
  });

  const doScroll = (position: number) => {
    if (ignoreFirst) {
      ignoreFirst = false;
      return;
    }

    if (!far && scrollStartPosition !== undefined) {
      const distance = Math.abs(position - scrollStartPosition);
      if (distance > thresholdForScrollFar) far = true;
    }
    if (!scrolling) {
      scrollStartPosition = position;
      scrolling = true;
      // far = false;
    } else {
      clear(noScrollTimeout, earlyStopTimeout);
    }
    noScrollTimeout = setTimeout(() => {
      scrolling = false;
      noScrollTimeout = undefined;
    }, 500);
  };

  const stopScrollSoon = () => {
    if (!scrolling) return;
    clear(earlyStopTimeout);
    earlyStopTimeout = setTimeout(() => {
      scrolling = false;
      earlyStopTimeout = undefined;
    }, 100);
  };
  const isScrolling = () => scrolling;
  const isScrollingFar = () => scrolling && far;

  return { doScroll, stopScrollSoon, isScrolling, isScrollingFar };
};
