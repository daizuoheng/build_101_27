import Link from "next/link";
import { IconLogo } from "./icons";

export type Section = "reportar" | "unidad" | "operacion";

const NAV: { key: Section; label: string; href: (t: string) => string }[] = [
  { key: "reportar", label: "Reportar problema", href: (t) => `/reportar/${t}` },
  { key: "unidad", label: "Bandeja de unidad", href: () => "/unidad" },
  { key: "operacion", label: "Operación", href: (t) => `/operacion?territory=${t}` },
];

/**
 * Franja del piloto + encabezado con navegación. El aviso de emergencia sale de la configuración del territorio;
 * si no hay, no se muestra nada inventado.
 */
export function SiteHeader({
  active,
  territorySlug = "montevideo",
  territoryName,
  emergencyText,
  right,
}: {
  active: Section;
  territorySlug?: string;
  territoryName?: string;
  emergencyText?: string | null;
  right?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-[600] border-b border-line-soft bg-surface/90 backdrop-blur">
      <div className="border-b border-line-soft/70 px-4 py-1.5 text-[13px] text-ink-2 md:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-0.5">
          <p className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden />
            <span>Piloto · datos de prueba</span>
          </p>
          {/* Aviso de seguridad visible en todos los tamaños; en celular, en una línea más corta. */}
          {emergencyText && (
            <p className="text-xs sm:text-[13px]">
              <span className="font-semibold text-danger-strong sm:font-normal sm:text-ink-2">No reemplaza a emergencias:</span> {emergencyText}
            </p>
          )}
        </div>
      </div>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 md:px-8">
        <Link href={`/reportar/${territorySlug}`} className="flex min-h-[44px] items-center gap-2.5 rounded-lg">
          <IconLogo />
          <span className="flex flex-col">
            <span className="text-[17px] font-bold leading-tight tracking-tight text-primary">Radar Urbano</span>
            {territoryName && <span className="text-xs font-medium text-ink-2">{territoryName}</span>}
          </span>
        </Link>
        <nav aria-label="Secciones" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.key}
              href={n.href(territorySlug)}
              aria-current={active === n.key ? "page" : undefined}
              className={`inline-flex min-h-[44px] items-center rounded-lg px-3.5 text-[15px] font-semibold ${
                active === n.key ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        {right && <div className="flex items-center gap-2">{right}</div>}
      </div>
    </header>
  );
}
