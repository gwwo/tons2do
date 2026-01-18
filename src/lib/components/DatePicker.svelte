<!-- <script lang="ts">
  import { Inputbar, Input, CheckList, usePicker } from "$lib";
  import type { CheckItem, TodoItem } from "$lib";
  import { onMount, tick, untrack } from "svelte";
  import { slide } from "svelte/transition";

  const picker = usePicker();

  let deadlineExpanded = $state(false);

  let deadlineInput: string = $state("");

  let deadlineShell: HTMLElement | undefined = $state.raw();
  $effect(() => {
    if (deadlineShell && deadlineShell !== picker.getCurrentAnchor()) {
      tick().then(() => {
        deadlineExpanded = false;
        deadlineInput = "";
        deadlineShell = undefined; // would unsubscribe to getCurrentAnchor
      });
    }
  });

  const onExpand = (anchor: HTMLElement) => {
    deadlineShell = anchor;
    
    picker.popup({ anchor, getInput: () => deadlineInput });
  };

  let deadlineBadge: HTMLElement | undefined = $state.raw();
</script>

<Inputbar
  placeholder="Deadline"
  bind:text={deadlineInput}
  bind:expanded={deadlineExpanded}
  class="icon-[iconamoon--flag-light] scale-90"
  {onExpand}
/> -->
