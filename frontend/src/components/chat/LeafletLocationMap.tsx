"use client";

import React, { useEffect, useRef } from "react";

export interface LeafletLocationMapProps {
  latitude: number;
  longitude: number;
  zoom?: number;
  isLive?: boolean;
  interactive?: boolean;
  heightClass?: string;
  onPickCoordinate?: (lat: number, lng: number) => void;
}

export function LeafletLocationMap({
  latitude,
  longitude,
  zoom = 15,
  isLive = false,
  interactive = false,
  heightClass = "h-36",
  onPickCoordinate,
}: LeafletLocationMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const pickCbRef = useRef(onPickCoordinate);
  pickCbRef.current = onPickCoordinate;

  useEffect(() => {
    let cancelled = false;

    const mountMap = async () => {
      if (!containerRef.current || mapRef.current) return;
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current) return;

      const map = L.map(containerRef.current, {
        center: [latitude, longitude],
        zoom,
        zoomControl: interactive,
        dragging: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: false,
        keyboard: false,
        attributionControl: interactive,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }).addTo(map);

      const pinColor = isLive ? "#00a884" : "#ef4444";
      const icon = L.divIcon({
        className: "",
        iconSize: [28, 28],
        iconAnchor: [14, 26],
        html: `<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background:${pinColor};color:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.35);border:2.5px solid #fff;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>
          </svg>
        </div>`,
      });

      const marker = L.marker([latitude, longitude], { icon }).addTo(map);
      mapRef.current = map;
      markerRef.current = marker;

      if (interactive) {
        map.on("click", (ev: { latlng: { lat: number; lng: number } }) => {
          pickCbRef.current?.(
            Number(ev.latlng.lat.toFixed(6)),
            Number(ev.latlng.lng.toFixed(6))
          );
        });
      }

      setTimeout(() => {
        try {
          map.invalidateSize();
        } catch {
          // ignore
        }
      }, 80);
    };

    mountMap();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
  }, [interactive, isLive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Smoothly update marker & center when live coordinates change
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    markerRef.current.setLatLng([latitude, longitude]);
    mapRef.current.panTo([latitude, longitude], { animate: true });
  }, [latitude, longitude]);

  return (
    <div
      ref={containerRef}
      data-testid="leaflet-osm-map"
      className={`w-full ${heightClass} bg-[#eae6de] dark:bg-[#192630] overflow-hidden`}
    />
  );
}
