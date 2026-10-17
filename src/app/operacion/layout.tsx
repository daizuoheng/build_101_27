import { Plus_Jakarta_Sans } from "next/font/google";
import { Suspense } from "react";
import { getInternalSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { getTerritoryView } from "@/server/intake/view";
import { OpsSidebar, type SidebarInfo } from "./_components/OpsShell";
import { THEME_INIT_SCRIPT } from "./_components/theme";
import "./operacion.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", variable: "--font-ops" });

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
    <div suppressHydrationWarning className={`ops ${jakarta.variable} flex min-h-screen w-full flex-1 flex-col lg:flex-row`}>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <Suspense fallback={<div className="h-16 border-b border-line bg-surface-2 lg:h-auto lg:w-72 lg:border-b-0 lg:border-r" aria-hidden />}>
        <OpsSidebar info={info} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
