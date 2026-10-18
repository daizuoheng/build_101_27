"use client";

import type { DraftView } from "@/shared/contracts/intake";
import { IconAlert, IconCamera, IconEdit, IconEye, IconSend } from "@/app/_components/icons";

const MISSING: Record<DraftView["card"]["missing"][number], string> = {
  description: "contar qué pasa",
  location: "confirmar la ubicación",
  evaluation: "terminar el análisis",
};

/**
 * Ficha para revisar antes de enviar, dentro del chat. Muestra solo lo que dijo la persona y lo que confirmó;
 * no muestra prioridad (la calcula el sistema después del envío) ni promete tiempos.
 */
export function ReviewCard({
  draft,
  busy,
  onConfirm,
  onModify,
}: {
  draft: DraftView;
  busy: boolean;
  onConfirm: () => void;
  onModify: () => void;
}) {
  const { card, location, territory } = draft;
  const place = card.place ?? location?.text ?? null;
  const area = card.areaName ?? location?.areaName ?? null;
  const description = card.description;

  return (
    <section aria-label="Ficha del reporte" className="card flex w-full flex-col gap-4 p-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-[13px] font-medium text-ink-2">Problema</dt>
          <dd className="mt-0.5 text-[20px] font-semibold leading-[25px] tracking-[-0.015em] text-ink">{card.typeName ?? "Por determinar"}</dd>
        </div>
        <div>
          <dt className="text-[13px] font-medium text-ink-2">Ubicación</dt>
          <dd className="mt-0.5 font-bold text-ink">
            {location?.confirmed ? place ?? (location.source === "gps" ? "Tu ubicación compartida" : "Punto confirmado") : <span className="font-normal text-ink-2">Falta confirmar</span>}
            {location?.confirmed && area && (
              <span className="mt-1 block">
                <span className="badge badge-muted">{territory.areaLabel} · {area}</span>
              </span>
            )}
          </dd>
        </div>
        {description && (
          <div className="sm:col-span-2">
            <dt className="text-[13px] font-medium text-ink-2">Lo que contaste</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-ink">{description}</dd>
          </div>
        )}
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3 text-[15px]">
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <IconCamera className="h-[18px] w-[18px] text-accent" />
          {card.photoCount === 0 ? "Sin fotos" : card.photoCount === 1 ? "1 foto adjunta" : `${card.photoCount} fotos adjuntas`}
        </span>
        <button type="button" onClick={onModify} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 font-semibold text-accent transition-colors hover:bg-surface-low">
          <IconEdit className="h-[18px] w-[18px]" /> Modificar datos
        </button>
      </div>

      {card.activeHazard && (
        <p className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 font-semibold text-danger-strong">
          <IconAlert className="mt-0.5 h-5 w-5 shrink-0" />
          Si hay fuego o riesgo para personas ahora, no esperes a este canal{territory.emergencyText ? `: ${territory.emergencyText}` : "."}
        </p>
      )}
      {card.needsReview && (
        <p className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-ink-2">
          <IconEye className="mt-0.5 h-5 w-5 shrink-0" />
          Una persona lo va a revisar antes de asignarlo.
        </p>
      )}
      {!card.ready && card.missing.length > 0 && (
        <p className="text-ink-2">Para enviar falta: {card.missing.map((m) => MISSING[m]).join(", ")}.</p>
      )}

      <button type="button" className="btn btn-success w-full text-[17px]" disabled={!card.ready || busy} onClick={onConfirm}>
        <IconSend className="h-5 w-5" />
        {busy ? "Enviando…" : "Enviar reporte"}
      </button>
    </section>
  );
}
