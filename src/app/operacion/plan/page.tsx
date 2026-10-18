import type { Metadata } from "next";
import { PlanBoard } from "../_components/PlanBoard";

export const metadata: Metadata = { title: "Plan de atención · Radar Urbano" };

export default async function PlanPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const territory = typeof sp.territory === "string" ? sp.territory : null;
  if (!territory) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-2xl font-bold">Plan de atención</h1>
        <p className="mt-2 text-ink-2">
          Indicá el territorio en la dirección, por ejemplo <code>/operacion/plan?territory=&lt;slug&gt;</code>.
        </p>
      </main>
    );
  }
  return <PlanBoard territorySlug={territory} />;
}
