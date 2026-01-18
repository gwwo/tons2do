import { untrack } from "svelte";

export function autoPrune<T>(getRecord: () => Record<string, T | null>) {
  // this doesn't register dependency on each key's value change.
  // so only clean up when the key set changes
  $effect(() => {
    const store = getRecord();
    const keys = Object.keys(store);
    untrack(() => {
      for (const k of keys) {
        if (store[k] == null) delete store[k];
      }
    });
  });
}
