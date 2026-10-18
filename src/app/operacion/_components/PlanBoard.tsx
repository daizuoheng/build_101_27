"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IncidentListResponse } from "@/shared/contracts/incident";
import type { PlanItemView, PlanResponse } from "@/shared/contracts/plan";
import { HttpError, api, errorMessage } from "@/app/_components/http";
import {
  ASSIGNMENT_STATUS, PLAN_ITEM_STATUS, PLAN_PENDING_REASON, PLAN_PROPOSAL_REASON, PLAN_TRIGGER, PRIORITY, STATUS, areaDisplay, hours, shortCode,
} from "./labels";
import { Icon } from "./Icons";
import { FilterSelect, KpiCard, OpsHeader, PriorityBadge, SearchBox } from "./OpsShell";

const REFRESH_MS = 10000;
const EMPTY_VIEW = { band: "", area: "", status: "", type: "" };

type ItemState = { kind: "assigned" | "proposed" | "closed" | "pending"; label: string; reasons: string[] };

/**
 * Situación de un ítem del plan para la vista. Tiene unidad si hay orden activa o propuesta todavía sin enviar; un
 * incidente resuelto o archivado ya no espera cuadrilla. El resto sigue pendiente hasta el próximo plan: un ítem
 * `blocked` u `obsolete` conserva la unidad propuesta aunque el despacho la haya descartado, y uno `executed` cuya
 * orden se cerró (rechazada, cancelada) sin resolver el incidente tampoco tiene unidad.
 */
function itemState(i: PlanItemView): ItemState {
  if (i.assignedUnit) {
    // Los motivos explican la unidad propuesta: si la orden activa es de otra (asignación manual), no aplican.
    const reasons = i.assignedUnit.id === i.proposedUnit?.id ? i.reasons : [];
    return { kind: "assigned", label: `${i.assignedUnit.name} · orden ${ASSIGNMENT_STATUS[i.assignedUnit.status] ?? i.assignedUnit.status}`, reasons };
  }
  if (i.incident.status === "resolved" || i.incident.status === "archived") {
    return { kind: "closed", label: `Incidente ${STATUS[i.incident.status].toLocaleLowerCase("es")}`, reasons: [] };
  }
  if (i.proposedUnit && i.status === "proposed") {
    return { kind: "proposed", label: `${PLAN_ITEM_STATUS.proposed}: ${i.proposedUnit.name}`, reasons: i.reasons };
  }
  // Los motivos de la propuesta original no explican por qué sigue pendiente: si el despacho la descartó, el motivo
  // es el del descarte; si la orden enviada ya se cerró, no hay otro.
  if (i.status === "executed" && i.proposedUnit) {
    return { kind: "pending", label: `${PLAN_ITEM_STATUS.blocked} · orden a ${i.proposedUnit.name} cerrada`, reasons: [] };
  }
  return { kind: "pending", label: PLAN_ITEM_STATUS.blocked, reasons: i.proposedUnit && i.blockedReason ? [i.blockedReason] : i.reasons };
}

const ITEM_STYLE: Record<ItemState["kind"], { tone: string; icon: "crew" | "arrow" | "check" | "alert" }> = {
  assigned: { tone: "text-accent", icon: "crew" },
  proposed: { tone: "text-[var(--success)]", icon: "arrow" },
  closed: { tone: "text-ink-2", icon: "check" },
  pending: { tone: "text-danger", icon: "alert" },
};

/** Opciones de filtro del territorio. El plan expone área y tipo por nombre, así que se filtra por nombre. */
type Catalog = { areaLabel: string; areas: string[]; problemTypes: string[] };

