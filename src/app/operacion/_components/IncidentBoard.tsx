"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { IncidentListItem, IncidentListResponse } from "@/shared/contracts/incident";
import { HttpError, api, errorMessage } from "@/app/_components/http";
import { Icon, type IconName } from "./Icons";
import { PLAN_ITEM_STATUS, PRIORITY, REVIEW_KIND, STATUS, age, areaDisplay, shortCode, versusYesterday } from "./labels";
import { FilterSelect, KpiCard, OpsHeader, PriorityBadge, SearchBox } from "./OpsShell";

const LeafletMap = dynamic(() => import("@/app/_components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="h-[420px] animate-pulse rounded-[var(--radius)] bg-surface-2" aria-hidden />,
});

const REFRESH_MS = 10000;

type Filters = { areaId: string; problemType: string; priorityBand: string; status: string; sort: "priority" | "recent" | "reports" };
const EMPTY: Filters = { areaId: "", problemType: "", priorityBand: "", status: "", sort: "priority" };

const ACTIVE = new Set<IncidentListItem["status"]>(["open", "assigned", "in_progress"]);

/** Contadores del encabezado sobre el universo sin filtros (ALCANCE §7: pendientes, por revisar y resueltos). */
function summarize(all: IncidentListItem[], now: number) {
  const day = (offset: number) => new Date(now - offset * 86_400_000).toDateString();
  const resolvedOn = (d: string) => all.filter((i) => i.status === "resolved" && new Date(i.updatedAt).toDateString() === d).length;
  const active = all.filter((i) => ACTIVE.has(i.status));
  return {
    active: active.length,
    activeHigh: active.filter((i) => i.priorityBand === "high").length,
    review: all.filter((i) => i.openReviewKinds.length > 0).length,
    resolvedToday: resolvedOn(day(0)),
    resolvedYesterday: resolvedOn(day(1)),
  };
}

const DESKTOP = "(min-width: 1024px)";
function subscribeDesktop(cb: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/** En escritorio el mapa vive en la barra lateral; en pantallas chicas se abre debajo del título de la bandeja. */
function useDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP).matches, () => false);
}

