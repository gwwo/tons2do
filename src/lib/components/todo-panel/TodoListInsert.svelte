<script lang="ts" module>
  import { createInserterContext } from "$lib/components/drag-insert-list/InsertPile.svelte";

  import type { RowItem, GroupingItem, TodoItem } from "$lib";

  import { isGroupingItem as isG, isTodoItem as isT, placeholder, TodoRow } from "$lib";

  type HeadItem = { id: "head" };
  export const headItem: HeadItem = { id: "head" } as const;
  export type Item = RowItem | HeadItem;

  export const isHeadItem = (item: Item): item is HeadItem => item.id === "head";
  export const isGroupingItem = (item: Item): item is GroupingItem =>
    !isHeadItem(item) && isG(item);
  export const isTodoItem = (item: Item): item is TodoItem => !isHeadItem(item) && isT(item);

  export type ItemInsert = {
    raw: Item;
    id: string;
    isSelected?: boolean;
  };

  type TargetInfo = {
    pileWidth?: number;
    shrink?: boolean;
  };

  const [useTodoListInserter, setInserter] = createInserterContext<ItemInsert, TargetInfo>();

  export { useTodoListInserter };

  export const paddingX = 8;
</script>

<script lang="ts">
  import InsertPile from "$lib/components/drag-insert-list/InsertPile.svelte";
  import type { Snippet } from "svelte";
  import DormantInput from "../DormantInput.svelte";

  type Props = { children: Snippet };

  let { children }: Props = $props();
</script>

<InsertPile {setInserter} {children}>
  {#snippet row(item, index, alive, pile, target)}
    {@const shrink = target?.shrink ?? false}
    {@const w = !target || shrink || target.pileWidth == null ? pile.width : target.pileWidth}
    {@const width = w - paddingX * 2}
    {@const { raw, isSelected } = item}
    {@const overlap = index === 1 ? { x: 3, y: 3 } : index === 2 ? { x: 6, y: 6 } : null}
    {@const base = shrink
      ? {
          x: pile.mouseDownOffset.x - 25,
          y: pile.mouseDownOffset.y - 8,
        }
      : null}
    {@const offset = alive
      ? {
          x: (overlap?.x ?? 0) + (base?.x ?? 0),
          y: (overlap?.y ?? 0) + (base?.y ?? 0),
        }
      : { x: 0, y: 0 }}
    <div
      class={[
        "overflow-hidden rounded-md duration-250",
        alive && (index === 1 || index === 2) && (index === 1 ? "opacity-70" : "opacity-40"),
        index === 0 && alive && "shadow-xl",
        isSelected ? "bg-pink-200" : "bg-[#f9fafb]",
        alive && index > 2 && shrink
          ? // disable size transition: alive && index > 2 && shrink
            "transition-[transform,opacity]"
          : "transition-[width,height,transform,opacity]",
      ]}
      style:width="{alive && shrink ? 50 : width}px"
      style:height="{alive && shrink ? 16 : 32}px"
      style:transform="translate({offset.x}px, {offset.y}px)"
      style:margin-left="{paddingX}px"
    >
      <div
        class={[
          alive && shrink && "opacity-0",
          // disable text opacity transition: alive && (index > 2 || shrink)
          !(alive && (index > 2 || shrink)) && "transition-opacity duration-300",
        ]}
        style:width="{width}px"
      >
        {#if isGroupingItem(raw)}
          <DormantInput
            disabled
            placeholder={placeholder.grouping.label}
            class="flex h-8 w-full items-center px-4 font-semibold text-teal-600"
            value={raw.label}
          ></DormantInput>
        {:else if isTodoItem(raw)}
          <TodoRow bind:todo={() => raw, (v) => {}} expanded={false}></TodoRow>
        {/if}
      </div>
    </div>
  {/snippet}
</InsertPile>
