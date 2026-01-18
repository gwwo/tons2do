<script lang="ts">
  import { tick } from "svelte";
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";

  type Props = {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    class?: ClassValue;
    onChange?: (val: string) => void;
    onInput?: (val: string) => void;
    onBlur?: () => void;
    onFocus?: () => void;
  } & HTMLButtonAttributes;

  let {
    value = $bindable(""),
    placeholder = "Double-click to edit",
    disabled = false,
    class: className,
    onInput,
    onChange,
    onBlur,
    onFocus,
    ...restProps
  }: Props = $props();

  let editing = $state(false);
  let displayEl: HTMLElement | null = $state.raw(null);
  let inputEl: HTMLInputElement | null = $state.raw(null);
  let pendingCaret: number | null = null;
  let measuringCanvas: HTMLCanvasElement | null = null;
  let measuringContext: CanvasRenderingContext2D | null = null;
  let previousBodyCursor: string | null = null;

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

  const clampCaret = (position: number, length: number) => clamp(position, 0, length);

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    value = target.value;
    onInput?.(target.value);
  }

  function handleChange(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    onChange?.(target.value);
  }

  async function activateAt(position: number | null = null) {
    if (disabled) return;
    pendingCaret = position;
    editing = true;
    await tick();

    if (!inputEl) return;

    inputEl.focus();
    const caret =
      typeof pendingCaret === "number"
        ? clampCaret(pendingCaret, inputEl.value.length)
        : inputEl.value.length;
    inputEl.setSelectionRange(caret, caret);
    inputEl.scrollLeft = 0;
    pendingCaret = null;
  }

  function handleDisplayDblClick(event: MouseEvent) {
    activateAt(determineCaretFromClick(event));
  }

  function handleDisplayKeydown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === "Enter") {
      event.preventDefault();
      activateAt(value.length);
    }
  }

  function determineCaretFromClick(event: MouseEvent): number {
    if (!displayEl || !value) {
      return 0;
    }

    const rect = displayEl.getBoundingClientRect();
    const styles = getComputedStyle(displayEl);
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const innerWidth = Math.max(rect.width - paddingLeft - paddingRight, 0);
    const relativeX = clamp(event.clientX - rect.left - paddingLeft, 0, innerWidth);
    const ctx = getMeasurementContext(styles);

    if (!ctx) {
      return value.length;
    }

    const letterSpacing = parseLetterSpacing(styles);

    let total = 0;
    for (let i = 0; i < value.length; i++) {
      const charWidth = ctx.measureText(value[i] ?? "").width;
      const spacing = i < value.length - 1 ? letterSpacing : 0;
      const segmentWidth = charWidth + spacing;

      if (relativeX <= total + segmentWidth / 2) {
        return i;
      }
      total += segmentWidth;
    }

    return value.length;
  }

  function getMeasurementContext(styles: CSSStyleDeclaration) {
    if (!measuringCanvas) {
      measuringCanvas = document.createElement("canvas");
      measuringContext = measuringCanvas.getContext("2d");
    }

    if (!measuringContext) {
      return null;
    }

    measuringContext.font = buildFontString(styles);
    return measuringContext;
  }

  function buildFontString(styles: CSSStyleDeclaration) {
    const fontStyle = styles.fontStyle || "normal";
    const fontVariant = styles.fontVariant || "normal";
    const fontWeight = styles.fontWeight || "normal";
    const fontSize = styles.fontSize || "16px";
    const fontFamily = styles.fontFamily || "sans-serif";
    return `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  }

  function parseLetterSpacing(styles: CSSStyleDeclaration) {
    if (styles.letterSpacing === "normal") {
      return 0;
    }
    return parseFloat(styles.letterSpacing) || 0;
  }

  function handleBlur() {
    editing = false;
    restoreBodyCursor();
    onBlur?.();
  }

  function handleFocus() {
    applyTextCursorToBody();
    onFocus?.();
  }

  function applyTextCursorToBody() {
    if (typeof document === "undefined") return;
    if (previousBodyCursor === null) {
      previousBodyCursor = document.body.style.cursor || "";
    }
    document.body.style.cursor = "text";
  }

  function restoreBodyCursor() {
    if (typeof document === "undefined") return;
    if (previousBodyCursor !== null) {
      document.body.style.cursor = previousBodyCursor;
      previousBodyCursor = null;
    } else {
      document.body.style.cursor = "";
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      inputEl?.blur();
    }
  }

  export const focus = () => {
    activateAt();
  };
</script>

{#if !disabled && editing}
  <input
    bind:this={inputEl}
    class={[className, "cursor-text leading-normal outline-none placeholder:text-gray-400"]}
    type="text"
    {placeholder}
    {value}
    oninput={handleInput}
    onchange={handleChange}
    onfocus={handleFocus}
    onblur={handleBlur}
    onkeydown={handleKeyDown}
  />
{:else}
  <button
    bind:this={displayEl}
    class={[className, "leading-normal outline-none"]}
    ondblclick={handleDisplayDblClick}
    onkeydown={handleDisplayKeydown}
    tabindex={disabled ? undefined : 0}
    {disabled}
    {...restProps}
  >
    <div
      class={[
        "cursor-default overflow-hidden text-ellipsis whitespace-pre select-none",
        !value && "text-gray-400",
      ]}
    >
      {value || placeholder}
    </div>
  </button>
{/if}
