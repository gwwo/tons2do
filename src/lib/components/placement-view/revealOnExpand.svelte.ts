import type { Attachment } from "svelte/attachments";
import { scrollWithCallback } from "$lib/utils/dom";
import {
  EXPAND_DURATION as expandDuration,
  EXPANDED_SPACING as expandedSpacing,
  revealTargetFor,
  settledRowTop,
} from "$lib/components/list-kit/reveal";

type Options = {
  /** The id of the row that just expanded, or null when nothing to reveal. */
  rowIdToReveal: () => string | null;
  /** Reset rowIdToReveal back to null. */
  clear: () => void;
  /** The row's box element (the `data-placement-row` div wrapping the TodoRow). */
  rowEl: (id: string) => HTMLElement | null | undefined;
  /** The settled height of the TodoRow once expanded (TodoRow.getEndHeight). */
  endHeight: (id: string) => number | null | undefined;
};

/**
 * Attachment for the scrollable DragList that scrolls a freshly-expanded todo
 * row into view. Mirrors the reveal behaviour of the ordinary project view
 * (TodoList) and the user panel (UserView): it predicts the row's settled
 * layout from TodoRow.getEndHeight so the scroll can start while the expand
 * animation is still running.
 */
export function revealOnExpand(opts: Options): Attachment<HTMLElement> {
  return (node) => {
    $effect(() => {
      const id = opts.rowIdToReveal();
      if (id == null) return;
      // The expanded TodoRow + its element binding aren't settled in the same
      // microtask the id is set, so defer a tick before measuring.
      setTimeout(() => {
        const el = opts.rowEl(id);
        const end = opts.endHeight(id);
        if (!el || end == null) {
          opts.clear();
          return;
        }

        const elTop = settledRowTop(node, el);
        const top = elTop - expandedSpacing;
        // The row box adds py-2 (16px) padding around the TodoRow when expanded.
        const bottom = elTop + 16 + end + expandedSpacing;

        const target = revealTargetFor(top, bottom, node.scrollTop, node.clientHeight);
        if (target == null) {
          opts.clear();
          return;
        }

        // A target past the current max scroll means the row is still growing —
        // wait out the expand animation before scrolling.
        const maxScrollTopNow = node.scrollHeight - node.clientHeight;
        const delay = target >= maxScrollTopNow ? expandDuration : null;
        scrollWithCallback(node, target, opts.clear, expandDuration, delay);
      });
    });
  };
}
