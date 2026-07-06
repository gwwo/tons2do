<script lang="ts">
  import { fade } from "svelte/transition";
  import { getAppState } from "$lib/client/context";
  import { undoMove, redoMove, undoCue, pendingChecksTodoId } from "$lib/client/undo.svelte";
  import { isEditableTarget } from "$lib/components/list-kit/keys.svelte";

  const appState = getAppState();

  // Global (app-wide, not per-panel) undo/redo shortcuts. Cmd/Ctrl+Z undoes,
  // Shift+Cmd/Ctrl+Z or Ctrl+Y redoes. Text-editing targets are left alone so
  // native text undo keeps working while typing.
  $effect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const action: "undo" | "redo" | null =
        key === "z" ? (e.shiftKey ? "redo" : "undo") : key === "y" && !e.shiftKey ? "redo" : null;
      if (action == null) return;
      if (isEditableTarget(e)) {
        // Exception: a check input of the very checklist the pending entry
        // would rewrite. A keyboard check delete (Cmd/Ctrl+Backspace, or
        // Backspace on an empty check) moves focus into a sibling check, and
        // undo should restore the deleted check right there. Text undo isn't
        // sacrificed: check inputs commit per keystroke, so any typing fires
        // an interrupting edit that empties the history and this exception
        // stops matching — Cmd/Ctrl+Z falls back to native text undo.
        const todoId = pendingChecksTodoId(action);
        const host = (e.target as Element).closest?.("[data-checklist-todo]");
        if (todoId == null || host?.getAttribute("data-checklist-todo") !== todoId) return;
      }
      e.preventDefault();
      if (action === "undo") undoMove(appState);
      else redoMove(appState);
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });

  // End-of-history cue: undoing/redoing with nothing left flashes a transient
  // pill. Keyed on undoCue.seq so a repeated press re-arms the hide timer.
  let cueText = $state<string | null>(null);
  $effect(() => {
    if (undoCue.seq === 0 || undoCue.kind == null) return;
    cueText = undoCue.kind === "undo" ? "Nothing to undo" : "Nothing to redo";
    const timer = setTimeout(() => (cueText = null), 1400);
    return () => clearTimeout(timer);
  });
</script>

<!-- Same look and placement as app.html's status banner ("Making page
     interactive…"): top-center pill, dark translucent background. -->
{#if cueText}
  <div
    class="pointer-events-none fixed top-3 left-1/2 z-99999 -translate-x-1/2 rounded-full bg-[rgba(20,20,22,0.85)] px-3.5 py-1.75 text-[13px] leading-none font-medium text-white shadow-[0_4px_14px_rgba(0,0,0,0.18)]"
    transition:fade={{ duration: 150 }}
  >
    {cueText}
  </div>
{/if}