/** Vista «Plan de atención» (ALCANCE §6): proyección de solo lectura del último plan; recalcular solo encola el job. */
export function PlanBoard({ territorySlug }: { territorySlug: string }) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [view, setViewState] = useState(EMPTY_VIEW);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const router = useRouter();
  // Solo la última carga pedida escribe el estado: una respuesta lenta de un pedido anterior no pisa a una más nueva.
  const latest = useRef(0);

  const onAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof HttpError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/operacion/plan?territory=${territorySlug}`)}`);
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
      try {
        const d = await api<PlanResponse>(`/api/operacion/plan?${new URLSearchParams({ territory: territorySlug })}`, { signal });
        if (stale()) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (!stale() && !onAuthError(err)) setError(errorMessage(err));
      }
    },
    [territorySlug, onAuthError],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    const run = () => void load(ctrl.signal);
    const first = setTimeout(run, 0);
    const t = setInterval(run, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  // Opciones completas de los filtros (todas las áreas y tipos habilitados del territorio), no solo las presentes en el plan.
  // Se reutiliza la respuesta del listado de incidentes pidiendo solo archivados para que la lista venga corta.
  useEffect(() => {
    let alive = true;
    api<IncidentListResponse>(`/api/operacion/incidents?${new URLSearchParams({ territory: territorySlug, status: "archived" })}`)
      .then((r) => {
        if (alive)
          setCatalog({ areaLabel: r.territory.areaLabel, areas: r.filters.areas.map((a) => a.name), problemTypes: r.filters.problemTypes.map((t) => t.name) });
      })
      .catch((err) => {
        if (alive && !onAuthError(err)) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [territorySlug, onAuthError]);

  async function replan() {
    setRequesting(true);
    setNotice(null);
    try {
      const r = await api<{ jobId: string; created: boolean }>("/api/operacion/plan", { method: "POST", json: { territory: territorySlug } });
      setNotice(r.created ? "Recálculo pedido. El plan nuevo aparece acá cuando termine." : "Ya hay un recálculo en curso. El plan nuevo aparece acá cuando termine.");
      setError(null);
    } catch (err) {
      if (!onAuthError(err)) setError(errorMessage(err));
    } finally {
      setRequesting(false);
    }
  }

  const run = data?.planRun ?? null;
  const items = data?.items ?? [];
  const states = items.map(itemState);
  const withUnit = states.filter((st) => st.kind === "assigned" || st.kind === "proposed").length;
  const pending = states.filter((st) => st.kind === "pending").length;
  const high = items.filter((i, k) => states[k].kind !== "closed" && (i.incident.priorityBand === "high" || i.incident.activeHazard)).length;

  // Filtros de visualización: proyectan el plan completo, nunca cambian lo que planifica el backend (ARQUITECTURA §Planificador).
  const asOptions = (values: string[] | undefined) => (values ?? []).map((v) => [v, areaDisplay(v) ?? v] as [string, string]);
  const term = search.trim().toLocaleLowerCase("es");
  const visible = items.filter(
    (i) =>
      (!view.band || i.incident.priorityBand === view.band) &&
      (!view.area || i.incident.areaName === view.area) &&
      (!view.status || i.incident.status === view.status) &&
      (!view.type || i.incident.problemType === view.type) &&
      (!term ||
        [i.incident.title, i.incident.areaName, i.incident.problemType, i.proposedUnit?.name, i.assignedUnit?.name, shortCode(i.incident.id)].some((s) =>
          s?.toLocaleLowerCase("es").includes(term),
        )),
  );
  const setView = (k: keyof typeof EMPTY_VIEW) => (e: React.ChangeEvent<HTMLSelectElement>) => setViewState((v) => ({ ...v, [k]: e.target.value }));
  const anyFilter = !!term || Object.values(view).some(Boolean);

  return (
    <div className="flex w-full flex-1 flex-col">
      <OpsHeader
        title="Plan de atención"
        subtitle={run ? `Política v${run.policyVersion} · calculado ${new Date(run.computedAt).toLocaleString("es-UY")}` : null}
        updatedAt={updatedAt}
        offline={!!error && !!data}
        actions={
          <button type="button" className="btn btn-primary" onClick={replan} disabled={requesting}>
            <Icon name="refresh" /> {requesting ? "Pidiendo…" : "Actualizar plan"}
          </button>
        }
      />

      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 px-4 py-5 lg:px-6">
        {notice && <p role="status" className="rounded-[var(--radius)] bg-info-soft px-3 py-2">{notice}</p>}
        {error && <p role="alert" className="rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">{error}</p>}

        <section aria-label="Resumen del plan" className="grid grid-cols-3 gap-2 sm:gap-4">
          <KpiCard label="En la cola" value={run ? items.length : "—"} detail={run ? `${high} alta prioridad o peligro` : null} icon="list" tone="info" />
          <KpiCard label="Con cuadrilla" value={run ? withUnit : "—"} detail={run ? "propuesta o asignada" : null} icon="crew" tone="success" />
          <KpiCard label="Pendientes de cuadrilla" value={run ? pending : "—"} detail={run && pending ? "motivo en cada caso" : null} icon="alert" tone="danger" />
        </section>

        <form className="card flex flex-wrap items-center gap-3 p-3" aria-label="Búsqueda y filtros del plan" onSubmit={(e) => e.preventDefault()}>
          <SearchBox value={search} onChange={setSearch} placeholder="Buscar por calle, barrio, tipo, cuadrilla o código (#…)" />
          <div className="ops-filters flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <span className="ops-eyebrow">Filtros:</span>
            <FilterSelect label="Prioridad" value={view.band} onChange={setView("band")} options={Object.entries(PRIORITY).map(([k, v]) => [k, v.label])} />
            <FilterSelect label={catalog?.areaLabel ?? "Área"} value={view.area} onChange={setView("area")} options={asOptions(catalog?.areas)} />
            <FilterSelect label="Estado" value={view.status} onChange={setView("status")} options={Object.entries(STATUS).map(([k, v]) => [k, v])} />
            <FilterSelect label="Tipo" value={view.type} onChange={setView("type")} options={asOptions(catalog?.problemTypes)} />
            <button
              type="button"
              className="btn ops-btn-ghost"
              aria-label="Restablecer filtros"
              title="Restablecer filtros"
              disabled={!anyFilter}
              onClick={() => {
                setViewState(EMPTY_VIEW);
                setSearch("");
              }}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </form>

        <section aria-labelledby="cola" className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <h2 id="cola" className="ops-eyebrow">Orden recomendado{run ? ` (${visible.length} de ${items.length})` : ""}</h2>
            {run && <span className="text-ink-2">Disparado por {PLAN_TRIGGER[run.trigger] ?? run.trigger}</span>}
          </div>
          {data && !run && (
            <div className="card p-6 text-center">
              <p className="text-lg font-bold">Todavía no hay un plan calculado</p>
              <p className="mt-1 text-ink-2">Cuando el sistema calcule el primer plan vas a ver acá el orden recomendado, la unidad propuesta y los motivos.</p>
            </div>
          )}
          {run && items.length === 0 && <p className="card p-4 text-ink-2">El plan no tiene incidentes abiertos.</p>}
          {run && items.length > 0 && visible.length === 0 && <p className="card p-4 text-ink-2">No hay incidentes del plan con estos filtros.</p>}
          <ol className="flex flex-col gap-2.5">
            {visible.map((it) => (
              <PlanRow key={it.incident.id} item={it} />
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}

function PlanRow({ item }: { item: PlanItemView }) {
  const state = itemState(item);
  const style = ITEM_STYLE[state.kind];
  const reasonLabels = state.reasons.map((r) => PLAN_PROPOSAL_REASON[r] ?? PLAN_PENDING_REASON[r] ?? r);
  return (
    <li className="ops-item px-4 py-3.5">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-lg font-bold">
            <span className="sr-only">Puesto </span>{item.position}º
          </span>
          <PriorityBadge band={item.incident.priorityBand} />
          <span className="ops-code">{shortCode(item.incident.id)}</span>
          {item.incident.activeHazard && <span className="ops-badge ops-badge--high">Peligro activo</span>}
        </div>
        <span className="text-ink-2">Espera {hours(item.score.waitHours)}</span>
      </div>
      <h3 className="text-lg font-semibold leading-snug">{item.incident.title}</h3>
      <p className="mt-0.5 text-ink-2">
        {areaDisplay(item.incident.areaName) ?? "Zona sin determinar"} · {STATUS[item.incident.status as keyof typeof STATUS] ?? item.incident.status}
      </p>
      <p className="mt-1 text-ink-2">
        {item.score.sources} {item.score.sources === 1 ? "fuente" : "fuentes"} · +{hours(item.score.bonusHours)} por corroboración · total {hours(item.score.score)}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
        <span className={`flex flex-wrap items-center gap-1.5 font-medium ${style.tone}`}>
          <Icon name={style.icon} size={18} />
          {state.label}
        </span>
        <span className="font-medium text-ink-2">{item.incident.problemType ?? "Tipo sin determinar"}</span>
      </div>
      {(item.explanation || reasonLabels.length > 0) && (
        <p className={`mt-1 ${state.kind === "pending" ? "text-warn" : "text-ink-2"}`}>{item.explanation ?? `Motivo: ${reasonLabels.join(" · ")}`}</p>
      )}
    </li>
  );
}
