"use client";

import React from "react";
import { FileText, Film, Image as ImageIcon, Loader2, Mic, Radio, X } from "lucide-react";
import { ActiveUploadTask } from "@/mocks";
import { ActiveLiveShareInfo } from "@/store/useChatStore";

export interface UploadProgressTrayProps {
  uploads: ActiveUploadTask[];
  onCancelUpload: (uploadId: string) => void;
}

export function UploadProgressTray({
  uploads,
  onCancelUpload,
}: UploadProgressTrayProps) {
  if (uploads.length === 0) return null;

  return (
    <div
      style={{
        backgroundColor: "var(--rc-header-bg)",
        borderColor: "var(--rc-border)",
      }}
      data-testid="upload-progress-tray"
      className="px-4 py-2.5 border-t space-y-2 shrink-0"
    >
      {uploads.map((task) => {
        const statusLabel =
          task.status === "encrypting"
            ? "Encrypting 1 MB chunks (AES-256-GCM)..."
            : task.status === "finalizing"
              ? "Verifying ciphertext SHA-256..."
              : `Uploading chunk ${Math.min(task.uploadedChunks + 1, task.totalChunks)}/${
                  task.totalChunks
                } (${task.progressPercent}%)`;

        return (
          <div
            key={task.uploadId}
            style={{
              backgroundColor: "var(--rc-surface-elevated)",
              borderColor: "var(--rc-border)",
            }}
            className="rounded-xl border px-3 py-2 flex items-center gap-3"
          >
            <div className="w-8 h-8 rounded-lg bg-[#00a884]/15 text-[#00a884] flex items-center justify-center shrink-0">
              {task.category === "image" ? (
                <ImageIcon className="w-4 h-4" />
              ) : task.category === "video" ? (
                <Film className="w-4 h-4" />
              ) : task.category === "voice" ? (
                <Mic className="w-4 h-4" />
              ) : (
                <FileText className="w-4 h-4" />
              )}
            </div>

            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold truncate">{task.fileName}</span>
                <span
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-[11px] shrink-0 flex items-center gap-1"
                >
                  <Loader2 className="w-3 h-3 animate-spin text-[#00a884]" />
                  {statusLabel}
                </span>
              </div>

              <div className="h-1.5 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                <div
                  style={{ width: `${Math.max(4, task.progressPercent)}%` }}
                  className="h-full bg-[#00a884] transition-all duration-150 rounded-full"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => onCancelUpload(task.uploadId)}
              data-testid={`cancel-upload-${task.uploadId}`}
              className="p-1.5 rounded-full text-red-500 hover:bg-red-500/10 transition shrink-0"
              title="Cancel upload"
              aria-label="Cancel upload"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ActiveLiveLocationBanner({
  liveShares,
  onStopShare,
}: {
  liveShares: ActiveLiveShareInfo[];
  onStopShare: (messageId: string) => void;
}) {
  if (liveShares.length === 0) return null;

  return (
    <div
      data-testid="active-live-location-banner"
      className="px-4 py-2 bg-[#00a884]/15 border-b border-[#00a884]/30 flex items-center justify-between gap-2 text-xs shrink-0"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Radio className="w-4 h-4 text-[#00a884] animate-pulse shrink-0" />
        <span className="truncate font-medium">
          Sharing live location •{" "}
          <span style={{ color: "var(--rc-text-secondary)" }}>
            until {new Date(liveShares[0].expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => onStopShare(liveShares[0].messageId)}
        data-testid="banner-stop-live-location"
        className="px-2.5 py-1 rounded-lg bg-red-500 hover:bg-red-600 text-white font-semibold shrink-0 transition"
      >
        Stop sharing
      </button>
    </div>
  );
}
