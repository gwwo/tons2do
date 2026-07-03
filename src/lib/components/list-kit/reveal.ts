// Shared scroll-reveal math for expanding/navigating list rows. The same
// view-fit decision tree used by the project page, the placement views, and
// the user panel — extracted so the three stay in sync.

// Breathing room an expanded row gets above/below, and the expand animation
// duration reveals scroll against — shared by every expanding list.
export const EXPANDED_SPACING = 30;
export const EXPAND_DURATION = 200;

/**
 * Where to scroll a container so a row spanning [top, bottom] (content
 * coordinates) is comfortably in view. Returns null when it already is.
 *
 * - taller than the viewport → pin its top
 * - fully outside → center it
 * - overlapping the bottom edge → align its bottom
 * - otherwise (overlapping the top edge) → align its top
 */
export function revealTargetFor(
  top: number,
  bottom: number,
  viewTop: number,
  viewHeight: number,
): number | null {
  const viewBottom = viewTop + viewHeight;
  if (top >= viewTop && bottom <= viewBottom) return null;

  const isRowTall = bottom - top >= viewHeight;
  const isRowOutsideView = top >= viewBottom || bottom <= viewTop;
  const isRowOverlapsBottom = top < viewBottom && bottom > viewBottom;

  return isRowTall
    ? top
    : isRowOutsideView
      ? (top + bottom - viewHeight) / 2
      : isRowOverlapsBottom
        ? bottom - viewHeight
        : top;
}

/**
 * The row's settled top offset within its scroll container. The row's wrapper
 * (its parentElement) carries the final margin-top inline, but a CSS margin
 * transition means the computed value still lags — correct by the difference
 * so the offset reflects the settled layout, not the mid-transition one.
 */
export function settledRowTop(container: HTMLElement, el: HTMLElement): number {
  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const wrapper = el.parentElement;
  const wrapperInlineMargin = parseFloat(wrapper?.style.marginTop ?? "0") || 0;
  const wrapperComputedMargin = wrapper ? parseFloat(getComputedStyle(wrapper).marginTop) : 0;
  return (
    elRect.top -
    containerRect.top +
    container.scrollTop +
    (wrapperInlineMargin - wrapperComputedMargin)
  );
}

/** Smooth-scroll `el` into `container`'s view if it's outside (no centering). */
export function scrollRowIntoView(container: HTMLElement, el: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const top = elRect.top - containerRect.top + container.scrollTop;
  const bottom = elRect.bottom - containerRect.top + container.scrollTop;
  if (top < container.scrollTop) {
    container.scrollTo({ top, behavior: "smooth" });
  } else if (bottom > container.scrollTop + container.clientHeight) {
    container.scrollTo({ top: bottom - container.clientHeight, behavior: "smooth" });
  }
}
