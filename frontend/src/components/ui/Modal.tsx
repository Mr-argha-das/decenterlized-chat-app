"use client";

import React, { useEffect } from "react";
import { X } from "lucide-react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  maxWidthClass?: string;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  maxWidthClass = "max-w-md",
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={{
          backgroundColor: "var(--rc-surface-elevated)",
          borderColor: "var(--rc-border)",
          color: "var(--rc-text-primary)",
        }}
        className={`w-full ${maxWidthClass} rounded-2xl border shadow-2xl overflow-hidden rc-animate-pop`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || subtitle) && (
          <div
            style={{ borderColor: "var(--rc-border)" }}
            className="px-5 py-4 border-b flex items-center justify-between gap-3"
          >
            <div>
              {title && <h2 className="text-base font-semibold leading-snug">{title}</h2>}
              {subtitle && (
                <p
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs mt-0.5"
                >
                  {subtitle}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{ color: "var(--rc-text-secondary)" }}
              className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
              aria-label="Close modal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
