"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { IncidentListResponse } from "@/shared/contracts/incident";
import type { ResolveAction, ResolveBody, ReviewItemView, ReviewQueueResponse } from "@/shared/contracts/review";
import { HttpError, api, errorMessage, withTimeout } from "@/app/_components/http";
import { Icon } from "./Icons";
import { newIdempotencyKey } from "./idempotency";
import {
  REVIEW_ACTION, SEVERITY, age, incidentHref, linkTargets, relatedIncidentId, reviewKindLabel, reviewReasonText, shortCode,
  type ReviewActionName,
} from "./labels";
import { KpiCard, OpsHeader, PriorityBadge } from "./OpsShell";

const REFRESH_MS = 15000;
const RESOLVE_TIMEOUT_MS = 15000;
/** Mínimo de la nota cuando es obligatoria: la corrección la usa como motivo del override (3 a 500 caracteres). */
const NOTE_MIN = 3;
const NOTE_MAX = 500;

type ResolveResult = { reviewItemId: string; status: string; replayed: boolean };

const QUEUE_HEADING_ID = "cola-revision";
const cardTitleId = (itemId: string) => `revision-${itemId}`;

type Titles = ReadonlyMap<string, string>;

const NEEDS_NOTE: ReadonlySet<ReviewActionName> = new Set(["dismiss", "set_severity", "set_type"]);
const NEEDS_CONFIRM: ReadonlySet<ReviewActionName> = new Set(["dismiss", "create_incident"]);
const SEVERITIES = ["low", "medium", "high"] as const;
/** Acciones que se resuelven desde la cola. */
const QUEUE_ACTIONS: ReadonlySet<ReviewActionName> = new Set(["link", "create_incident", "set_severity", "allow_dispatch", "retry", "dismiss"]);

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
    // Un refresco pedido a mano (después de resolver o de un 409) no se pierde: si hay una carga en curso, corre al terminar.
    let inFlight = false;
    let again = false;
    const run = (explicit = false) => {
      if (inFlight) {
        again ||= explicit;
        return;
      }
      inFlight = true;
      void load(ctrl.signal).finally(() => {
        inFlight = false;
        if (again && !ctrl.signal.aborted) {
          again = false;
          run();
        }
      });
    };
    refresh.current = () => run(true);
    const first = setTimeout(run, 0);
    const t = setInterval(run, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearTimeout(first);
      clearInterval(t);
      refresh.current = () => {};
    };
  }, [load]);

  const items = (data?.items ?? []).filter((i) => !hidden.has(i.id));

  // Al sacar una tarjeta (o cerrar el aviso) el foco va a la siguiente, o al título de la cola si era la última:
  // con teclado o lector de pantalla no se vuelve a empezar desde arriba después de cada decisión.
  const pendingFocus = useRef<string | null>(null);
  const visibleIds = useRef<string[]>([]);
  useEffect(() => {
    visibleIds.current = items.map((i) => i.id);
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    document.getElementById(target)?.focus();
  });

  const hide = useCallback((item: ReviewItemView, message: string) => {
    // Solo si el foco sigue en la tarjeta que sale (o se perdió): si el operador ya pasó a otra, no se lo saca de ahí.
    const active = document.activeElement;
    const card = document.getElementById(cardTitleId(item.id))?.closest("li");
    if (!active || active === document.body || card?.contains(active)) {
      const ids = visibleIds.current;
      const next = ids[ids.indexOf(item.id) + 1] ?? ids[ids.indexOf(item.id) - 1];
      pendingFocus.current = next && next !== item.id ? cardTitleId(next) : QUEUE_HEADING_ID;
    }
    setHidden((h) => new Set(h).add(item.id));
    setNotice(message);
    refresh.current();
  }, []);

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
              <button
                type="button"
                className="btn ops-btn-ghost"
                onClick={() => {
                  pendingFocus.current = QUEUE_HEADING_ID;
                  setNotice(null);
                }}
              >
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

        <section aria-labelledby={QUEUE_HEADING_ID} className="flex flex-col gap-2.5">
          <h2 id={QUEUE_HEADING_ID} tabIndex={-1} className="ops-eyebrow px-1">
            Ítems abiertos, de más a menos urgente{data ? ` (${items.length})` : ""}
          </h2>
          {!data && !error && <p className="card p-4 text-ink-2">Cargando la cola…</p>}
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
  const [noteError, setNoteError] = useState(false);
  const [confirming, setConfirming] = useState<ResolveAction | null>(null);
  // Clave de idempotencia del intento en curso: se reutiliza si se reintenta lo mismo después de un error de red.
  const attempt = useRef<{ signature: string; body: ResolveBody } | null>(null);
  const outcomeUnknown = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const uid = useId();
  const titleId = cardTitleId(item.id);
  const errorId = `${uid}-error`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const has = (a: ReviewActionName) => item.actions.includes(a);
  const incidentId = relatedIncidentId(item);
  // Destinos de «Asociar»: los candidatos de la agrupación o, en un ítem abierto al desasociar, el incidente anterior.
  const targets = item.kind === "uncertain_duplicate" ? linkTargets(item.evidenceRefs) : { source: "none" as const, ids: [] };
  const candidates = targets.ids;
  const reasons = [...new Set(item.reasons.map(reviewReasonText).filter((r): r is string => !!r))];
  const noteRequired = item.actions.some((a) => a !== "set_type" && NEEDS_NOTE.has(a as ReviewActionName));
  // `set_type` se hace desde el detalle y `reassign` no se ofrece en el MVP: si no queda otra, la tarjeta no muestra controles.
  const actionable = item.actions.some((a) => QUEUE_ACTIONS.has(a as ReviewActionName) && (a !== "link" || candidates.length > 0));

  /** La nota obligatoria se valida al pedir y otra vez al enviar: pudo borrarse mientras se mostraba la confirmación. */
  function missingNote(resolution: ResolveAction): boolean {
    if (!NEEDS_NOTE.has(resolution.action) || note.trim().length >= NOTE_MIN) return false;
    // Un reintento tras resultado desconocido reenvía el cuerpo original, que ya traía su nota.
    if (attempt.current?.signature === JSON.stringify(resolution)) return false;
    setConfirming(null);
    setNoteError(true);
    setError(`Para «${REVIEW_ACTION[resolution.action]}» escribí una nota de al menos ${NOTE_MIN} caracteres.`);
    noteRef.current?.focus();
    return true;
  }

  function request(resolution: ResolveAction, opener: HTMLElement) {
    setError(null);
    setNoteError(false);
    if (missingNote(resolution)) return;
    if (NEEDS_CONFIRM.has(resolution.action)) {
      openerRef.current = opener;
      setConfirming(resolution);
      return;
    }
    void submit(resolution);
  }

  function cancelConfirm() {
    setConfirming(null);
    openerRef.current?.focus();
  }

  async function submit(resolution: ResolveAction) {
    if (missingNote(resolution)) return;
    // Mientras se aplica, los botones quedan deshabilitados (y el de confirmar desaparece): el foco queda en el título.
    titleRef.current?.focus();
    setConfirming(null);
    setError(null);
    setNoteError(false);
    const trimmed = note.trim();
    // Un intento solo sobrevive a un resultado desconocido (red, timeout, 5xx). Reintentar la misma acción reenvía el
    // mismo cuerpo con la misma clave, aunque la nota se haya editado: el primero pudo aplicarse y no debe duplicarse.
    const signature = JSON.stringify(resolution);
    if (attempt.current?.signature !== signature) {
      const key = newIdempotencyKey();
      attempt.current = { signature, body: { resolution, idempotencyKey: key, ...(trimmed ? { note: trimmed } : {}) } };
    }
    const body = attempt.current.body;
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
        // Si algún intento anterior de esta tarjeta quedó sin respuesta, pudo haberse aplicado y cerrado el ítem (con esa
        // u otra clave): no se afirma que fue otro operador.
        onDone(item, outcomeUnknown.current ? `Ya estaba resuelto (puede que tu intento anterior se haya aplicado): ${item.title}` : `Otro operador ya lo resolvió: ${item.title}`);
        return;
      }
      // Un 404 no saca la tarjeta: `not_found` también lo dan el incidente o el reporte de la acción (p. ej. asociar a
      // un incidente que ya no existe), y un 404 sin código puede ser una ruta o un proxy. Se muestra el mensaje y se
      // recarga la cola: si el ítem de verdad ya no está, la recarga lo saca.
      if (unknownOutcome) outcomeUnknown.current = true;
      else {
        // Una respuesta definitiva que no es `review_item_closed` muestra que el ítem seguía abierto: ningún intento
        // anterior lo cerró, así que un 409 posterior sí es de otro operador.
        attempt.current = null;
        outcomeUnknown.current = false;
      }
      setError(
        unknownOutcome
          ? `${errorMessage(err)} Podés reintentar «${REVIEW_ACTION[resolution.action]}»: se reenvía igual que antes (con la misma nota) y no se aplica dos veces.`
          : errorMessage(err),
      );
      // Un 409 de otro tipo (el incidente cambió o se cerró) o un 404: la cola se recarga para mostrar el estado actual.
      if (http?.status === 409 || http?.status === 404) onStale();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="ops-item px-4 py-3.5" aria-labelledby={titleId}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge band={item.priorityBand} />
          <span className="ops-chip">{reviewKindLabel(item.kind)}</span>
          {incidentId && <span className="ops-code">{shortCode(incidentId)}</span>}
          {item.activeHazard && <span className="ops-badge ops-badge--high">Peligro activo</span>}
        </div>
        <span className="text-ink-2">Hace {age(item.createdAt, now)}</span>
      </div>

      <h3 id={titleId} ref={titleRef} tabIndex={-1} className="text-lg font-semibold leading-snug">{item.title}</h3>
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
          <h4 className="font-semibold">{targets.source === "previous" ? "Incidente del que se desasoció" : "Incidentes candidatos"}</h4>
          <ul className="mt-1 flex flex-col gap-1.5">
            {candidates.map((cid) => (
              <li key={cid} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-3 py-1.5">
                <Link href={incidentHref(cid, territorySlug)} className="inline-flex min-h-11 items-center font-medium text-accent hover:underline">
                  {incidentName(cid, titles)}
                </Link>
                {has("link") && (
                  <button type="button" className="btn" disabled={busy} onClick={(e) => request({ action: "link", incidentId: cid }, e.currentTarget)}>
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
        {actionable ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="font-medium">Nota{noteRequired ? " (obligatoria para descartar o corregir)" : " (opcional)"}</span>
              <textarea
                ref={noteRef}
                className="field"
                rows={2}
                maxLength={NOTE_MAX}
                value={note}
                disabled={busy}
                aria-invalid={error && noteError ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              {has("allow_dispatch") && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={(e) => request({ action: "allow_dispatch" }, e.currentTarget)}>
                  <Icon name="check" /> {REVIEW_ACTION.allow_dispatch}
                </button>
              )}
              {has("retry") && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={(e) => request({ action: "retry" }, e.currentTarget)}>
                  <Icon name="refresh" /> {REVIEW_ACTION.retry}
                </button>
              )}
              {has("create_incident") && (
                <button type="button" className="btn" disabled={busy} onClick={(e) => request({ action: "create_incident" }, e.currentTarget)}>
                  <Icon name="add" /> {REVIEW_ACTION.create_incident}
                </button>
              )}
              {has("set_severity") && (
                <fieldset className="flex flex-wrap items-center gap-1.5">
                  <legend className="sr-only">{REVIEW_ACTION.set_severity}</legend>
                  <span aria-hidden className="font-medium text-ink-2">{REVIEW_ACTION.set_severity}:</span>
                  {SEVERITIES.map((s) => (
                    <button key={s} type="button" className="btn" disabled={busy} onClick={(e) => request({ action: "set_severity", severity: s }, e.currentTarget)}>
                      {SEVERITY[s]}
                    </button>
                  ))}
                </fieldset>
              )}
              {has("dismiss") && (
                <button type="button" className="btn text-danger" disabled={busy} onClick={(e) => request({ action: "dismiss" }, e.currentTarget)}>
                  <Icon name="block" /> {REVIEW_ACTION.dismiss}
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="text-ink-2">Este ítem no tiene acciones disponibles desde la cola.</p>
        )}
        {has("set_type") && (
          <p className="text-ink-2">
            {incidentId ? (
              <>
                Para corregir el tipo, abrí el{" "}
                <Link href={incidentHref(incidentId, territorySlug)} className="font-semibold text-accent hover:underline">detalle del incidente</Link>.
              </>
            ) : (
              "Corregir el tipo todavía no está disponible desde la cola para un reporte sin incidente."
            )}
          </p>
        )}

        {confirming && (
          <div role="group" aria-labelledby={`${uid}-confirm`} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-warn-soft px-3 py-2">
            <span id={`${uid}-confirm`} className="font-medium">{confirmText(confirming)}</span>
            <button ref={confirmRef} type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit(confirming)}>
              Sí, {REVIEW_ACTION[confirming.action].toLocaleLowerCase("es")}
            </button>
            <button type="button" className="btn ops-btn-ghost" onClick={cancelConfirm}>
              Volver
            </button>
          </div>
        )}

        {busy && <p className="text-ink-2" aria-hidden>Aplicando…</p>}
        {error && <p id={errorId} role="alert" className="rounded-[10px] bg-danger-soft px-3 py-2 text-danger">{error}</p>}
      </div>
    </li>
  );
}
