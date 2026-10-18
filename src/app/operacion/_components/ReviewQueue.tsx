"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { IncidentListResponse } from "@/shared/contracts/incident";
import type { ResolveAction, ResolveBody, ReviewItemView, ReviewQueueResponse } from "@/shared/contracts/review";
import { HttpError, api, errorMessage, withTimeout } from "@/app/_components/http";
import { Icon } from "./Icons";
import {
  REVIEW_ACTION, SEVERITY, age, candidateIncidentIds, incidentHref, relatedIncidentId, reviewKindLabel, reviewReasonText, shortCode,
  type ReviewActionName,
} from "./labels";
import { KpiCard, OpsHeader, PriorityBadge } from "./OpsShell";

const REFRESH_MS = 15000;
const RESOLVE_TIMEOUT_MS = 15000;
/** Mínimo de la nota cuando es obligatoria: la corrección la usa como motivo del override (3 a 500 caracteres). */
const NOTE_MIN = 3;
const NOTE_MAX = 500;

type ResolveResult = { reviewItemId: string; status: string; replayed: boolean };
type Titles = ReadonlyMap<string, string>;

const NEEDS_NOTE: ReadonlySet<ReviewActionName> = new Set(["dismiss", "set_severity", "set_type"]);
const NEEDS_CONFIRM: ReadonlySet<ReviewActionName> = new Set(["dismiss", "create_incident"]);
const SEVERITIES = ["low", "medium", "high"] as const;

function incidentName(id: string, titles: Titles): string {
  const t = titles.get(id);
  return t ? `${t} (${shortCode(id)})` : shortCode(id);
}

function resolvedMessage(r: ResolveAction, titles: Titles): string {
  switch (r.action) {
    case "link":
      return `Resuelto: asociado al incidente ${incidentName(r.incidentId, titles)}.`;
    case "create_incident":
      return "Resuelto: se creó un incidente nuevo.";
    case "set_type":
      return "Resuelto: tipo corregido.";
    case "set_severity":
      return `Resuelto: severidad corregida a ${SEVERITY[r.severity].toLocaleLowerCase("es")}.`;
    case "allow_dispatch":
      return "Resuelto: despacho permitido. El plan se recalcula.";
    case "reassign":
      return "Resuelto: orden reasignada.";
    case "retry":
      return "Resuelto: se reintenta el análisis.";
    case "dismiss":
      return "Descartado.";
  }
}

function confirmText(r: ResolveAction): string {
  return r.action === "dismiss"
    ? "¿Descartar este ítem? Sale de la cola sin aplicar cambios."
    : "¿Crear un incidente nuevo con este reporte? Queda separado de los incidentes existentes.";
}

