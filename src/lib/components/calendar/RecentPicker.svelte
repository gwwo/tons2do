<script lang="ts">
  import { CalendarDate } from "@internationalized/date";
  import { type MonthGrid, calComplement, listDaysOfWeek } from "./utils";
  import { detectHoverOnce } from "$lib";

  type Props = {
    monthNext: MonthGrid;
    dateToday: { day: number };
    rowsToRender: number; // won't render rows exceeding the next month.
    cellSize: number; // in px
    gapWidth: number; // in px
    // the component height would be `rowsToRender * (cellSize + gapWidth)` with the top gaps included.
    dateChosen?: { day: number; month: number; year: number };
    onChoose?: (date: CalendarDate, isLastCell: boolean) => void;
    class?: string | (string | undefined | false)[];
  };

  let {
    monthNext,
    dateToday,
    rowsToRender,
    cellSize,
    gapWidth,
    dateChosen,
    onChoose,
    class: className,
  }: Props = $props();
  const weekLength = listDaysOfWeek.length;

  let maxDaysToRender = $derived(weekLength * rowsToRender);
  let daysRemain = $derived(monthNext.pre.days - dateToday.day + 1);
  let daysPrecede = $derived(calComplement(daysRemain - monthNext.daysPrecede));

  let countDaysToRender = $derived(maxDaysToRender - daysPrecede);

  let daysToRenderCur = $derived(
    Array.from({ length: Math.min(daysRemain, countDaysToRender) }, (_, i) => ({
      day: dateToday.day + i,
      month: monthNext.pre.month,
      year: monthNext.pre.year,
    })),
  );

  let countDaysToRenderNext = $derived(
    Math.min(countDaysToRender - daysToRenderCur.length, monthNext.cur.days),
  );
  let daysToRenderNext = $derived(
    countDaysToRenderNext > 0
      ? Array.from({ length: countDaysToRenderNext }, (_, i) => ({
          day: i + 1,
          month: monthNext.cur.month,
          year: monthNext.cur.year,
        }))
      : [],
  );
  let daysToRender = $derived([...daysToRenderCur, ...daysToRenderNext]);
</script>

<div
  {@attach detectHoverOnce("target-to-hover", (el) => el.classList.add("target-hovered"))}
  class={[className, "grid bg-[#2d3238]"]}
  style:grid-template-columns={`repeat(${weekLength}, 1fr)`}
  style:gap={`${gapWidth}px`}
  style:padding-top={`${gapWidth}px`}
>
  {#if daysPrecede > 0}
    <div
      class="relative grid grid-cols-subgrid"
      style:grid-column={`1 / span ${daysPrecede}`}
      style:gap={`${gapWidth}px`}
    ></div>
  {/if}

  {#each daysToRender as { day, month, year }, i}
    {@const isLastCell = i === daysToRender.length - 1}
    {@const isToday = i === 0}
    {@const chosen =
      !isLastCell &&
      dateChosen &&
      (year - dateChosen.year || month - dateChosen.month || day - dateChosen.day) === 0}
    <button
      class={[
        "target-to-hover flex cursor-default items-center justify-center rounded-md text-white select-none hover:bg-[#6a97f8]",
        chosen && "border-2 border-[#6a97f8] hover:border-white",
        chosen && "not-in-[.target-hovered]:border-white not-in-[.target-hovered]:bg-[#6a97f8]",
        isToday && "pointer-events-none opacity-50",
      ]}
      style:min-width={`${cellSize}px`}
      style:width={`${cellSize}px`}
      style:height={`${cellSize}px`}
      onclick={() => {
        onChoose?.(new CalendarDate(year, month, day), isLastCell);
      }}
    >
      {#if isToday}
        <span class="icon-[material-symbols--star-rounded] size-5"></span>
      {:else if isLastCell}
        <span class="icon-[ion--chevron-forward] size-4"></span>
      {:else}
        <span class="text-base font-semibold">{day}</span>
      {/if}
    </button>
  {/each}
</div>
