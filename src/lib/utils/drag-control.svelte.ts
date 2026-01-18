import type { Attachment } from "svelte/attachments";

type PointerControlOptions<TStart> = {
  onStart: () => TStart;
  onMove: (dx: number, dy: number, start: TStart) => void;
  onFinish: () => void;
  onClick?: () => void;
  cursorStyle: Style;
};

type Style = "col-resize" | "nwse-resize" | "ew-resize" | "ns-resize";

const setForcedCursor = (
  cursorStyle: "col-resize" | "nwse-resize" | "ew-resize" | "ns-resize" | null,
) => {
  if (cursorStyle == null) {
    document.body.style.removeProperty("--cursor");
    document.body.classList.remove("force-cursor");
    return;
  }
  document.body.style.setProperty("--cursor", cursorStyle);
  document.body.classList.add("force-cursor");
};

export const useDragControl = <TStart>({
  onStart,
  onMove,
  onFinish,
  onClick,
  cursorStyle,
}: PointerControlOptions<TStart>): Attachment<HTMLDivElement> => {
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
        setForcedCursor(null);
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
      setForcedCursor(cursorStyle);
    };

    node.addEventListener("pointerdown", begin);
    return () => node.removeEventListener("pointerdown", begin);
  };
};
