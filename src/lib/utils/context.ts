import { getContext, setContext } from "svelte";

export function createContext<T>(key?: any) {
  const k = key ?? {};
  const getter = () => {
    const ctx = getContext(k);
    if (ctx === undefined) throw new Error(`getContext() returned undefined`);
    return ctx as T;
  };
  const setter = (ctx: T) => setContext(k, ctx);
  return [getter, setter] as [() => T, (ctx: T) => void];
}
