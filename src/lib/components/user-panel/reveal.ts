import { scrollWithCallback } from "$lib/utils/dom";
import { revealTargetFor, settledRowTop } from "$lib/components/list-kit/reveal";

// What the reveal needs from a row: its root element and the height it will
// have once its expand animation finishes.
export type RowHandle = { getEl: () => HTMLElement | undefined; getEndHeight: () => number };

// Scroll `container` so an expanding row ends up fully in view with `spacing`
// px of breathing room above and below its final (post-expand) extent. Calls
// `onDone` when settled — immediately if no scrolling is needed.
export function revealRow(
  container: HTMLElement,
  row: RowHandle,
  { spacing, duration }: { spacing: number; duration: number },
  onDone: () => void,
) {
  const el = row.getEl();
  if (!el) return onDone();

  const elTop = settledRowTop(container, el);
  const top = elTop - spacing;
  const bottom = top + spacing * 2 + row.getEndHeight();

  const target = revealTargetFor(top, bottom, container.scrollTop, container.clientHeight);
  if (target == null) return onDone();

  // A target past the current max scroll means the row is still growing —
  // wait out the expand animation before scrolling.
  const maxScrollTopNow = container.scrollHeight - container.clientHeight;
  const delay = target >= maxScrollTopNow ? duration : null;
  scrollWithCallback(container, target, onDone, duration, delay);
}
