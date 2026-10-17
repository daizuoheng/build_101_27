"use client";

// Solo cliente: se carga con next/dynamic({ ssr: false }) desde quien lo usa.
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";

export type LatLon = { lon: number; lat: number };
export type MapMarker = LatLon & { id: string; label: string; tone?: "high" | "medium" | "low" | "unknown"; onClick?: () => void };

const icons = new Map<string, L.DivIcon>();
function pinIcon(tone?: string) {
  const key = tone ?? "accent";
  if (!icons.has(key)) {
    icons.set(
      key,
      L.divIcon({
        className: "",
        html: `<div class="ru-pin${tone ? ` ru-pin--${tone}` : ""}"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 22],
        popupAnchor: [0, -22],
      }),
    );
  }
  return icons.get(key)!;
}

function ClickToPick({ onPick }: { onPick: (p: LatLon) => void }) {
  useMapEvents({ click: (e) => onPick({ lon: e.latlng.lng, lat: e.latlng.lat }) });
  return null;
}

function Recenter({ center, zoom }: { center: LatLon; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lon], Math.max(map.getZoom(), zoom));
  }, [map, center.lat, center.lon, zoom]);
  return null;
}

export default function LeafletMap({
  center,
  zoom,
  pin,
  onPick,
  markers,
  height = 280,
  label,
}: {
  center: LatLon;
  zoom: number;
  pin?: LatLon | null;
  onPick?: (p: LatLon) => void;
  markers?: MapMarker[];
  height?: number;
  label: string;
}) {
  const initial = useMemo(() => pin ?? center, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div role="region" aria-label={label} style={{ height }} className="overflow-hidden rounded-[var(--radius)] border border-line">
      <MapContainer center={[initial.lat, initial.lon]} zoom={pin ? Math.max(zoom, 16) : zoom} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {onPick && <ClickToPick onPick={onPick} />}
        {pin && <Recenter center={pin} zoom={16} />}
        {pin && (
          <Marker
            position={[pin.lat, pin.lon]}
            icon={pinIcon()}
            draggable={!!onPick}
            eventHandlers={
              onPick
                ? {
                    dragend: (e) => {
                      const ll = (e.target as L.Marker).getLatLng();
                      onPick({ lon: ll.lng, lat: ll.lat });
                    },
                  }
                : undefined
            }
          />
        )}
        {markers?.map((m) => (
          <Marker
            key={m.id}
            position={[m.lat, m.lon]}
            icon={pinIcon(m.tone)}
            eventHandlers={m.onClick ? { click: m.onClick } : undefined}
          >
            <Popup>{m.label}</Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
