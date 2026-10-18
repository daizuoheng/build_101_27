"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { allowedActions, type AssignmentAction } from "@/shared/contracts/assignment";
import type { OverrideField, OverrideValue, SetOverrideBody } from "@/shared/contracts/incident";
import type { IncidentDetailResponse, OverrideResult } from "@/shared/contracts/incident-detail";
import { HttpError, api, errorMessage, withTimeout } from "@/app/_components/http";
import { Icon } from "./Icons";
import { AttemptKeys, outcomeOf } from "./idempotency";
import { ASSIGNMENT_STATUS, PRIORITY, REVIEW_KIND, STATUS, areaDisplay, shortCode } from "./labels";
import { OpsHeader, PriorityBadge } from "./OpsShell";

// Detalle del incidente para el operador (Tarea 14): ver la evidencia, corregir datos, desasociar reportes, actuar
// sobre la orden activa y marcar resuelto. Los textos propios del detalle viven acá para no chocar con labels.ts.

const REFRESH_MS = 15000;
const CONFLICT_MESSAGE = "El incidente cambió mientras lo corregías. Revisá y volvé a intentar.";

type Detail = IncidentDetailResponse;
type Editable = "problem_type_id" | "severity" | "priority_band";

const SEVERITY: Record<string, string> = { low: "Baja", medium: "Media", high: "Alta", undetermined: "Sin determinar" };
const PASSAGE: Record<string, string> = { total: "Bloqueado", partial: "Parcialmente obstruido", none: "Libre", undetermined: "Sin determinar" };
const ACCESSIBILITY: Record<string, string> = { affected: "Afectada", not_affected: "No afectada", undetermined: "Sin determinar" };
const PRIORITY_RULE: Record<string, string> = {
  severity_high: "severidad alta",
  active_hazard: "peligro activo",
  passage_blocked: "paso bloqueado",
  accessibility_affected: "accesibilidad afectada",
  severity_medium: "severidad media",
  promoted_by_age: "lleva tiempo sin atender",
};
const FIELD: Record<OverrideField, string> = {
  problem_type_id: "Tipo",
  severity: "Severidad",
  priority_band: "Prioridad",
  location: "Ubicación",
  status: "Estado",
};
const EVENT: Record<string, string> = {
  created: "Incidente creado",
  report_linked: "Reporte asociado",
  report_unlinked: "Reporte desasociado",
  linked: "Reporte asociado a un incidente",
  unlinked: "Reporte desasociado",
  override_set: "Corrección del operador",
  override_removed: "Corrección quitada",
  effective_changed: "Datos del incidente actualizados",
  archived: "Incidente archivado",
  offered: "Orden ofrecida",
  accepted: "Orden aceptada",
  rejected: "Orden rechazada",
  in_progress: "Trabajo iniciado",
  completed: "Orden completada",
  cancelled: "Orden cancelada",
  review_blocked: "Orden bloqueada por revisión",
  operator_action: "Acción del operador sobre la orden",
  unit_action: "Acción de la unidad",
  confirmed: "Reporte confirmado",
  processed: "Reporte procesado",
  grouping_decided: "Agrupación decidida",
};
const ASSIGNMENT_ACTION: Partial<Record<AssignmentAction, { label: string; confirm: string; className: string }>> = {
  complete: { label: "Completar orden", confirm: "¿Marcar la orden como completada?", className: "btn-success" },
  cancel: { label: "Cancelar orden", confirm: "¿Cancelar la orden? La unidad deja de atenderla.", className: "btn-ghost-danger" },
};
const CLOSED = new Set(["resolved", "archived"]);

/** Clave de idempotencia por intento: ver `AttemptKeys` (reintento dentro de una ventana, éxito o rechazo la descartan). */
function useAttemptKeys() {
  const keys = useRef(new AttemptKeys());
  return useCallback(async <T,>(signature: string, version: number, run: (key: string, version: number) => Promise<T>): Promise<T> => {
    const attempt = keys.current.take(signature, version);
    try {
      const r = await run(attempt.key, attempt.version);
      keys.current.settle(signature, "applied");
      return r;
    } catch (err) {
      keys.current.settle(signature, outcomeOf(err));
      throw err;
    }
  }, []);
}

function valueLabel(field: OverrideField, value: unknown, data: Detail): string {
  if (field === "problem_type_id") return data.problemTypes.find((t) => t.id === value)?.name ?? "Tipo no habilitado";
  if (field === "severity") return SEVERITY[String(value)] ?? String(value);
  if (field === "priority_band") return PRIORITY[value as keyof typeof PRIORITY]?.label ?? String(value);
  if (field === "status") return STATUS[value as keyof typeof STATUS] ?? String(value);
  const loc = value as { text?: string; lat?: number; lon?: number } | null;
  return loc?.text ?? (loc ? `${loc.lat?.toFixed(5)}, ${loc.lon?.toFixed(5)}` : "—");
}

