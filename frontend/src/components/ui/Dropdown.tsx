"use client";

import React, { useEffect, useRef, useState } from "react";

export interface DropdownItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  dividerBefore?: boolean;
  onClick: () => void;
}

export interface DropdownProps {
  trigger: React.ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
  widthClass?: string;
  ariaLabel?: string;
}

export function Dropdown({
  trigger,
  items,
  align = "right",
  widthClass = "w-56",
  ariaLabel = "Menu",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-expanded={open}
        className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition focus:outline-none"
      >
        {trigger}
      </button>

      {open && (
        <div
          style={{
            backgroundColor: "var(--rc-surface-elevated)",
            borderColor: "var(--rc-border)",
            color: "var(--rc-text-primary)",
          }}
          className={`absolute top-11 ${
            align === "right" ? "right-0" : "left-0"
          } ${widthClass} rounded-xl border shadow-xl py-1.5 z-40 rc-animate-pop`}
          role="menu"
        >
          {items.map((item) => (
            <React.Fragment key={item.id}>
              {item.dividerBefore && (
                <div
                  style={{ borderColor: "var(--rc-border)" }}
                  className="my-1 border-t"
                />
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className={`w-full px-4 py-2.5 text-left text-sm flex items-center gap-3 transition ${
                  item.danger
                    ? "text-red-500 hover:bg-red-500/10"
                    : "hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                {item.icon && <span className="shrink-0 opacity-85">{item.icon}</span>}
                <span className="truncate">{item.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
