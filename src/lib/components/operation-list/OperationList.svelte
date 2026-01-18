<script lang="ts" module>
  export const operations: {
    value: OperationInstance;
    iconClass: string;
    buttonClass?: string;
  }[] = [
    {
      value: "clutter",
      iconClass: "icon-[heroicons--inbox-solid] text-cyan-600",
    },
    {
      value: "timeline",
      iconClass: "icon-[mdi--timeline-clock] text-lime-600",
      buttonClass: "mt-4",
    },
    {
      value: "search",
      iconClass: "icon-[ic--twotone-manage-search] scale-110 text-purple-600",
    },
    {
      value: "archive",
      iconClass: "icon-[mynaui--book-check-solid] text-yellow-600",
    },
    {
      value: "trash",
      iconClass: "icon-[mynaui--trash-two-solid] text-gray-400",
    },
  ];
</script>

<script lang="ts">
  import type { OperationInstance } from "$lib/model";
  import type { ClassValue, HTMLAttributes } from "svelte/elements";

  type Props = {
    class: ClassValue;
    showOperation: (op: OperationInstance) => void;
    operationShown: OperationInstance | null;
  };

  let { class: className, showOperation, operationShown }: Props = $props();

  const labelFromValue = (value: OperationInstance) =>
    value.charAt(0).toUpperCase() + value.slice(1);
</script>

<div class={[className, "font-semibold text-gray-700 select-none"]}>
  {#each operations as op}
    <button
      class={[
        "flex h-[28px] w-full items-center gap-2 rounded-md px-2",
        op.buttonClass,
        op.value === operationShown ? "bg-pink-200" : "",
      ]}
      onclick={() => showOperation(op.value)}
    >
      <span class={[op.iconClass, "size-4.5"]}></span>
      <p>{labelFromValue(op.value)}</p>
    </button>
  {/each}
</div>
