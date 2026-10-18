import type { Metadata } from "next";
import { ReviewQueue } from "../_components/ReviewQueue";

export const metadata: Metadata = { title: "Cola de revisión · Radar Urbano" };

export default async function RevisionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const territory = typeof sp.territory === "string" ? sp.territory : null;
  if (!territory) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-2xl font-bold">Cola de revisión</h1>
        <p className="mt-2 text-ink-2">
          Indicá el territorio en la dirección, por ejemplo <code>/operacion/revision?territory=&lt;slug&gt;</code>.
        </p>
      </main>
    );
  }
  return <ReviewQueue territorySlug={territory} />;
}
