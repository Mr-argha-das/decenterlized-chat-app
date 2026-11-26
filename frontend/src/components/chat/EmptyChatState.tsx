"use client";

import React from "react";
import { Lock } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";

export function EmptyChatState() {
  const appName = process.env.NEXT_PUBLIC_APP_NAME || "RelayChat";

  return (
    <div
      data-testid="empty-chat-state"
      style={{
        backgroundColor: "var(--rc-header-bg)",
        borderColor: "var(--rc-accent)",
      }}
      className="w-full h-full flex flex-col items-center justify-center px-8 text-center border-b-[6px] select-none"
    >
      <div className="max-w-md flex flex-col items-center">
        <div className="mb-6 p-5 rounded-3xl bg-[#00a884]/10 shadow-inner">
          <BrandLogo className="w-20 h-20" />
        </div>

        <h1
          style={{ color: "var(--rc-text-primary)" }}
          className="text-3xl font-light tracking-tight"
        >
          {appName} Web
        </h1>

        <p
          style={{ color: "var(--rc-text-secondary)" }}
          className="mt-3 text-sm leading-relaxed"
        >
          Send and receive federated messages across independent servers without keeping
          your phone online. Select any conversation on the left to inspect text, image,
          document, voice, and live-location bubbles.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-xs">
          <span
            style={{
              backgroundColor: "var(--rc-sidebar-bg)",
              color: "var(--rc-text-secondary)",
              borderColor: "var(--rc-border)",
            }}
            className="px-3 py-1.5 rounded-full border"
          >
            Press <kbd className="font-mono font-semibold">Enter</kbd> to send
          </span>
          <span
            style={{
              backgroundColor: "var(--rc-sidebar-bg)",
              color: "var(--rc-text-secondary)",
              borderColor: "var(--rc-border)",
            }}
            className="px-3 py-1.5 rounded-full border"
          >
            Press <kbd className="font-mono font-semibold">Esc</kbd> to close chat
          </span>
          <span
            style={{
              backgroundColor: "var(--rc-sidebar-bg)",
              color: "var(--rc-text-secondary)",
              borderColor: "var(--rc-border)",
            }}
            className="px-3 py-1.5 rounded-full border"
          >
            Press <kbd className="font-mono font-semibold">Ctrl+K</kbd> to search
          </span>
        </div>

        <div
          style={{ color: "var(--rc-text-muted)" }}
          className="mt-14 flex items-center gap-1.5 text-xs"
        >
          <Lock className="w-3.5 h-3.5" />
          <span>Your personal messages are end-to-end encrypted</span>
        </div>
      </div>
    </div>
  );
}
