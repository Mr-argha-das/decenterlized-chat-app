"use client";

import React, { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Modal } from "@/components/ui/Modal";

export interface CameraCaptureModalProps {
  open: boolean;
  onClose: () => void;
  onCapturedFile: (file: File) => void;
}

export function CameraCaptureModal({
  open,
  onClose,
  onCapturedFile,
}: CameraCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      return;
    }

    let cancelled = false;
    setCamError(null);

    const start = async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setCamError("Camera API unavailable in this browser.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
      } catch {
        setCamError("Could not access camera. You can upload a photo instead.");
      }
    };

    start();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [open]);

  const handleCaptureFrame = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `camera-${Date.now()}.jpg`, {
          type: "image/jpeg",
        });
        onClose();
        onCapturedFile(file);
      },
      "image/jpeg",
      0.9
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Take Encrypted Photo">
      <div className="space-y-3">
        <div className="rounded-2xl overflow-hidden bg-black aspect-video flex items-center justify-center border border-[var(--rc-border)]">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        </div>
        {camError && <p className="text-xs text-amber-500">{camError}</p>}
        <button
          type="button"
          disabled={!!camError}
          onClick={handleCaptureFrame}
          className="w-full py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-2 transition"
        >
          <Camera className="w-4 h-4" />
          <span>Capture Photo</span>
        </button>
      </div>
    </Modal>
  );
}
