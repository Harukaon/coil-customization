import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { TextField } from "./form";

export interface SelectOption {
  value: string;
  label: string;
  detail?: string;
  keywords?: string;
  disabled?: boolean;
}

export function nextEnabledOptionIndex(options: SelectOption[], current: number, direction: 1 | -1): number {
  if (!options.length) return -1;
  for (let step = 1; step <= options.length; step += 1) {
    const index = (current + direction * step + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  ariaLabel,
  searchable = false,
  disabled = false,
  className = "",
}: {
  value?: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find((option) => option.value === value);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) => `${option.label} ${option.detail ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(normalized));
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const selectedIndex = visible.findIndex((option) => option.value === value && !option.disabled);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : nextEnabledOptionIndex(visible, -1, 1));
  }, [open, value, visible]);

  useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, open]);

  const choose = (option: SelectOption | undefined): void => {
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const move = (direction: 1 | -1): void => {
    setHighlightedIndex((current) => nextEnabledOptionIndex(visible, current, direction));
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(nextEnabledOptionIndex(visible, event.key === "Home" ? -1 : 0, event.key === "Home" ? 1 : -1));
      return;
    }
    const editingSearch = (event.target as HTMLElement).tagName === "INPUT";
    if (event.key === "Enter" || (event.key === " " && !editingSearch)) {
      event.preventDefault();
      choose(visible[highlightedIndex]);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className={`coil-select ${className}`.trim()}
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          title={selected?.label ?? placeholder}
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setOpen(true);
            const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
            setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : nextEnabledOptionIndex(options, -1, 1));
          }}
        >
          <span className={selected ? "" : "placeholder"}>{selected?.label ?? placeholder}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="coil-select-popover"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onKeyDown={handleMenuKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            queueMicrotask(() => (searchable ? searchRef.current : listRef.current)?.focus());
          }}
        >
          {searchable ? (
            <div className="coil-select-search">
              <Search size={14} aria-hidden="true" />
              <TextField look="plain" className="coil-select-search-input" ref={searchRef} value={query} aria-label={`搜索${ariaLabel}`} placeholder="搜索…" onChange={(event) => setQuery(event.target.value)} />
            </div>
          ) : null}
          <div
            ref={listRef}
            id={listId}
            className="coil-select-options"
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={highlightedIndex >= 0 ? `${listId}-option-${highlightedIndex}` : undefined}
            tabIndex={searchable ? -1 : 0}
          >
            {visible.map((option, index) => (
              <button
                ref={(node) => { optionRefs.current[index] = node; }}
                id={`${listId}-option-${index}`}
                className={`${option.value === value ? "active" : ""} ${index === highlightedIndex ? "highlighted" : ""}`.trim()}
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                tabIndex={-1}
                key={option.value}
                onMouseEnter={() => { if (!option.disabled) setHighlightedIndex(index); }}
                onClick={() => choose(option)}
              >
                <span><strong>{option.label}</strong>{option.detail ? <small>{option.detail}</small> : null}</span>
                {option.value === value ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
            {!visible.length ? <p>没有匹配项</p> : null}
          </div>
          <Popover.Arrow className="coil-select-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
