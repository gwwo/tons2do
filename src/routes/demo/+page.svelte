<script lang="ts">
  import { untrack } from "svelte";

  let count = $state(0);

  let preCount = $state(count);

  const trackPrevious = <T,>(getCurrent: () => T, setPre: (v: T) => void) => {
    let store: T | null = null;
    $effect.pre(() => {
      const v = getCurrent();
      untrack(() => {
        if (v !== store) {
          if (store !== null) setPre(store);
          store = v;
        }
      });
    });
  };

  trackPrevious(
    () => count,
    (v) => (preCount = v),
  );

  const usePrevious = <T,>(getCurrent: () => T) => {
    const init = getCurrent();
    let pre = $state(init);
    let store = init;
    $effect.pre(() => {
      const v = getCurrent();
      untrack(() => {
        if (v !== store) {
          pre = store;
          store = v;
        }
      });
    });
    return () => pre;
  };

  const usePre = <T,>(init: T) => {
    let pre = init;
    let store = init;
    return (current: T) => {
      if (store !== current) {
        pre = store;
        store = current;
      }
      return pre;
    };
  };

  let getPre = usePre(count);

  // risk of being called with other variables than count
  let pre = $derived(getPre(count));

  let getPrevCount = usePrevious(() => count);

  let previous = $derived(getPrevCount());
</script>

<button onclick={() => (count += 1)}>add</button>
<div>{previous}; {count}</div>

<div>{pre}; {count}</div>

<div>{preCount}; {count}</div>