/** Cola de revisión humana (Tarea 14): lo que el sistema no decide solo, con las acciones válidas para cada ítem. */
export function ReviewQueue({ territorySlug }: { territorySlug: string }) {
  const [data, setData] = useState<ReviewQueueResponse | null>(null);
  const [territoryName, setTerritoryName] = useState<string | null>(null);
  const [titles, setTitles] = useState<Titles>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Ítems resueltos desde esta pantalla: se ocultan ya, aunque llegue una carga pedida antes de resolverlos.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const router = useRouter();
  // Solo la última carga pedida escribe el estado: una respuesta lenta de un pedido anterior no pisa a una más nueva.
  const latest = useRef(0);
  const refresh = useRef<() => void>(() => {});

  const onAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof HttpError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/operacion/revision?territory=${territorySlug}`)}`);
        return true;
      }
      return false;
    },
    [router, territorySlug],
  );

  const load = useCallback(
    async (signal: AbortSignal) => {
      const id = ++latest.current;
      const stale = () => signal.aborted || id !== latest.current;
      const qs = new URLSearchParams({ territory: territorySlug });
      // La lista de incidentes da el nombre del territorio y los títulos de los candidatos; si falla, se muestran los códigos.
      const [queue, incidents] = await Promise.allSettled([
        api<ReviewQueueResponse>(`/api/operacion/review?${qs}`, { signal: withTimeout(signal) }),
        api<IncidentListResponse>(`/api/operacion/incidents?${qs}`, { signal: withTimeout(signal) }),
      ]);
      if (stale()) return;
      if (incidents.status === "fulfilled") {
        setTerritoryName(incidents.value.territory.name);
        setTitles(new Map(incidents.value.incidents.map((i) => [i.id, i.title])));
      }
      if (queue.status === "rejected") {
        if (!onAuthError(queue.reason)) setError(errorMessage(queue.reason));
        return;
      }
      const d = queue.value;
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
      // Un oculto que ya no viene en la cola se olvida; uno que todavía viene (carga anterior a resolverlo) sigue oculto.
      setHidden((h) => {
        if (h.size === 0) return h;
        const present = new Set(d.items.map((i) => i.id));
        const next = new Set([...h].filter((x) => present.has(x)));
        return next.size === h.size ? h : next;
      });
    },
    [territorySlug, onAuthError],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    // Un tick no se superpone a una carga en curso: con el backend más lento que el intervalo los pedidos no se apilan.
    let inFlight = false;
    const run = () => {
      if (inFlight) return;
      inFlight = true;
      void load(ctrl.signal).finally(() => {
        inFlight = false;
      });
    };
    refresh.current = run;
    const first = setTimeout(run, 0);
    const t = setInterval(run, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearTimeout(first);
      clearInterval(t);
      refresh.current = () => {};
    };
  }, [load]);

  const hide = useCallback((item: ReviewItemView, message: string) => {
    setHidden((h) => new Set(h).add(item.id));
    setNotice(message);
    refresh.current();
  }, []);

  const items = (data?.items ?? []).filter((i) => !hidden.has(i.id));
  const urgent = items.filter((i) => i.priorityBand === "high" || i.activeHazard).length;
  const oldest = items.reduce<ReviewItemView | null>((o, i) => (!o || i.createdAt < o.createdAt ? i : o), null);
  const now = updatedAt ?? 0;

  return (
    <div className="flex w-full flex-1 flex-col">
      <OpsHeader title="Cola de revisión" subtitle={territoryName} updatedAt={updatedAt} offline={!!error && !!data} />

      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 px-4 py-5 lg:px-6">
        {/* Región viva siempre montada: así el lector de pantalla anuncia cada resultado. */}
        <div role="status" aria-live="polite">
          {notice && (
            <p className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] bg-info-soft px-3 py-2">
              <span>{notice}</span>
              <button type="button" className="btn ops-btn-ghost" onClick={() => setNotice(null)}>
                Cerrar aviso
              </button>
            </p>
          )}
        </div>
        {error && <p role="alert" className="rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">{error}</p>}

        <section aria-label="Resumen de la cola" className="grid grid-cols-3 gap-2 sm:gap-4">
          <KpiCard label="Por revisar" value={data ? items.length : "—"} detail={data ? "esperan una decisión" : null} icon="help" tone="warn" />
          <KpiCard label="Urgentes" value={data ? urgent : "—"} detail={data ? "alta prioridad o peligro" : null} icon="alert" tone="danger" />
          <KpiCard
            label="Más antiguo"
            value={data ? (oldest ? age(oldest.createdAt, now) : "—") : "—"}
            detail={oldest ? reviewKindLabel(oldest.kind).toLocaleLowerCase("es") : null}
            icon="clock"
            tone="info"
          />
        </section>

        <section aria-labelledby="cola-revision" className="flex flex-col gap-2.5">
          <h2 id="cola-revision" className="ops-eyebrow px-1">
            Ítems abiertos, de más a menos urgente{data ? ` (${items.length})` : ""}
          </h2>
          {data && items.length === 0 && (
            <div className="card p-6 text-center">
              <p className="text-lg font-bold">No hay nada para revisar</p>
              <p className="mt-1 text-ink-2">Cuando el sistema necesite una decisión tuya, el ítem aparece acá.</p>
            </div>
          )}
          <ul className="flex flex-col gap-2.5">
            {items.map((it) => (
              <ReviewCard
                key={it.id}
                item={it}
                now={now}
                territorySlug={territorySlug}
                titles={titles}
                onAuthError={onAuthError}
                onDone={hide}
                onStale={() => refresh.current()}
              />
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function ReviewCard({
  item, now, territorySlug, titles, onAuthError, onDone, onStale,
}: {
  item: ReviewItemView;
  now: number;
  territorySlug: string;
  titles: Titles;
  onAuthError: (err: unknown) => boolean;
  onDone: (item: ReviewItemView, message: string) => void;
  onStale: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ResolveAction | null>(null);
  // Clave de idempotencia del intento en curso: se reutiliza si se reintenta lo mismo después de un error de red.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const outcomeUnknown = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const uid = useId();

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const has = (a: ReviewActionName) => item.actions.includes(a);
  const incidentId = relatedIncidentId(item);
  const candidates = item.kind === "uncertain_duplicate" ? candidateIncidentIds(item.evidenceRefs) : [];
  const reasons = [...new Set(item.reasons.map(reviewReasonText).filter((r): r is string => !!r))];
  const noteRequired = item.actions.some((a) => NEEDS_NOTE.has(a as ReviewActionName));

  function request(resolution: ResolveAction) {
    setError(null);
    if (NEEDS_NOTE.has(resolution.action) && note.trim().length < NOTE_MIN) {
      setError(`Para «${REVIEW_ACTION[resolution.action]}» escribí una nota de al menos ${NOTE_MIN} caracteres.`);
      noteRef.current?.focus();
      return;
    }
    if (NEEDS_CONFIRM.has(resolution.action)) {
      setConfirming(resolution);
      return;
    }
    void submit(resolution);
  }

  async function submit(resolution: ResolveAction) {
    setConfirming(null);
    setError(null);
    const trimmed = note.trim();
    const signature = JSON.stringify([resolution, trimmed]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    const body: ResolveBody = { resolution, idempotencyKey: attempt.current.key, ...(trimmed ? { note: trimmed } : {}) };
    setBusy(true);
    try {
      await api<ResolveResult>(`/api/operacion/review/${encodeURIComponent(item.id)}/resolve`, {
        method: "POST",
        json: body,
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });
      onDone(item, `${resolvedMessage(resolution, titles)} ${item.title}`);
    } catch (err) {
      if (onAuthError(err)) return;
      const http = err instanceof HttpError ? err : null;
      // Sin respuesta o error del servidor: no se sabe si se aplicó, así que el reintento manda la misma clave.
      const unknownOutcome = !http || http.status === 0 || http.status >= 500;
      if (http?.status === 409 && http.code === "review_item_closed") {
        attempt.current = null;
        // Si un intento anterior quedó sin respuesta, pudo haber sido el propio y no otro operador.
        onDone(item, outcomeUnknown.current ? `Ya estaba resuelto (puede que tu intento anterior se haya aplicado): ${item.title}` : `Otro operador ya lo resolvió: ${item.title}`);
        return;
      }
      if (http?.status === 404) {
        attempt.current = null;
        onDone(item, `Este ítem ya no está en la cola: ${item.title}`);
        return;
      }
      if (unknownOutcome) outcomeUnknown.current = true;
      else attempt.current = null;
      setError(unknownOutcome ? `${errorMessage(err)} Podés reintentar: la acción no se aplica dos veces.` : errorMessage(err));
      // Un 409 de otro tipo (el incidente cambió o se cerró): la cola se recarga para mostrar el estado actual.
      if (http?.status === 409) onStale();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="ops-item px-4 py-3.5" aria-labelledby={`${uid}-title`}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge band={item.priorityBand} />
          <span className="ops-chip">{reviewKindLabel(item.kind)}</span>
          {incidentId && <span className="ops-code">{shortCode(incidentId)}</span>}
          {item.activeHazard && <span className="ops-badge ops-badge--high">Peligro activo</span>}
        </div>
        <span className="text-ink-2">Hace {age(item.createdAt, now)}</span>
      </div>

      <h3 id={`${uid}-title`} className="text-lg font-semibold leading-snug">{item.title}</h3>
      {reasons.length > 0 && (
        <p className="mt-0.5 text-warn">
          <span className="font-semibold">Motivo:</span> {reasons.join(" · ")}
        </p>
      )}
      {incidentId && (
        <Link href={incidentHref(incidentId, territorySlug)} className="mt-1 inline-flex min-h-11 items-center gap-1.5 font-semibold text-accent hover:underline">
          Ver detalle del incidente <Icon name="arrow" size={18} />
        </Link>
      )}

      {candidates.length > 0 && (
        <div className="mt-2">
          <h4 className="font-semibold">Incidentes candidatos</h4>
          <ul className="mt-1 flex flex-col gap-1.5">
            {candidates.map((cid) => (
              <li key={cid} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-3 py-1.5">
                <Link href={incidentHref(cid, territorySlug)} className="inline-flex min-h-11 items-center font-medium text-accent hover:underline">
                  {incidentName(cid, titles)}
                </Link>
                {has("link") && (
                  <button type="button" className="btn" disabled={busy} onClick={() => request({ action: "link", incidentId: cid })}>
                    {REVIEW_ACTION.link}
                    <span className="sr-only"> {incidentName(cid, titles)}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2.5 flex flex-col gap-2 border-t border-line pt-2.5">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Nota{noteRequired ? " (obligatoria para descartar o corregir)" : " (opcional)"}</span>
          <textarea
            ref={noteRef}
            className="field"
            rows={2}
            maxLength={NOTE_MAX}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          {has("allow_dispatch") && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => request({ action: "allow_dispatch" })}>
              <Icon name="check" /> {REVIEW_ACTION.allow_dispatch}
            </button>
          )}
          {has("retry") && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => request({ action: "retry" })}>
              <Icon name="refresh" /> {REVIEW_ACTION.retry}
            </button>
          )}
          {has("create_incident") && (
            <button type="button" className="btn" disabled={busy} onClick={() => request({ action: "create_incident" })}>
              <Icon name="add" /> {REVIEW_ACTION.create_incident}
            </button>
          )}
          {has("set_severity") && (
            <fieldset className="flex flex-wrap items-center gap-1.5">
              <legend className="sr-only">{REVIEW_ACTION.set_severity}</legend>
              <span aria-hidden className="font-medium text-ink-2">{REVIEW_ACTION.set_severity}:</span>
              {SEVERITIES.map((s) => (
                <button key={s} type="button" className="btn" disabled={busy} onClick={() => request({ action: "set_severity", severity: s })}>
                  {SEVERITY[s]}
                </button>
              ))}
            </fieldset>
          )}
          {has("dismiss") && (
            <button type="button" className="btn text-danger" disabled={busy} onClick={() => request({ action: "dismiss" })}>
              <Icon name="block" /> {REVIEW_ACTION.dismiss}
            </button>
          )}
        </div>
        {has("set_type") && incidentId && (
          <p className="text-ink-2">
            Para corregir el tipo, abrí el{" "}
            <Link href={incidentHref(incidentId, territorySlug)} className="font-semibold text-accent hover:underline">detalle del incidente</Link>.
          </p>
        )}

        {confirming && (
          <div role="group" aria-labelledby={`${uid}-confirm`} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-warn-soft px-3 py-2">
            <span id={`${uid}-confirm`} className="font-medium">{confirmText(confirming)}</span>
            <button ref={confirmRef} type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit(confirming)}>
              Sí, {REVIEW_ACTION[confirming.action].toLocaleLowerCase("es")}
            </button>
            <button type="button" className="btn ops-btn-ghost" onClick={() => setConfirming(null)}>
              Volver
            </button>
          </div>
        )}

        {busy && <p className="text-ink-2" aria-hidden>Aplicando…</p>}
        {error && <p role="alert" className="rounded-[10px] bg-danger-soft px-3 py-2 text-danger">{error}</p>}
      </div>
    </li>
  );
}
