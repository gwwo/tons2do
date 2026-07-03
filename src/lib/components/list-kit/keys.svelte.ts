import { getPanelContext } from "$lib/client/context";
import { usePanelFocus } from "$lib/components/panel/PanelGroup.svelte";

// True when the key event originates from a text-editing element — list-level
// shortcuts must not fire (or preventDefault) while the user is typing.
export const isEditableTarget = (e: KeyboardEvent): boolean => {
  const el = e.target as HTMLElement;
  return (
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
  );
};

/**
 * Install a document-level keydown handler that is active only while this
 * panel is the keyboard target (the lone panel, or the focused one of
 * several), and never fires while the user is editing text.
 *
 * Call during component init (it reads the panel/focus contexts and owns an
 * $effect). The handler is responsible for its own key filtering and
 * preventDefault.
 */
export function usePanelKeydown(handle: (e: KeyboardEvent) => void) {
  const { panelId } = getPanelContext();
  const panelFocus = usePanelFocus();

  $effect(() => {
    const isKeyboardTarget = !panelFocus.multiPanel || panelFocus.panelId === panelId;
    if (!isKeyboardTarget) return;
    const listener = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      handle(e);
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  });
}
