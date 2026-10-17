"use client";

import type { DraftCard, DraftView } from "@/shared/contracts/intake";

const SEVERITY: Record<NonNullable<DraftCard["severity"]>, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
  undetermined: "Sin determinar",
};

const MISSING: Record<DraftCard["missing"][number], string> = {
  description: "contar qué pasa",
  location: "confirmar la ubicación",
  evaluation: "terminar el análisis",
};

export function DraftCardView({
  card,
  location,
  areaLabel,
  busy,
  onConfirm,
  onChangeLocation,
}: {
  card: DraftCard;
  location: DraftView["location"];
  areaLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onChangeLocation: () => void;
}) {
  const place = card.place ?? location?.text ?? null;
  return (
    <section aria-label="Ficha del reporte" className="card flex flex-col gap-2 p-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-ink-2">Problema</dt>
        <dd className="font-semibold">{card.typeName ?? "Por determinar"}</dd>
        {card.severity && card.severity !== "undetermined" && (
          <>
            <dt className="text-ink-2">Gravedad</dt>
            <dd>{SEVERITY[card.severity]}</dd>
          </>
        )}
        <dt className="text-ink-2">Lugar</dt>
        <dd>
          {location?.confirmed ? (
            <>
              {place ?? "Punto marcado en el mapa"}
              <span className="block text-sm text-ink-2">
                {areaLabel}: {card.areaName ?? location.areaName ?? "sin determinar"}
              </span>
            </>
          ) : (
            <span className="text-ink-2">Falta confirmar</span>
          )}
        </dd>
        <dt className="text-ink-2">Fotos</dt>
        <dd>{card.photoCount === 0 ? "Sin foto" : card.photoCount}</dd>
      </dl>

      {card.activeHazard && (
        <p className="font-semibold text-danger">⚠ Posible peligro activo: se marca como urgente.</p>
      )}
      {card.needsReview && (
        <p className="rounded-[var(--radius)] bg-warn-soft px-2 py-1 text-warn">
          Lo va a revisar una persona antes de asignarlo.
        </p>
      )}
      {!card.ready && card.missing.length > 0 && (
        <p className="text-sm text-ink-2">Para enviar falta: {card.missing.map((m) => MISSING[m]).join(", ")}.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary flex-1" disabled={!card.ready || busy} onClick={onConfirm}>
          {busy ? "Enviando…" : "Enviar reporte"}
        </button>
        <button type="button" className="btn" onClick={onChangeLocation}>
          {location?.confirmed ? "Cambiar ubicación" : "Marcar ubicación"}
        </button>
      </div>
    </section>
  );
}
