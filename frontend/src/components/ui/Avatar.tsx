"use client";

import React from "react";
import { Users } from "lucide-react";

export interface AvatarProps {
  name: string;
  src?: string | null;
  color?: string;
  size?: "sm" | "md" | "lg" | "xl";
  isGroup?: boolean;
  isOnline?: boolean;
  showOnlineDot?: boolean;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps["size"]>, string> = {
  sm: "w-8 h-8 text-xs",
  md: "w-10 h-10 text-sm",
  lg: "w-12 h-12 text-base",
  xl: "w-20 h-20 text-2xl",
};

export function Avatar({
  name,
  src,
  color = "#00a884",
  size = "md",
  isGroup = false,
  isOnline = false,
  showOnlineDot = false,
  className = "",
}: AvatarProps) {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={`relative inline-flex shrink-0 select-none ${className}`}>
      <div
        style={{ backgroundColor: src ? undefined : color }}
        className={`${SIZE_CLASSES[size]} rounded-full overflow-hidden flex items-center justify-center font-semibold text-white shadow-sm`}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={name} className="w-full h-full object-cover" />
        ) : isGroup ? (
          <Users className={size === "sm" ? "w-4 h-4" : "w-5 h-5"} />
        ) : (
          <span>{initials || "?"}</span>
        )}
      </div>

      {showOnlineDot && !isGroup && isOnline && (
        <span
          style={{ borderColor: "var(--rc-sidebar-bg)" }}
          className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2"
          title="Online"
        />
      )}
    </div>
  );
}