export function IncidentBoard({ territorySlug }: { territorySlug: string }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [search, setSearch] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [data, setData] = useState<IncidentListResponse | null>(null);
  const [all, setAll] = useState<IncidentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [mapSlot, setMapSlot] = useState<HTMLElement | null>(null);
  const desktop = useDesktop();
  const router = useRouter();

  useEffect(() => {
    const t = setTimeout(() => setMapSlot(document.getElementById("ops-sidebar-map")), 0);
    return () => clearTimeout(t);
  }, []);

  const filtered = Object.entries(filters).some(([k, v]) => k !== "sort" && v);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ territory: territorySlug, sort: filters.sort });
    for (const k of ["areaId", "problemType", "priorityBand", "status"] as const) if (filters[k]) qs.set(k, filters[k]);
    try {
      const [d, base] = await Promise.all([
        api<IncidentListResponse>(`/api/operacion/incidents?${qs}`),
        // Los contadores no dependen de los filtros: sin filtros se reutiliza la misma respuesta.
        filtered ? api<IncidentListResponse>(`/api/operacion/incidents?${new URLSearchParams({ territory: territorySlug })}`) : null,
      ]);
      setData(d);
      setAll((base ?? d).incidents);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/operacion?territory=${territorySlug}`)}`);
        return;
      }
      setError(errorMessage(err));
    }
  }, [territorySlug, filters, filtered, router]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const areaLabel = data?.territory.areaLabel ?? "Área";
  const term = search.trim().toLocaleLowerCase("es");
  const incidents = useMemo(() => {
    const list = data?.incidents ?? [];
    if (!term) return list;
    return list.filter((i) => [i.title, i.locationText, i.area?.name, i.problemType?.name, shortCode(i.id)].some((s) => s?.toLocaleLowerCase("es").includes(term)));
  }, [data, term]);
  const kpi = all && updatedAt ? summarize(all, updatedAt) : null;
  const total = data?.incidents.length ?? 0;

  const map = data && (
    <LeafletMap
      label="Mapa de incidentes"
      center={data.territory.center}
      zoom={data.territory.zoom}
      height={desktop ? 360 : 420}
      markers={incidents.map((i) => ({
        id: i.id,
        lon: i.lon,
        lat: i.lat,
        tone: i.priorityBand,
        label: `${PRIORITY[i.priorityBand].label} · ${i.title}`,
        onClick: () => {
          setSelected(i.id);
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          document.getElementById(`inc-${i.id}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
        },
      }))}
    />
  );

  return (
    <div className="flex w-full flex-1 flex-col">
      <OpsHeader title="Centro de Operaciones" subtitle={data?.territory.name} updatedAt={updatedAt} offline={!!error && !!data} />

      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 px-4 py-5 lg:px-6">
        {error && <p role="alert" className="rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">{error}</p>}

        <section aria-label="Resumen" className="grid grid-cols-3 gap-2 sm:gap-4">
          <KpiCard label="Abiertos y en curso" value={kpi?.active ?? "—"} detail={kpi ? `${kpi.activeHigh} alta prioridad` : null} icon="alert" tone="danger" />
          <KpiCard label="Por revisar" value={kpi?.review ?? "—"} detail={kpi ? "requieren validación" : null} icon="help" tone="warn" />
          <KpiCard label="Resueltos hoy" value={kpi?.resolvedToday ?? "—"} detail={kpi ? versusYesterday(kpi.resolvedToday, kpi.resolvedYesterday) : null} icon="check" tone="success" />
        </section>

        <form className="card flex flex-wrap items-center gap-3 p-3" aria-label="Búsqueda y filtros" onSubmit={(e) => e.preventDefault()}>
          <SearchBox value={search} onChange={setSearch} placeholder="Buscar por calle, barrio, tipo o código (#…)" />
          <div className="ops-filters flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <span className="ops-eyebrow">Filtros:</span>
            <FilterSelect label="Prioridad" value={filters.priorityBand} onChange={set("priorityBand")}
              options={Object.entries(PRIORITY).map(([k, v]) => [k, v.label])} />
            <FilterSelect label={areaLabel} value={filters.areaId} onChange={set("areaId")}
              options={(data?.filters.areas ?? []).map((a) => [a.id, areaDisplay(a.name) ?? a.name])} />
            <FilterSelect label="Estado" value={filters.status} onChange={set("status")}
              options={Object.entries(STATUS).map(([k, v]) => [k, v])} />
            <FilterSelect label="Tipo" value={filters.problemType} onChange={set("problemType")}
              options={(data?.filters.problemTypes ?? []).map((t) => [t.slug, t.name])} />
            <button
              type="button"
              className="btn ops-btn-ghost"
              aria-label="Restablecer filtros"
              title="Restablecer filtros"
              disabled={!filtered && !search}
              onClick={() => {
                setFilters((f) => ({ ...EMPTY, sort: f.sort }));
                setSearch("");
              }}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </form>

        <section aria-labelledby="bandeja" className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <h2 id="bandeja" className="ops-eyebrow">
              Bandeja priorizada{data ? ` (${incidents.length} de ${total})` : ""}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {!desktop && (
                <button type="button" className="btn ops-btn-ghost" aria-pressed={showMap} onClick={() => setShowMap((v) => !v)}>
                  <Icon name="map" /> {showMap ? "Ocultar mapa" : "Ver mapa"}
                </button>
              )}
              <label className="flex items-center gap-2 text-ink-2">
                Ordenado por
                <select className="ops-select" value={filters.sort} onChange={set("sort")}>
                  <option value="priority">criticidad</option>
                  <option value="recent">más recientes</option>
                  <option value="reports">más reportes</option>
                </select>
              </label>
            </div>
          </div>

          {!desktop && showMap && map && <div className="card overflow-hidden p-1">{map}</div>}
          {desktop && mapSlot && map && createPortal(map, mapSlot)}

          {data && incidents.length === 0 && <p className="card p-4 text-ink-2">No hay incidentes con estos filtros.</p>}
          <ul className="flex flex-col gap-2.5">
            {incidents.map((i) => (
              <IncidentRow key={i.id} item={i} now={updatedAt ?? 0} areaLabel={areaLabel} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

/** Estado operativo del pie de la tarjeta: lo que el operador tiene que saber primero. */
function footerStatus(item: IncidentListItem): { text: string; icon: IconName; className: string } {
  if (item.openReviewKinds.length > 0)
    return { text: `Por revisar (${item.openReviewKinds.map((k) => REVIEW_KIND[k] ?? k).join(", ")})`, icon: "help", className: "text-warn" };
  if (item.dispatchBlocked) return { text: "Despacho bloqueado", icon: "block", className: "text-warn" };
  switch (item.status) {
    case "open":
      return { text: PLAN_ITEM_STATUS.blocked, icon: "alert", className: "text-danger" };
    case "assigned":
      return { text: STATUS.assigned, icon: "crew", className: "text-accent" };
    case "in_progress":
      return { text: STATUS.in_progress, icon: "crew", className: "text-accent" };
    case "resolved":
      return { text: STATUS.resolved, icon: "check", className: "text-[var(--success)]" };
    default:
      return { text: STATUS[item.status], icon: "clock", className: "text-ink-2" };
  }
}

function IncidentRow({
  item, now, areaLabel, selected, onSelect,
}: {
  item: IncidentListItem;
  now: number;
  areaLabel: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const f = footerStatus(item);
  const area = areaDisplay(item.area?.name);
  const place = [area ? `${areaLabel} ${area}` : `${areaLabel} sin determinar`, item.locationText].filter(Boolean).join(" · ");
  return (
    <li id={`inc-${item.id}`} className="ops-item px-4 py-3.5" data-selected={selected}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge band={item.priorityBand} />
          <span className="ops-code">{shortCode(item.id)}</span>
          {item.activeHazard && <span className="ops-badge ops-badge--high">Peligro activo</span>}
          {item.reportCount > 1 && <span className="ops-chip">{item.reportCount} agrupados</span>}
        </div>
        <span className="text-ink-2">Hace {age(item.createdAt, now)}</span>
      </div>
      <h3 className="text-lg font-semibold leading-snug">
        <button type="button" className="ops-item-action text-left" aria-pressed={selected} onClick={onSelect}>
          {item.title}
        </button>
      </h3>
      <p className="mt-0.5 text-ink-2">{place}</p>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
        <span className={`flex items-center gap-1.5 font-medium ${f.className}`}>
          <Icon name={f.icon} size={18} /> {f.text}
        </span>
        <span className="font-medium text-ink-2">{item.problemType?.name ?? "Tipo sin determinar"}</span>
      </div>
    </li>
  );
}
