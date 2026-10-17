import type { Metadata } from "next";
import { ReportApp } from "../_components/ReportApp";

export const metadata: Metadata = { title: "Reportar · Radar Urbano" };

export default async function ReportarPage({ params }: { params: Promise<{ territory: string }> }) {
  const { territory } = await params;
  return <ReportApp territorySlug={territory} />;
}
