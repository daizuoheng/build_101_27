"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { PriorityBand } from "@/shared/contracts/plan";
import { BrandMark, Icon, type IconName } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";
import { PRIORITY } from "./labels";

// Piezas compartidas de la consola de Operación (diseño Stitch «Centro de Operaciones»).

export type SidebarInfo = { territoryName: string | null };

type NavItem = { href: string; label: string; short: string; icon: IconName; match: (path: string) => boolean };

export function OpsSidebar({ info }: { info: SidebarInfo }) {
  const pathname = usePathname();
  const territory = useSearchParams().get("territory");
  // El tablero llena el lugar del mapa con un portal recién cuando esta barra hidrató: si lo llenara antes, React
  // encontraría el mapa dentro del HTML del servidor al hidratar el Suspense y regeneraría todo (error #418).
  const mapSlot = useRef<HTMLDivElement>(null);
  useEffect(() => mapSlot.current?.setAttribute("data-ready", ""), []);
  const q = territory ? `?territory=${encodeURIComponent(territory)}` : "";
  const items: NavItem[] = [
    { href: `/operacion${q}`, label: "Centro de Operaciones", short: "Centro", icon: "dashboard", match: (p) => p === "/operacion" },
    { href: `/operacion/plan${q}`, label: "Plan de atención", short: "Plan", icon: "list", match: (p) => p.startsWith("/operacion/plan") },
    { href: `/operacion/revision${q}`, label: "Cola de revisión", short: "Revisión", icon: "help", match: (p) => p.startsWith("/operacion/revision") },
  ];
  if (territory) items.push({ href: `/reportar/${encodeURIComponent(territory)}`, label: "Reportar problema", short: "Reportar", icon: "add", match: () => false });

  return (
    <aside className="flex shrink-0 flex-col border-b border-line bg-surface-2 lg:sticky lg:top-0 lg:h-screen lg:w-72 lg:border-b-0 lg:border-r lg:pt-5">
      <div className="flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3 lg:border-b lg:border-line lg:px-4 lg:pt-0 lg:pb-5">
          <BrandMark />

          <div className="flex min-w-0 flex-col">
            <span className="text-lg font-bold leading-tight tracking-tight text-accent">Radar Urbano</span>
            <span className="truncate whitespace-nowrap text-ink-2">
              {info.territoryName && <span className="hidden sm:inline lg:inline">{info.territoryName} · </span>}Operaciones
            </span>
          </div>
          <div className="ml-auto lg:hidden">
            <ThemeToggle compact />
          </div>
        </div>
        <nav aria-label="Consola de operación" className="grid grid-cols-2 gap-1 px-3 pb-3 sm:grid-cols-4 lg:mt-4 lg:flex lg:flex-col lg:pb-0">
          {items.map((it) => {
            const active = it.match(pathname);
            return (
              <Link
                key={it.label}
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-2 py-2 font-semibold whitespace-nowrap lg:justify-start lg:gap-3 lg:px-3 ${
                  active ? "bg-accent text-accent-ink shadow-sm" : "text-ink-2 hover:bg-[var(--surface-3)] hover:text-ink"
                }`}
              >
                <Icon name={it.icon} />
                <span className="lg:hidden">{it.short}</span>
                <span className="hidden lg:inline">{it.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="hidden items-center justify-between gap-2 px-4 pt-4 lg:flex">
        <span className="font-semibold text-ink-2">Apariencia</span>
        <ThemeToggle compact />
      </div>

      {/* Lugar del mapa de incidentes en escritorio: lo llena el tablero con un portal. */}
      <div id="ops-sidebar-map" ref={mapSlot} className="hidden min-h-0 flex-1 px-3 pt-4 pb-3 lg:flex lg:flex-col" />
    </aside>
  );
}

/** Barra superior: título de la consola, territorio y frescura de los datos. */
export function OpsHeader({
  title, subtitle, updatedAt, offline, actions,
}: {
  title: string;
  subtitle?: string | null;
  updatedAt: number | null;
  offline?: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-[500] flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-line bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-4 py-2 backdrop-blur lg:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-lg font-bold text-accent">{title}</h1>
        {subtitle && (
          <>
            <span aria-hidden className="hidden text-[var(--outline)] sm:inline">·</span>
            <span className="w-full text-ink-2 sm:w-auto">{subtitle}</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Freshness updatedAt={updatedAt} offline={offline} />
        {actions}
      </div>
    </header>
  );
}

function Freshness({ updatedAt, offline }: { updatedAt: number | null; offline?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (updatedAt === null) return <span className="text-ink-2" role="status">Cargando…</span>;
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  return (
    <span className="flex items-center gap-3">
      <span role="status" className={`flex items-center gap-1.5 font-semibold ${offline ? "text-danger" : "text-[var(--success)]"}`}>
        <span aria-hidden className={`h-2 w-2 rounded-full ${offline ? "bg-danger" : "bg-[var(--success)]"}`} />
        {offline ? "Sin conexión" : "Conectado en vivo"}
      </span>
      <span aria-hidden className="text-[var(--outline)]">|</span>
      <span className="font-semibold" aria-live="off">Actualizado hace {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`}</span>
    </span>
  );
}

const KPI_TONE = {
  danger: { icon: "bg-danger-soft text-danger", detail: "text-danger", value: "text-ink" },
  warn: { icon: "bg-warn-soft text-warn", detail: "text-warn", value: "text-ink" },
  success: { icon: "bg-[var(--success-soft)] text-[var(--success)]", detail: "text-[var(--success)]", value: "text-[var(--success)]" },
  info: { icon: "bg-accent-soft text-accent", detail: "text-accent", value: "text-ink" },
} as const;

/** Métrica resumida del encabezado (abiertos, por revisar, resueltos…). */
export function KpiCard({ label, value, detail, icon, tone }: { label: string; value: number | string; detail?: string | null; icon: IconName; tone: keyof typeof KPI_TONE }) {
  const t = KPI_TONE[tone];
  return (
    <div className="card flex items-center justify-between gap-3 p-3 sm:p-5">
      <div className="min-w-0">
        <div className="text-ink-2 sm:text-lg">{label}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className={`text-2xl font-bold tracking-tight sm:text-3xl ${t.value}`}>{value}</span>
          {detail && <span className={`hidden font-semibold sm:inline sm:text-lg ${t.detail}`}>{detail}</span>}
        </div>
      </div>
      <div className={`hidden h-12 w-12 shrink-0 items-center justify-center rounded-[10px] sm:flex ${t.icon}`}>
        <Icon name={icon} size={24} />
      </div>
    </div>
  );
}

export function PriorityBadge({ band }: { band: PriorityBand }) {
  // La banda se lee por el texto; el color es refuerzo.
  return <span className={`ops-badge ops-badge--${band}`}>{PRIORITY[band].label}</span>;
}


/** Selector de filtro compacto («Prioridad: Todos»). Vacío = sin filtro. */
export function FilterSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: [string, string][];
}) {
  return (
    <select className="ops-select" aria-label={label} value={value} onChange={onChange}>
      <option value="">{label}: Todos</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{label}: {l}</option>
      ))}
    </select>
  );
}

/** Buscador de la barra de filtros. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative min-w-0 flex-[1_1_18rem]">
      <span className="sr-only">Buscar</span>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-2">
        <Icon name="search" />
      </span>
      <input type="search" className="ops-search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
