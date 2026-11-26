"use client";

import React, { useState } from "react";
import { LocateFixed, MapPin, Navigation, Radio } from "lucide-react";
import { LeafletLocationMap } from "@/components/chat/LeafletLocationMap";
import { Modal } from "@/components/ui/Modal";

export interface LocationShareModalProps {
  open: boolean;
  onClose: () => void;
  onSendStatic: (loc: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    label: string;
    address: string;
  }) => Promise<void>;
  onStartLive: (loc: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    label: string;
    address: string;
    durationMinutes: 15 | 60 | 480;
  }) => Promise<void>;
}

const DURATION_OPTIONS: { value: 15 | 60 | 480; label: string }[] = [
  { value: 15, label: "15 minutes" },
  { value: 60, label: "1 hour" },
  { value: 480, label: "8 hours" },
];

export function LocationShareModal({
  open,
  onClose,
  onSendStatic,
  onStartLive,
}: LocationShareModalProps) {
  const [mode, setMode] = useState<"static" | "live">("static");
  const [durationMinutes, setDurationMinutes] = useState<15 | 60 | 480>(15);
  const [latitude, setLatitude] = useState<number>(26.9124);
  const [longitude, setLongitude] = useState<number>(75.7873);
  const [accuracy, setAccuracy] = useState<number | undefined>(undefined);
  const [label, setLabel] = useState<string>("Current Location");
  const [address, setAddress] = useState<string>("Jaipur, Rajasthan, India");
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [gpsNotice, setGpsNotice] = useState<string | null>(null);

  const handleUseBrowserGps = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsNotice("Browser geolocation unavailable — click on the map to pin exact coordinates.");
      return;
    }
    setLocating(true);
    setGpsNotice(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        setLatitude(lat);
        setLongitude(lng);
        setAccuracy(Math.round(pos.coords.accuracy));
        setAddress(`${lat.toFixed(4)}°, ${lng.toFixed(4)}° (±${Math.round(pos.coords.accuracy)}m)`);
        setLocating(false);
      },
      () => {
        setGpsNotice(
          "GPS permission denied or unavailable — click anywhere on the map to choose coordinates."
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 6000 }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === "static") {
        await onSendStatic({
          latitude,
          longitude,
          accuracy,
          label: label.trim() || "Current Location",
          address: address.trim() || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
        });
      } else {
        await onStartLive({
          latitude,
          longitude,
          accuracy,
          label: label.trim() || "Live Location",
          address: address.trim() || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
          durationMinutes,
        });
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share Encrypted Location"
      subtitle="Coordinates are encrypted end-to-end with AES-256-GCM"
    >
      <form onSubmit={handleSubmit} className="space-y-3.5">
        {/* Mode Selector: Static vs Live */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="grid grid-cols-2 p-1 rounded-xl text-xs font-semibold"
        >
          <button
            type="button"
            onClick={() => setMode("static")}
            data-testid="location-mode-static"
            style={{
              backgroundColor:
                mode === "static" ? "var(--rc-surface-elevated)" : undefined,
            }}
            className="py-2 rounded-lg flex items-center justify-center gap-1.5 transition"
          >
            <MapPin className="w-3.5 h-3.5 text-red-500" /> Send Current Location
          </button>
          <button
            type="button"
            onClick={() => setMode("live")}
            data-testid="location-mode-live"
            style={{
              backgroundColor:
                mode === "live" ? "var(--rc-surface-elevated)" : undefined,
            }}
            className="py-2 rounded-lg flex items-center justify-center gap-1.5 transition"
          >
            <Radio className="w-3.5 h-3.5 text-[#00a884]" /> Share Live Location
          </button>
        </div>

        {/* Interactive Leaflet OpenStreetMap Picker */}
        <div className="rounded-xl overflow-hidden border border-[var(--rc-border)] relative">
          {open && (
            <LeafletLocationMap
              latitude={latitude}
              longitude={longitude}
              isLive={mode === "live"}
              interactive
              heightClass="h-44"
              onPickCoordinate={(lat, lng) => {
                setLatitude(lat);
                setLongitude(lng);
                setAddress(`${lat.toFixed(5)}°, ${lng.toFixed(5)}°`);
              }}
            />
          )}
          <button
            type="button"
            onClick={handleUseBrowserGps}
            disabled={locating}
            className="absolute bottom-2.5 right-2.5 px-2.5 py-1.5 rounded-lg bg-[#111b21]/85 text-white text-[11px] font-semibold flex items-center gap-1.5 shadow hover:bg-[#111b21]"
          >
            <LocateFixed className="w-3.5 h-3.5 text-[#00a884]" />
            <span>{locating ? "Locating..." : "Use GPS"}</span>
          </button>
        </div>

        {gpsNotice && (
          <p className="text-[11px] text-amber-500">{gpsNotice}</p>
        )}

        {/* Live Location Duration Selector (15 min / 1 hr / 8 hr) */}
        {mode === "live" && (
          <div className="space-y-1.5">
            <label
              style={{ color: "var(--rc-text-secondary)" }}
              className="block text-[11px] font-semibold uppercase tracking-wider"
            >
              Share Live Updates For
            </label>
            <div className="grid grid-cols-3 gap-2">
              {DURATION_OPTIONS.map((opt) => {
                const selected = durationMinutes === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDurationMinutes(opt.value)}
                    data-testid={`live-duration-${opt.value}`}
                    style={{
                      borderColor: selected
                        ? "var(--rc-accent)"
                        : "var(--rc-border)",
                      backgroundColor: selected
                        ? "var(--rc-accent-soft)"
                        : "var(--rc-header-bg)",
                      color: selected
                        ? "var(--rc-accent-strong)"
                        : "var(--rc-text-primary)",
                    }}
                    className="py-2 rounded-xl border text-xs font-semibold transition"
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label
              style={{ color: "var(--rc-text-secondary)" }}
              className="block text-[10px] font-semibold uppercase mb-1"
            >
              Latitude
            </label>
            <input
              type="number"
              step="any"
              value={latitude}
              onChange={(e) => setLatitude(parseFloat(e.target.value) || 0)}
              style={{
                backgroundColor: "var(--rc-header-bg)",
                color: "var(--rc-text-primary)",
                borderColor: "var(--rc-border)",
              }}
              className="w-full rounded-lg px-2.5 py-1.5 text-xs font-mono border focus:outline-none"
            />
          </div>
          <div>
            <label
              style={{ color: "var(--rc-text-secondary)" }}
              className="block text-[10px] font-semibold uppercase mb-1"
            >
              Longitude
            </label>
            <input
              type="number"
              step="any"
              value={longitude}
              onChange={(e) => setLongitude(parseFloat(e.target.value) || 0)}
              style={{
                backgroundColor: "var(--rc-header-bg)",
                color: "var(--rc-text-primary)",
                borderColor: "var(--rc-border)",
              }}
              className="w-full rounded-lg px-2.5 py-1.5 text-xs font-mono border focus:outline-none"
            />
          </div>
        </div>

        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Place label (e.g. Home, Office, Meeting Spot)"
          style={{
            backgroundColor: "var(--rc-header-bg)",
            color: "var(--rc-text-primary)",
            borderColor: "var(--rc-border)",
          }}
          className="w-full rounded-xl px-3 py-2 text-xs border focus:outline-none"
        />

        <button
          type="submit"
          disabled={submitting}
          data-testid="confirm-send-location"
          className="w-full py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
        >
          <Navigation className="w-4 h-4" />
          <span>
            {submitting
              ? "Encrypting..."
              : mode === "live"
                ? `Start Live Location (${
                    DURATION_OPTIONS.find((d) => d.value === durationMinutes)?.label
                  })`
                : "Send Encrypted Location"}
          </span>
        </button>
      </form>
    </Modal>
  );
}
