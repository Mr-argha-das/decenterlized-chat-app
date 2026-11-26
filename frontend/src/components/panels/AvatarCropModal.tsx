"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, ZoomIn } from "lucide-react";
import { Modal } from "@/components/ui/Modal";

export interface AvatarCropModalProps {
  file: File | null;
  onClose: () => void;
  onConfirmCrop: (croppedBlob: Blob) => Promise<void>;
}

const VIEWPORT_SIZE = 260;
const OUTPUT_SIZE = 256;

export function AvatarCropModal({
  file,
  onClose,
  onConfirmCrop,
}: AvatarCropModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [imgReady, setImgReady] = useState(false);
  const [zoom, setZoom] = useState(1.1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file) {
      imgRef.current = null;
      setImgReady(false);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setZoom(1.05);
      setOffset({ x: 0, y: 0 });
      setImgReady(true);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imgReady) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE);
    ctx.fillStyle = "#0b141a";
    ctx.fillRect(0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE);

    const baseScale = Math.max(
      VIEWPORT_SIZE / img.naturalWidth,
      VIEWPORT_SIZE / img.naturalHeight
    );
    const scale = baseScale * zoom;
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    const dx = (VIEWPORT_SIZE - drawW) / 2 + offset.x;
    const dy = (VIEWPORT_SIZE - drawH) / 2 + offset.y;

    ctx.drawImage(img, dx, dy, drawW, drawH);

    // Subtle circular framing guide overlay
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
    ctx.beginPath();
    ctx.rect(0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE);
    ctx.arc(
      VIEWPORT_SIZE / 2,
      VIEWPORT_SIZE / 2,
      VIEWPORT_SIZE / 2 - 10,
      0,
      Math.PI * 2,
      true
    );
    ctx.fill();

    ctx.strokeStyle = "#00a884";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(
      VIEWPORT_SIZE / 2,
      VIEWPORT_SIZE / 2,
      VIEWPORT_SIZE / 2 - 10,
      0,
      Math.PI * 2
    );
    ctx.stroke();
    ctx.restore();
  }, [imgReady, zoom, offset]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      ox: offset.x,
      oy: offset.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setOffset({
      x: dragStartRef.current.ox + dx,
      y: dragStartRef.current.oy + dy,
    });
  };

  const handlePointerUp = () => {
    setDragging(false);
  };

  const handleExportAndSave = async () => {
    const img = imgRef.current;
    if (!img) return;
    setSaving(true);
    try {
      const out = document.createElement("canvas");
      out.width = OUTPUT_SIZE;
      out.height = OUTPUT_SIZE;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable.");

      const ratio = OUTPUT_SIZE / VIEWPORT_SIZE;
      const baseScale = Math.max(
        VIEWPORT_SIZE / img.naturalWidth,
        VIEWPORT_SIZE / img.naturalHeight
      );
      const scale = baseScale * zoom * ratio;
      const drawW = img.naturalWidth * scale;
      const drawH = img.naturalHeight * scale;
      const dx = (OUTPUT_SIZE - drawW) / 2 + offset.x * ratio;
      const dy = (OUTPUT_SIZE - drawH) / 2 + offset.y * ratio;

      ctx.fillStyle = "#111b21";
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      ctx.drawImage(img, dx, dy, drawW, drawH);

      const blob = await new Promise<Blob>((resolve, reject) => {
        out.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to encode avatar."))),
          "image/jpeg",
          0.92
        );
      });
      await onConfirmCrop(blob);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!file}
      onClose={onClose}
      title="Resize & Crop Profile Photo"
      subtitle="Drag to reposition • Resized to 256×256 on your browser before upload"
    >
      <div className="flex flex-col items-center space-y-4">
        <canvas
          ref={canvasRef}
          width={VIEWPORT_SIZE}
          height={VIEWPORT_SIZE}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="rounded-2xl cursor-grab active:cursor-grabbing shadow-inner border border-[var(--rc-border)] touch-none"
        />

        <div className="w-full max-w-[260px] flex items-center gap-2.5">
          <ZoomIn className="w-4 h-4 text-[#00a884] shrink-0" />
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="flex-1 accent-[#00a884]"
            aria-label="Zoom avatar"
          />
          <span className="text-xs font-mono w-10 text-right">
            {zoom.toFixed(1)}x
          </span>
        </div>

        <div className="flex items-center gap-2.5 w-full pt-1">
          <button
            type="button"
            onClick={onClose}
            style={{
              backgroundColor: "var(--rc-header-bg)",
              color: "var(--rc-text-primary)",
            }}
            className="flex-1 py-2.5 rounded-xl text-xs font-semibold hover:opacity-90 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !imgReady}
            onClick={handleExportAndSave}
            data-testid="confirm-avatar-crop"
            className="flex-1 py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            <span>{saving ? "Uploading..." : "Save Photo"}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
