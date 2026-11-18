import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import "./Select.css";

type Props = SelectHTMLAttributes<HTMLSelectElement>;

type SelectOption = {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
};

const EDGE = 8; // popup never crosses a window edge by less than this
const GAP = 4; // gap between the trigger and the popup
const MENU_HEIGHT_LIMIT = 280; // must match the .st-select-menu max-height

// Flatten an <option>'s children into plain text for typeahead matching.
// Options compose their labels from several nodes ("★ " + name + " · 3
// emotions"), so strings, numbers and nested elements all count.
function nodeToText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement(node)) {
    return nodeToText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

// The kit keeps the native <select> contract — options declared as <option>
// children, onChange receiving { target: { value } } — so existing plugin
// call sites, and their already-built bundles, keep working unchanged.
function extractOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || child.type !== "option") return;
    const props = child.props as {
      value?: string | number;
      children?: ReactNode;
      disabled?: boolean;
    };
    const value = props.value === undefined ? "" : String(props.value);
    options.push({
      value,
      label: props.children,
      text: nodeToText(props.children),
      disabled: props.disabled === true,
    });
  });
  return options;
}

function firstEnabled(options: SelectOption[]): number {
  const i = options.findIndex((o) => !o.disabled);
  return i >= 0 ? i : 0;
}

function lastEnabled(options: SelectOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i].disabled) return i;
  }
  return options.length - 1;
}

export function Select({
  children,
  value,
  name,
  disabled,
  style,
  className,
  onChange,
  "aria-label": ariaLabel,
}: Props) {
  const options = useMemo(() => extractOptions(children), [children]);
  const current = value === undefined || value === null ? "" : String(value);
  const selected = options.find((o) => o.value === current);

  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const triggerRectRef = useRef<DOMRect | null>(null);
  const typeaheadRef = useRef({ buffer: "", at: 0 });

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [flipUp, setFlipUp] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, minWidth: 0 });

  // Latest highlight for closures that must not read a stale render value.
  const highlightedRef = useRef(-1);
  highlightedRef.current = highlighted;

  const close = useCallback(() => setOpen(false), []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      close();
      // Native selects only fire change when the value actually changes.
      if (option.value === current) return;
      onChange?.({
        target: { value: option.value, name },
      } as unknown as ChangeEvent<HTMLSelectElement>);
    },
    [options, current, name, onChange, close],
  );

  const openMenu = useCallback(() => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    triggerRectRef.current = rect;
    const selectedIndex = options.findIndex((o) => o.value === current);
    setHighlighted(selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
    setFlipUp(false);
    setPos({
      top: rect.bottom + GAP,
      left: rect.left,
      minWidth: Math.round(rect.width),
    });
    setOpen(true);
  }, [disabled, options, current]);

  // After the popup mounts, measure it and flip/clamp so it stays inside the
  // window (which can be as small as 240×375).
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const rect = triggerRectRef.current;
    if (!menu || !rect) return;
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    const roomBelow = window.innerHeight - rect.bottom - EDGE;
    const flip = roomBelow < Math.min(height, MENU_HEIGHT_LIMIT) && rect.top - EDGE > height;
    const top = flip ? rect.top - height - GAP : rect.bottom + GAP;
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE));
    setFlipUp(flip);
    setPos((p) => (p.top === top && p.left === left ? p : { ...p, top, left }));
  }, [open]);

  // Keep the highlighted option visible while arrowing through long lists.
  useLayoutEffect(() => {
    if (!open || highlighted < 0 || options.length === 0) return;
    const menu = menuRef.current;
    const el = menu?.children[highlighted] as HTMLElement | undefined;
    if (!menu || !el) return;
    const viewTop = menu.scrollTop;
    const viewBottom = viewTop + menu.clientHeight;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < viewTop) menu.scrollTop = top;
    else if (bottom > viewBottom) menu.scrollTop = bottom - menu.clientHeight;
  }, [open, highlighted, options.length]);

  // Popup dismiss listeners, mirroring ContextMenu: outside mousedown,
  // Escape, window blur/resize, and scroll (native selects close on scroll).
  // The capture-phase scroll listener skips events from the popup's own
  // internal scrolling.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Node) {
        if (menuRef.current?.contains(target)) return;
        if (triggerRef.current?.contains(target)) return;
      }
      close();
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDismiss = () => close();
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        openMenu();
      }
      return;
    }
    const count = options.length;
    // Step to the next/previous non-disabled option, wrapping around.
    const step = (start: number, delta: number) => {
      if (count === 0) return;
      let i = ((start % count) + count) % count;
      for (let n = 0; n < count; n++) {
        i = (((i + delta) % count) + count) % count;
        if (!options[i].disabled) break;
      }
      setHighlighted(i);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(highlighted, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(highlighted, -1);
        break;
      case "Home":
        e.preventDefault();
        setHighlighted(firstEnabled(options));
        break;
      case "End":
        e.preventDefault();
        setHighlighted(lastEnabled(options));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        if (highlighted >= 0) commit(highlighted);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close();
        break;
      default:
        typeahead(e);
        break;
    }
  };

  // Typeahead: accumulate quick keystrokes and jump to the first option whose
  // text starts with the buffer (the calendar year list has 101 entries).
  // A single character searches after the current highlight; once the buffer
  // grows, restart from the top so "2" then "0" lands on 2000, not 2027.
  const typeahead = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1 || options.length === 0) return;
    const now = Date.now();
    const state = typeaheadRef.current;
    state.buffer = now - state.at > 500 ? e.key : state.buffer + e.key;
    state.at = now;
    const needle = state.buffer.toLowerCase();
    const start = needle.length > 1 ? 0 : highlightedRef.current + 1;
    for (let n = 0; n < options.length; n++) {
      const i = (start + n) % options.length;
      if (!options[i].disabled && options[i].text.toLowerCase().startsWith(needle)) {
        setHighlighted(i);
        return;
      }
    }
  };

  return (
    <span className={className ? `st-select ${className}` : "st-select"} style={style}>
      <button
        type="button"
        ref={triggerRef}
        role="combobox"
        className="st-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && highlighted >= 0 ? `${listboxId}-opt-${highlighted}` : undefined
        }
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="st-select-value">{selected ? selected.label : ""}</span>
        <svg
          className="st-select-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className={`st-select-menu${flipUp ? " st-select-menu-up" : ""}`}
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
          >
            {options.length === 0 ? (
              <li className="st-select-empty">No options</li>
            ) : (
              options.map((option, i) => {
                const isSelected = option.value === current;
                const state = [
                  "st-select-option",
                  i === highlighted && "st-select-option-highlighted",
                  isSelected && "st-select-option-selected",
                  option.disabled && "st-select-option-disabled",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <li
                    key={`${option.value}-${i}`}
                    id={`${listboxId}-opt-${i}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={state}
                    onMouseEnter={() => setHighlighted(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commit(i)}
                  >
                    <span className="st-select-option-label">{option.label}</span>
                    {isSelected && (
                      <svg
                        className="st-select-check"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m5 12 5 5 9-11" />
                      </svg>
                    )}
                  </li>
                );
              })
            )}
          </ul>,
          document.body,
        )}
    </span>
  );
}
