import type { Metadata } from "next";
import { IncidentDetail } from "../../_components/IncidentDetail";

export const metadata: Metadata = { title: "Incidente · Radar Urbano" };

export default async function IncidentePage({ params, searchParams }: PageProps<"/operacion/incidentes/[id]">) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const territory = typeof sp.territory === "string" ? sp.territory : null;
  if (!territory) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-2xl font-bold">Incidente</h1>
        <p className="mt-2 text-ink-2">
          Indicá el territorio en la dirección, por ejemplo <code>/operacion/incidentes/&lt;id&gt;?territory=&lt;slug&gt;</code>.
        </p>
      </main>
    );
  }
  return <IncidentDetail incidentId={id} territorySlug={territory} />;
}
