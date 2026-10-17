"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { TerritoryView } from "@/shared/contracts/intake";
import { api, errorMessage } from "@/app/_components/http";
import type { LatLon } from "@/app/_components/LeafletMap";

const LeafletMap = dynamic(() => import("@/app/_components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="h-[280px] animate-pulse rounded-[var(--radius)] bg-surface-2" aria-hidden />,
});

export type LocationMode = "gps" | "map" | "address" | "proposed";
export type Proposed = LatLon & { label: string };
type Source = "gps" | "map" | "geocoded";

export function LocationPanel({
  draftId,
  territory,
  initialMode,
  proposed,
  busy,
  onConfirm,
  onClose,
}: {
  draftId: string;
  territory: TerritoryView;
  initialMode: LocationMode;
  proposed?: Proposed | null;
  busy: boolean;
  onConfirm: (p: { lon: number; lat: number; source: Source; text?: string }) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<LocationMode>(initialMode);
  const [pin, setPin] = useState<LatLon | null>(proposed ?? null);
  const [source, setSource] = useState<Source>(proposed ? "geocoded" : "map");
  const [label, setLabel] = useState<string | null>(proposed?.label ?? null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (initialMode === "gps") locate();
    // solo al abrir el panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function locate() {
    setMode("gps");
    setNote(null);
    if (!("geolocation" in navigator)) {
      setNote("Tu navegador no permite usar la ubicación. Marcá el punto en el mapa.");
      setMode("map");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPin({ lon: pos.coords.longitude, lat: pos.coords.latitude });
        setSource("gps");
        setLabel(null);
        setNote("Esta es tu ubicación actual. Si el problema está en otro lugar, tocá el mapa o arrastrá el punto.");
      },
      () => {
        setLocating(false);
        setNote("No pudimos obtener tu ubicación. Marcá el punto en el mapa.");
        setMode("map");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  }

  async function geocode(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setNote(null);
    setLocating(true);
    try {
      const r = await api<Proposed | null>(`/api/reportar/geocode?draftId=${encodeURIComponent(draftId)}&q=${encodeURIComponent(q)}`);
      if (r) {
        setPin({ lon: r.lon, lat: r.lat });
        setLabel(r.label);
        setSource("geocoded");
        setNote(`Encontramos «${r.label}». Revisá el punto antes de confirmar.`);
      } else {
        setNote(`No encontramos «${q}». Marcá el punto en el mapa; vamos a guardar lo que escribiste como referencia.`);
        setLabel(q);
        setMode("map");
        setSource("map");
      }
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setLocating(false);
    }
  }

  function pick(p: LatLon) {
    // Tocar o arrastrar el punto lo convierte en una elección en el mapa; la dirección escrita queda como referencia.
    setPin(p);
    setSource("map");
  }

  const canPick = mode === "map" || mode === "gps" || mode === "address" || moving;
  const showMap = mode !== "address" || pin !== null;

  return (
    <section aria-label="Ubicación del problema" className="card flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-bold">¿Dónde está el problema?</h2>
        <button type="button" className="btn" onClick={onClose} aria-label="Cerrar selector de ubicación">
          Cerrar
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Forma de indicar la ubicación">
        <button type="button" className="btn" aria-pressed={mode === "gps"} onClick={locate} disabled={locating}>
          Usar mi ubicación
        </button>
        <button type="button" className="btn" aria-pressed={mode === "map"} onClick={() => { setMode("map"); setNote("Tocá el mapa donde está el problema."); }}>
          Elegir en el mapa
        </button>
        <button type="button" className="btn" aria-pressed={mode === "address"} onClick={() => { setMode("address"); setNote(null); }}>
          Escribir dirección
        </button>
      </div>

      {mode === "address" && (
        <form onSubmit={geocode} className="flex gap-2">
          <label htmlFor="addr" className="sr-only">Dirección o esquina</label>
          <input
            id="addr"
            className="field"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Calle y número, o esquina"
            autoComplete="street-address"
          />
          <button className="btn btn-primary" disabled={locating || !query.trim()}>
            Buscar
          </button>
        </form>
      )}

      {locating && <p role="status" className="text-ink-2">Buscando…</p>}
      {note && <p role="status" className="text-ink-2">{note}</p>}

      {showMap && (
        <LeafletMap
          label="Mapa para marcar la ubicación"
          center={territory.center}
          zoom={territory.zoom}
          pin={pin}
          onPick={canPick ? pick : undefined}
        />
      )}

      {mode === "proposed" && !moving && pin && (
        <button type="button" className="btn" onClick={() => { setMoving(true); setNote("Tocá el mapa o arrastrá el punto."); }}>
          Mover el punto
        </button>
      )}

      <button
        type="button"
        className="btn btn-primary"
        disabled={!pin || busy}
        onClick={() => pin && onConfirm({ lon: pin.lon, lat: pin.lat, source, text: label ?? undefined })}
      >
        {busy ? "Guardando…" : "Confirmar ubicación"}
      </button>
    </section>
  );
}
