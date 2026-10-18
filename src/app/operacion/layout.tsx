import { Suspense } from "react";
import { getInternalSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { getTerritoryView } from "@/server/intake/view";
import { OpsSidebar, type SidebarInfo } from "./_components/OpsShell";
import "./operacion.css";

/** Territorio de la sesión para el encabezado de la barra lateral (desde la base). */
async function sidebarInfo(): Promise<SidebarInfo> {
  const s = await getInternalSession().catch(() => null);
  if (!s) return { territoryName: null };
  const t = await getTerritoryView(getPool(), { id: s.territoryId }).catch(() => null);
  return { territoryName: t?.name ?? null };
}

/** Marco de la consola de Operación: navegación lateral fija en escritorio, barra superior en pantallas chicas. */
export default async function OperacionLayout({ children }: { children: React.ReactNode }) {
  const info = await sidebarInfo();
  return (
    <div className="ops flex min-h-screen w-full flex-1 flex-col lg:flex-row">
      <Suspense fallback={<div className="h-16 border-b border-line bg-surface lg:h-auto lg:w-72 lg:border-b-0 lg:border-r" aria-hidden />}>
        <OpsSidebar info={info} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