/**
 * Todo pedido del detalle tiene tope de tiempo, también las acciones: sin él, uno colgado deja `busy` y los botones
 * deshabilitados para siempre. Un pedido cortado llega como error de red, así que su clave de reintento se conserva
 * (pudo haberse aplicado).
 */
const timed = (signal?: AbortSignal) => withTimeout(signal ?? new AbortController().signal);

const when = (iso: string) => new Date(iso).toLocaleString("es-UY", { dateStyle: "short", timeStyle: "short" });

export function IncidentDetail({ incidentId, territorySlug }: { incidentId: string; territorySlug: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const router = useRouter();
  const attempt = useAttemptKeys();
  const latest = useRef(0);
  const q = `?territory=${encodeURIComponent(territorySlug)}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++latest.current;
    const stale = () => signal?.aborted || id !== latest.current;
    try {
      const d = await api<Detail>(`/api/operacion/incidents/${encodeURIComponent(incidentId)}`, { signal: timed(signal) });
      if (stale()) return;
      setData(d);
      setMissing(false);
      setLoadError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (stale()) return;
      if (err instanceof HttpError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/operacion/incidentes/${incidentId}${q}`)}`);
        return;
      }
      if (err instanceof HttpError && err.status === 404) {
        setData(null); // sin datos viejos ni botones activos junto al aviso
        setMissing(true);
        return;
      }
      setLoadError(errorMessage(err));
    }
  }, [incidentId, q, router]);

  useEffect(() => {
    const ctrl = new AbortController();
    let inFlight = false;
    const run = () => {
      if (inFlight) return;
      inFlight = true;
      void load(ctrl.signal).finally(() => {
        inFlight = false;
      });
    };
    const first = setTimeout(run, 0);
    const t = setInterval(run, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  /** Corre un pedido; un 409 de revisión recarga y avisa, sin tocar lo que el operador eligió. */
  async function act(signature: string, version: number, run: (key: string, version: number) => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await attempt(signature, version, run);
      setNotice(done);
      await load();
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/operacion/incidentes/${incidentId}${q}`)}`);
      } else if (err instanceof HttpError && err.code === "revision_conflict") {
        setError(CONFLICT_MESSAGE);
        await load();
      } else {
        setError(errorMessage(err));
        if (err instanceof HttpError && err.status === 409) await load();
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/operacion/incidents/${encodeURIComponent(incidentId)}`;
  // La firma es lo que el operador quiso hacer (sin revisión ni versión): la revisión vista viaja congelada con la clave.
  const revision = data?.incident.revision ?? 0;
  const setOverride = (override: OverrideValue, reason: string, done: string) =>
    act(`set:${JSON.stringify(override)}:${reason}`, revision, (key, expectedRevision) =>
      api<OverrideResult>(`${base}/overrides`, {
        method: "POST",
        signal: timed(),
        json: { override, reason, expectedRevision, idempotencyKey: key } satisfies SetOverrideBody,
      }), done);
  const removeOverride = (field: OverrideField) =>
    act(`remove:${field}`, revision, (key) => api(`${base}/overrides/${field}`, { method: "DELETE", signal: timed(), json: { idempotencyKey: key } }), `Se quitó la corrección de ${FIELD[field].toLowerCase()}.`);
  const unlink = (reportId: string, reason: string) =>
    act(`unlink:${reportId}:${reason}`, revision, (key) => api(`${base}/links`, { method: "POST", signal: timed(), json: { action: "unlink", reportId, reason, idempotencyKey: key } }), "Reporte desasociado. Quedó en la cola de revisión para asociarlo o crear su incidente.");
  const assignmentAction = (action: AssignmentAction) => {
    const a = data?.activeAssignment;
    if (!a) return Promise.resolve(false);
    return act(`assignment:${a.id}:${action}`, a.version, (key, expectedVersion) =>
      api(`/api/operacion/assignments/${a.id}`, { method: "POST", signal: timed(), json: { action, expectedVersion, idempotencyKey: key } }),
      action === "complete" ? "Orden completada." : "Orden cancelada.");
  };

  const inc = data?.incident;
  return (
    <div className="flex w-full flex-1 flex-col">
      <OpsHeader
        title={inc ? `Incidente ${shortCode(inc.id)}` : "Incidente"}
        subtitle={inc?.title}
        updatedAt={updatedAt}
        offline={!!loadError && !!data}
        actions={
          <Link href={`/operacion${q}`} className="btn ops-btn-ghost">
            <Icon name="arrow" className="rotate-180" /> Volver al centro
          </Link>
        }
      />
      <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-5 px-4 py-5 lg:px-6">
        <div aria-live="polite" className="flex flex-col gap-2">
          {loadError && <p role="alert" className="rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">{loadError}</p>}
          {error && <p role="alert" className="rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">{error}</p>}
          {notice && <p role="status" className="rounded-[var(--radius)] bg-[var(--success-soft)] px-3 py-2 text-[var(--success)]">{notice}</p>}
        </div>
        {missing && (
          <div className="card p-6 text-center">
            <p className="text-lg font-bold">No encontramos este incidente</p>
            <p className="mt-1 text-ink-2">Puede que no exista o que sea de otro territorio.</p>
          </div>
        )}
        {!data && !missing && !loadError && <p className="text-ink-2">Cargando el incidente…</p>}
        {data && inc && (
          <>
            <Summary data={data} />
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
              <div className="flex min-w-0 flex-col gap-5">
                <Reports data={data} busy={busy} closed={CLOSED.has(inc.status)} onUnlink={unlink} />
                <History data={data} />
              </div>
              <div className="flex min-w-0 flex-col gap-5">
                <AssignmentCard data={data} busy={busy} onAction={assignmentAction} />
                <ReviewItems data={data} href={`/operacion/revision${q}`} />
                {CLOSED.has(inc.status) ? (
                  <p className="card p-4 text-ink-2">El incidente está {STATUS[inc.status].toLowerCase()}: ya no se corrige desde acá.</p>
                ) : (
                  <Corrections data={data} busy={busy} onSet={setOverride} onRemove={removeOverride} />
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Summary({ data }: { data: Detail }) {
  const inc = data.incident;
  const area = areaDisplay(inc.area?.name);
  const rules = inc.bandOverride ? ["ajuste manual del operador"] : inc.priorityRules.map((r) => PRIORITY_RULE[r] ?? r);
  const reason = inc.explainPriority ?? (rules.length ? `Por ${rules.join(", ")}.` : "Sin motivos de riesgo registrados.");
  return (
    <section aria-labelledby="resumen" className="card flex flex-col gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityBadge band={inc.priorityBand} />
        <span className="ops-code">{shortCode(inc.id)}</span>
        {inc.activeHazard && <span className="ops-badge ops-badge--high">Peligro activo</span>}
        <span className="ops-chip">{STATUS[inc.status]}</span>
        {inc.dispatchBlocked && <span className="ops-chip">Despacho bloqueado</span>}
      </div>
      <h2 id="resumen" className="text-xl font-bold leading-snug">{inc.title}</h2>
      <p className="text-ink-2">
        <span className="font-semibold text-ink">Prioridad {PRIORITY[inc.priorityBand].label.toLowerCase()}:</span> {reason}
      </p>
      {inc.summary && <p>{inc.summary}</p>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Tipo" value={inc.problemType?.name ?? "Sin determinar"} />
        <Fact label="Severidad" value={SEVERITY[inc.severity]} />
        <Fact label="Paso" value={PASSAGE[inc.passage]} />
        <Fact label="Accesibilidad" value={ACCESSIBILITY[inc.accessibility]} />
        <Fact label="Lugar" value={[inc.locationText, area].filter(Boolean).join(" · ") || "Sin determinar"} />
        <Fact label="Reportes" value={`${inc.reportCount} (${inc.sourceCount} ${inc.sourceCount === 1 ? "persona" : "personas"})`} />
        <Fact label="Creado" value={when(inc.createdAt)} />
        <Fact label="Revisión" value={String(inc.revision)} />
      </dl>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-2">{label}</dt>
      <dd className="font-semibold break-words">{value}</dd>
    </div>
  );
}

function Reports({ data, busy, closed, onUnlink }: { data: Detail; busy: boolean; closed: boolean; onUnlink: (reportId: string, reason: string) => Promise<boolean> }) {
  return (
    <section aria-labelledby="reportes" className="flex flex-col gap-2.5">
      <h2 id="reportes" className="ops-eyebrow px-1">Reportes ({data.reports.length})</h2>
      {data.reports.length === 0 && <p className="card p-4 text-ink-2">No tiene reportes asociados.</p>}
      <ul className="flex flex-col gap-2.5">
        {data.reports.map((r) => (
          <ReportCard key={r.id} report={r} busy={busy} canUnlink={!closed} onUnlink={(reason) => onUnlink(r.id, reason)} />
        ))}
      </ul>
    </section>
  );
}

function ReportCard({ report: r, busy, canUnlink, onUnlink }: { report: Detail["reports"][number]; busy: boolean; canUnlink: boolean; onUnlink: (reason: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const citizen = r.messages.filter((m) => m.role === "citizen");
  return (
    <li className="ops-item flex flex-col gap-2 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-bold">{r.publicCode ?? "Reporte"}</span>
          <span className="ops-chip">{r.linkOrigin === "manual" ? "Asociado a mano" : "Agrupado automáticamente"}</span>
        </div>
        {r.confirmedAt && <span className="text-ink-2">{when(r.confirmedAt)}</span>}
      </div>
      {r.description && <p className="whitespace-pre-line">{r.description}</p>}
      {citizen.length > 1 && (
        <details>
          <summary className="cursor-pointer font-semibold text-accent">Mensajes del ciudadano ({citizen.length})</summary>
          <ol className="mt-2 flex flex-col gap-1.5 border-l-2 border-line pl-3">
            {citizen.map((m, k) => (
              <li key={k}>
                <span className="text-ink-2">{when(m.createdAt)} · </span>
                <span className="whitespace-pre-line">{m.body}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {r.photoIds.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Fotos del reporte">
          {r.photoIds.map((p, k) => (
            <li key={p}>
              <a href={`/api/operacion/photos/${p}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[var(--r-md)] border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element -- foto privada servida por la API con sesión, sin optimizador */}
                <img src={`/api/operacion/photos/${p}?size=thumb`} alt={`Foto ${k + 1} del reporte ${r.publicCode ?? ""}`} width={96} height={96} className="h-24 w-24 object-cover" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {canUnlink && !open && (
        <div>
          <button type="button" className="btn ops-btn-ghost" onClick={() => setOpen(true)} disabled={busy}>
            Desasociar
          </button>
        </div>
      )}
      {canUnlink && open && (
        <form
          className="flex flex-col gap-2 border-t border-line pt-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onUnlink(reason.trim())) {
              setOpen(false);
              setReason("");
            }
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Motivo para desasociar (obligatorio)</span>
            <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="Por ejemplo: es otro pozo, a dos cuadras" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-ghost-danger" disabled={busy || reason.trim().length < 3}>Desasociar reporte</button>
            <button type="button" className="btn ops-btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
          </div>
        </form>
      )}
    </li>
  );
}

function AssignmentCard({ data, busy, onAction }: { data: Detail; busy: boolean; onAction: (a: AssignmentAction) => Promise<boolean> }) {
  const a = data.activeAssignment;
  return (
    <section aria-labelledby="orden" className="card flex flex-col gap-2 p-4">
      <h2 id="orden" className="ops-eyebrow">Orden activa</h2>
      {!a && <p className="text-ink-2">No tiene una orden activa.</p>}
      {a && (
        <>
          <p className="flex items-center gap-2 font-semibold">
            <Icon name="crew" /> {a.unitName}
          </p>
          <p className="text-ink-2">
            Orden {ASSIGNMENT_STATUS[a.status] ?? a.status} · desde {when(a.offeredAt)}
            {a.reviewBlocked && <span className="block font-semibold text-warn">Bloqueada por revisión: no se puede iniciar ni completar.</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            {allowedActions(a.status, "operator", a.reviewBlocked).map((act) => {
              const meta = ASSIGNMENT_ACTION[act];
              if (!meta) return null;
              return (
                <button key={act} type="button" className={`btn ${meta.className}`} disabled={busy} onClick={() => window.confirm(meta.confirm) && void onAction(act)}>
                  {meta.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function ReviewItems({ data, href }: { data: Detail; href: string }) {
  if (!data.openReviewItems.length) return null;
  return (
    <section aria-labelledby="revision" className="card flex flex-col gap-2 border-warn p-4">
      <h2 id="revision" className="ops-eyebrow">Revisión pendiente</h2>
      <ul className="flex flex-col gap-1">
        {data.openReviewItems.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-warn">
            <Icon name="help" size={18} /> <span className="font-semibold first-letter:uppercase">{REVIEW_KIND[r.kind] ?? r.kind}</span>
            <span className="text-ink-2">· {when(r.createdAt)}</span>
          </li>
        ))}
      </ul>
      <Link href={href} className="font-semibold text-accent underline">Resolver en la cola de revisión</Link>
    </section>
  );
}

function Corrections({
  data, busy, onSet, onRemove,
}: {
  data: Detail;
  busy: boolean;
  onSet: (o: OverrideValue, reason: string, done: string) => Promise<boolean>;
  onRemove: (field: OverrideField) => Promise<boolean>;
}) {
  // La selección y el motivo son del operador: una recarga (polling o 409) no los borra.
  const [field, setField] = useState<Editable>("severity");
  const [value, setValue] = useState<Record<Editable, string>>({ problem_type_id: "", severity: "", priority_band: "" });
  const [reason, setReason] = useState("");
  const [resolveReason, setResolveReason] = useState("");
  const options: Record<Editable, [string, string][]> = {
    problem_type_id: data.problemTypes.map((t) => [t.id, t.name]),
    severity: (["low", "medium", "high"] as const).map((s) => [s, SEVERITY[s]]),
    priority_band: (["high", "medium", "low"] as const).map((b) => [b, PRIORITY[b].label]),
  };
  const chosen = value[field];
  const removable = data.overrides.filter((o) => o.field !== "status" && o.field !== "location");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const override = { field, value: chosen } as OverrideValue;
    const label = options[field].find(([v]) => v === chosen)?.[1] ?? chosen;
    if (await onSet(override, reason.trim(), `${FIELD[field]} corregido: ${label}.`)) {
      setReason("");
      setValue((v) => ({ ...v, [field]: "" }));
    }
  }

  return (
    <section aria-labelledby="corregir" className="card flex flex-col gap-4 p-4">
      <h2 id="corregir" className="ops-eyebrow">Corregir datos</h2>

      {removable.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Correcciones vigentes">
          {removable.map((o) => (
            <li key={o.field} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] bg-surface-2 px-3 py-2">
              <span>
                <span className="font-semibold">{FIELD[o.field]}: {valueLabel(o.field, o.value, data)}</span>
                <span className="block text-ink-2">«{o.reason}» · {when(o.createdAt)}</span>
              </span>
              <button type="button" className="btn ops-btn-ghost" disabled={busy} onClick={() => void onRemove(o.field)}>
                Quitar corrección
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="flex flex-col gap-2" onSubmit={submit}>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-semibold">Campo</span>
            <select className="ops-select max-w-none" value={field} onChange={(e) => setField(e.target.value as Editable)}>
              <option value="problem_type_id">Tipo</option>
              <option value="severity">Severidad</option>
              <option value="priority_band">Prioridad</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-semibold">Nuevo valor</span>
            <select className="ops-select max-w-none" value={chosen} onChange={(e) => setValue((v) => ({ ...v, [field]: e.target.value }))} required>
              <option value="">Elegí…</option>
              {options[field].map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Motivo (obligatorio)</span>
          <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="Por ejemplo: visto en el lugar" />
        </label>
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !chosen || reason.trim().length < 3}>Guardar corrección</button>
        </div>
      </form>

      <form
        className="flex flex-col gap-2 border-t border-line pt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const closes = data.activeAssignment ? " La orden activa se cierra en el mismo paso." : "";
          if (!window.confirm(`¿Marcar el incidente como resuelto?${closes}`)) return;
          if (await onSet({ field: "status", value: "resolved" }, resolveReason.trim(), "Incidente marcado como resuelto.")) setResolveReason("");
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Motivo del cierre (obligatorio)</span>
          <input className="field" value={resolveReason} onChange={(e) => setResolveReason(e.target.value)} minLength={3} maxLength={500} required placeholder="Por ejemplo: la cuadrilla confirmó el arreglo" />
        </label>
        <div>
          <button type="submit" className="btn btn-success" disabled={busy || resolveReason.trim().length < 3}>
            <Icon name="check" /> Marcar resuelto
          </button>
        </div>
      </form>
    </section>
  );
}

function History({ data }: { data: Detail }) {
  return (
    <section aria-labelledby="historial" className="flex flex-col gap-2.5">
      <h2 id="historial" className="ops-eyebrow px-1">Historial</h2>
      {data.events.length === 0 ? (
        <p className="card p-4 text-ink-2">Sin eventos registrados.</p>
      ) : (
        <ol className="card flex flex-col divide-y divide-[var(--line)] p-0">
          {data.events.map((e, k) => (
            <li key={k} className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2">
              <span className="font-medium">{EVENT[e.kind] ?? e.kind}</span>
              <span className="text-ink-2">
                {e.actorType === "operator" ? "Operador" : e.actorType === "unit" ? "Unidad" : e.actorType === "citizen" ? "Ciudadano" : "Sistema"} · {when(e.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
