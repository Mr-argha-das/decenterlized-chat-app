"use client";

import React, { useEffect, useState } from "react";
import { FileText, Film, Lock, Music, SendHorizontal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { formatHumanBytes } from "@/lib/crypto/mediaEncryption";

export interface MediaStagingModalProps {
  file: File | null;
  onClose: () => void;
  onConfirmSend: (file: File, caption: string) => Promise<void>;
}

export function MediaStagingModal({
  file,
  onClose,
  onConfirmSend,
}: MediaStagingModalProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      setCaption("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (!file) return null;

  const mime = (file.type || "").toLowerCase();
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  const isAudio = mime.startsWith("audio/");
  const ext = file.name.includes(".")
    ? (file.name.split(".").pop() || "FILE").toUpperCase()
    : "FILE";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    const targetFile = file;
    const targetCaption = caption;
    onClose();
    try {
      await onConfirmSend(targetFile, targetCaption);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={!!file}
      onClose={onClose}
      title="Encrypt & Send Attachment"
      subtitle={`${file.name} • ${formatHumanBytes(file.size)}`}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div
          style={{
            backgroundColor: "var(--rc-header-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="rounded-2xl border overflow-hidden flex items-center justify-center min-h-[180px] max-h-[320px] p-3"
        >
          {isImage && previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={file.name}
              className="max-h-[290px] w-auto rounded-xl object-contain"
            />
          ) : isVideo && previewUrl ? (
            <video
              src={previewUrl}
              controls
              playsInline
              className="max-h-[290px] w-full rounded-xl"
            />
          ) : isAudio && previewUrl ? (
            <div className="w-full py-6 px-3 flex flex-col items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-orange-500/15 text-orange-500 flex items-center justify-center">
                <Music className="w-6 h-6" />
              </div>
              <audio src={previewUrl} controls className="w-full" />
            </div>
          ) : (
            <div className="flex flex-col items-center text-center py-6 gap-2">
              <div className="w-14 h-16 rounded-2xl bg-[#00a884]/15 text-[#00a884] flex flex-col items-center justify-center">
                {isVideo ? (
                  <Film className="w-6 h-6" />
                ) : (
                  <FileText className="w-6 h-6" />
                )}
                <span className="text-[10px] font-bold mt-0.5">{ext}</span>
              </div>
              <div className="text-sm font-semibold break-all px-4">{file.name}</div>
              <div
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-xs"
              >
                {formatHumanBytes(file.size)} • 1 MB AES-256-GCM chunks
              </div>
            </div>
          )}
        </div>

        <input
          type="text"
          autoFocus
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Add an encrypted caption (optional)..."
          data-testid="media-staging-caption"
          style={{
            backgroundColor: "var(--rc-header-bg)",
            color: "var(--rc-text-primary)",
            borderColor: "var(--rc-border)",
          }}
          className="w-full rounded-xl px-3.5 py-2.5 text-sm border focus:outline-none focus:border-[#00a884]"
        />

        <div className="flex items-center justify-between gap-3">
          <span
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[11px] flex items-center gap-1"
          >
            <Lock className="w-3.5 h-3.5 text-[#00a884]" />
            <span>Random AES-GCM key per file</span>
          </span>

          <button
            type="submit"
            disabled={sending}
            data-testid="confirm-send-staged-media"
            className="px-5 py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] text-white text-xs font-semibold inline-flex items-center gap-2 transition"
          >
            <SendHorizontal className="w-4 h-4" />
            <span>Encrypt &amp; Send</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}
