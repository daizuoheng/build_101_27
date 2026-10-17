"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { IncidentListItem, IncidentListResponse } from "@/shared/contracts/incident";
import { HttpError, api, errorMessage } from "@/app/_components/http";
import { PRIORITY, REVIEW_KIND, STATUS, age } from "./labels";

const LeafletMap = dynamic(() => import("@/app/_components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="h-full min-h-[320px] animate-pulse rounded-[var(--radius)] bg-surface-2" aria-hidden />,
});

const REFRESH_MS = 10000;

type Filters = { areaId: string; problemType: string; priorityBand: string; status: string; sort: "priority" | "recent" | "reports" };
const EMPTY: Filters = { areaId: "", problemType: "", priorityBand: "", status: "", sort: "priority" };

export function IncidentBoard({ territorySlug }: { territorySlug: string }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [data, setData] = useState<IncidentListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const router = useRouter();

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ territory: territorySlug, sort: filters.sort });
    for (const k of ["areaId", "problemType", "priorityBand", "status"] as const) if (filters[k]) qs.set(k, filters[k]);
    try {
      const d = await api<IncidentListResponse>(`/api/operacion/incidents?${qs}`);
      setData(d);
      setError(null);
      setNow(Date.now());
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/operacion?territory=${territorySlug}`)}`);
        return;
      }
      setError(errorMessage(err));
    }
  }, [territorySlug, filters, router]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const incidents = data?.incidents ?? [];
  const areaLabel = data?.territory.areaLabel ?? "Área";

  return (
    <div className="flex w-full flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-3">
        <div>
          <h1 className="text-xl font-bold">Incidentes{data ? ` · ${data.territory.name}` : ""}</h1>
          <p className="text-sm text-ink-2" role="status">
            {data ? `${incidents.length} incidentes · actualizado ${new Date(data.generatedAt).toLocaleTimeString("es-UY")}` : "Cargando…"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/operacion/plan?territory=${encodeURIComponent(territorySlug)}`} className="btn">Plan de atención</Link>
          <button type="button" className="btn" onClick={load}>Actualizar</button>
        </div>
      </header>

      <form className="flex flex-wrap gap-3 border-b border-line px-4 py-3" aria-label="Filtros" onSubmit={(e) => e.preventDefault()}>
        <Select label={areaLabel} value={filters.areaId} onChange={set("areaId")}
          options={(data?.filters.areas ?? []).map((a) => [a.id, a.name])} />
        <Select label="Tipo" value={filters.problemType} onChange={set("problemType")}
          options={(data?.filters.problemTypes ?? []).map((t) => [t.slug, t.name])} />
        <Select label="Prioridad" value={filters.priorityBand} onChange={set("priorityBand")}
          options={Object.entries(PRIORITY).map(([k, v]) => [k, v.label])} />
        <Select label="Estado" value={filters.status} onChange={set("status")}
          options={Object.entries(STATUS).map(([k, v]) => [k, v])} />
        <Select label="Orden" value={filters.sort} onChange={set("sort")} includeAll={false}
          options={[["priority", "Prioridad"], ["recent", "Más recientes"], ["reports", "Más reportes"]]} />
        {Object.entries(filters).some(([k, v]) => k !== "sort" && v) && (
          <button type="button" className="btn self-end" onClick={() => setFilters((f) => ({ ...EMPTY, sort: f.sort }))}>
            Limpiar filtros
          </button>
        )}
      </form>

      {error && <p role="alert" className="mx-4 mt-3 rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">{error}</p>}

      <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label="Lista de incidentes" className="flex flex-col gap-2">
          {data && incidents.length === 0 && (
            <p className="card p-4 text-ink-2">No hay incidentes con estos filtros.</p>
          )}
          <ul className="flex flex-col gap-2">
            {incidents.map((i) => (
              <IncidentRow key={i.id} item={i} now={now} areaLabel={areaLabel} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
            ))}
          </ul>
        </section>
        <aside aria-label="Mapa de incidentes" className="order-first h-[320px] lg:order-none lg:sticky lg:top-4 lg:h-[calc(100vh-12rem)]">
          {data && (
            <LeafletMap
              label="Mapa de incidentes"
              center={data.territory.center}
              zoom={data.territory.zoom}
              height={9999}
              markers={incidents.map((i) => ({
                id: i.id,
                lon: i.lon,
                lat: i.lat,
                tone: i.priorityBand,
                label: `${PRIORITY[i.priorityBand].label} · ${i.title}`,
                onClick: () => {
                  setSelected(i.id);
                  document.getElementById(`inc-${i.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                },
              }))}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function Select({
  label, value, onChange, options, includeAll = true,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: [string, string][];
  includeAll?: boolean;
}) {
  return (
    <label className="flex min-w-[10rem] flex-col gap-1 text-sm font-semibold">
      {label}
      <select className="field font-normal" value={value} onChange={onChange}>
        {includeAll && <option value="">Todos</option>}
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
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
  const p = PRIORITY[item.priorityBand];
  return (
    <li
      id={`inc-${item.id}`}
      className={`card flex gap-3 p-3 ${selected ? "outline outline-3 outline-[var(--focus)]" : ""}`}
      onClick={onSelect}
    >
      <div className="flex w-20 shrink-0 flex-col items-center justify-center rounded-[var(--radius)] bg-surface-2 py-2"
        style={{ color: `var(--prio-${item.priorityBand})` }}>
        <span aria-hidden className="text-2xl leading-none">{p.symbol}</span>
        <span className="text-sm font-bold">{p.label}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.activeHazard && (
            <span className="rounded-full bg-danger px-2 py-0.5 text-sm font-bold text-white">⚠ Peligro activo</span>
          )}
          <h2 className="font-bold">{item.title}</h2>
        </div>
        <p className="text-sm text-ink-2">
          {item.problemType?.name ?? "Tipo sin determinar"} · {areaLabel}: {item.area?.name ?? "sin determinar"}
          {item.locationText ? ` · ${item.locationText}` : ""}
        </p>
        <p className="text-sm">
          <span className="font-semibold">{STATUS[item.status]}</span>
          {" · "}{item.reportCount} {item.reportCount === 1 ? "reporte" : "reportes"}
          {" · "}{item.sourceCount} {item.sourceCount === 1 ? "fuente estimada" : "fuentes estimadas"}
          {" · "}hace {age(item.createdAt, now)}
          {item.dispatchBlocked && <span className="text-warn"> · despacho bloqueado</span>}
        </p>
        {item.openReviewKinds.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Revisiones abiertas">
            {item.openReviewKinds.map((k) => (
              <li key={k} className="rounded-full bg-warn-soft px-2 py-0.5 text-sm font-semibold text-warn">
                Revisión: {REVIEW_KIND[k] ?? k}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
