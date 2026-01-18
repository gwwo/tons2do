import type { TransitionConfig } from "svelte/transition";

export function slideFly(
  node: HTMLElement,
  params: {
    duration?: number;
    axis?: "x" | "y";
    x?: number;
    y?: number;
    opacity?: number;
  } = {},
  options: { direction: "in" | "out" | "both" },
): TransitionConfig {
  const { duration = 400, axis = "y", x = 0, y = 0, opacity = 0 } = params;
  const style = getComputedStyle(node);
  const primaryProperty = axis === "y" ? "height" : "width";
  const primaryPropertyValue = parseFloat(style[primaryProperty]);
  const size = Number.isFinite(primaryPropertyValue) ? primaryPropertyValue : 0;
  const targetOpacity = +style.opacity;
  const transform = style.transform === "none" ? "" : style.transform;
  const od = targetOpacity * (1 - opacity);
  const baseTransform = transform ? `${transform} ` : "";

  const { direction } = options;
  const enter = {
    [primaryProperty]: "0px",
    [`min-${primaryProperty}`]: "0px",
    transform: `${baseTransform}translate(${x}px, ${y}px)`,
    opacity: targetOpacity - od,
  };
  const stable = {
    [primaryProperty]: `${size}px`,
    [`min-${primaryProperty}`]: "0px",
    transform: `${baseTransform}translate(0px, 0px)`,
    opacity: targetOpacity,
  };

  node.animate(direction === "in" ? [enter, stable] : [stable, enter], {
    duration,
    easing: direction === "in" ? "ease-out" : "ease-in",
    fill: direction === "in" ? "none" : "forwards",
  });
  return { duration: duration };
}
