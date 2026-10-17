"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { TerritoryView } from "@/shared/contracts/intake";
import { api, errorMessage } from "@/app/_components/http";
import type { LatLon } from "@/app/_components/LeafletMap";
import { IconLocate, IconMap, IconPin } from "@/app/_components/icons";

const LeafletMap = dynamic(() => import("@/app/_components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="h-[260px] animate-pulse rounded-[var(--radius)] bg-surface-2" aria-hidden />,
});

export type LocationMode = "gps" | "map" | "address" | "proposed";
export type Proposed = LatLon & { label: string };
type Source = "gps" | "map" | "geocoded";

const MODES: { mode: Exclude<LocationMode, "proposed">; label: string; Icon: typeof IconPin }[] = [
  { mode: "address", label: "Dirección", Icon: IconPin },
  { mode: "gps", label: "Mi ubicación", Icon: IconLocate },
  { mode: "map", label: "En el mapa", Icon: IconMap },
];

/**
 * Selector de ubicación dentro del chat. La persona siempre confirma el punto; la IA nunca lo confirma.
 * Funciona en cualquier navegador: sin geolocalización (o sin permiso) cae al mapa.
 */
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
  const geoAvailable = typeof navigator !== "undefined" && "geolocation" in navigator;
  const startsWithGps = initialMode === "gps" && geoAvailable;
  const [mode, setMode] = useState<LocationMode>(initialMode === "gps" && !geoAvailable ? "map" : initialMode);
  const [pin, setPin] = useState<LatLon | null>(proposed ?? null);
  const [source, setSource] = useState<Source>(proposed ? "geocoded" : "map");
  const [label, setLabel] = useState<string | null>(proposed?.label ?? null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(
    proposed
      ? `Encontré «${proposed.label}». Revisá el punto y confirmalo, o tocá el mapa para moverlo.`
      : initialMode === "gps" && !geoAvailable
        ? "Este navegador no permite usar la ubicación. Marcá el punto en el mapa."
        : initialMode === "map"
          ? "Tocá el mapa donde está el problema."
          : null,
  );
  const [locating, setLocating] = useState(startsWithGps);

  /** Pide la posición; el estado se actualiza solo en los callbacks (asíncronos). */
  function requestPosition() {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPin({ lon: pos.coords.longitude, lat: pos.coords.latitude });
        setSource("gps");
        setLabel(null);
        setNote("Esta es tu ubicación actual. Si el problema está en otro lugar, tocá el mapa o arrastrá el punto.");
      },
      (err) => {
        setLocating(false);
        setNote(
          err.code === err.PERMISSION_DENIED
            ? "No diste permiso para usar tu ubicación. Marcá el punto en el mapa."
            : "No pudimos obtener tu ubicación. Marcá el punto en el mapa.",
        );
        setMode("map");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  }

  function locate() {
    setMode("gps");
    setNote(null);
    if (!geoAvailable) {
      setNote("Este navegador no permite usar la ubicación. Marcá el punto en el mapa.");
      setMode("map");
      return;
    }
    setLocating(true);
    requestPosition();
  }

  useEffect(() => {
    if (startsWithGps) requestPosition();
    // solo al abrir el panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(m: Exclude<LocationMode, "proposed">) {
    if (m === "gps") return locate();
    setMode(m);
    setNote(m === "map" ? "Tocá el mapa donde está el problema." : null);
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
        setLabel(q);
        setSource("geocoded");
        setNote(`Encontré «${q}». Revisá el punto antes de confirmar.`);
      } else {
        setNote(`No encontré «${q}». Marcá el punto en el mapa; guardamos lo que escribiste como referencia.`);
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

  const showMap = mode !== "address" || pin !== null;

  return (
    <section aria-label="Ubicación del problema" className="card flex flex-col gap-3 p-3 sm:p-4">
      <div role="group" aria-label="Forma de indicar la ubicación" className="grid grid-cols-3 gap-1 rounded-xl bg-surface-low p-1">
        {MODES.map(({ mode: m, label: l, Icon }) => {
          const on = mode === m || (mode === "proposed" && m === "address");
          return (
            <button
              key={m}
              type="button"
              aria-pressed={on}
              disabled={locating && m === "gps"}
              onClick={() => choose(m)}
              className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-[15px] font-semibold ${
                on ? "bg-surface text-primary shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="truncate">{l}</span>
            </button>
          );
        })}
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
            enterKeyHint="search"
          />
          <button className="btn btn-primary" disabled={locating || !query.trim()}>
            Buscar
          </button>
        </form>
      )}

      {locating && <p role="status" className="text-ink-2">Buscando…</p>}
      {note && <p role="status" className="text-[15px] text-ink-2">{note}</p>}

      {showMap && (
        <LeafletMap label="Mapa para marcar la ubicación" center={territory.center} zoom={territory.zoom} pin={pin} onPick={pick} height={260} />
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={!pin || busy}
          onClick={() => pin && onConfirm({ lon: pin.lon, lat: pin.lat, source, text: label ?? undefined })}
        >
          {busy ? "Guardando…" : "Confirmar este punto"}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancelar
        </button>
      </div>
    </section>
  );
}
