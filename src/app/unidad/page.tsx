import type { Metadata } from "next";
import { UnitInbox } from "./_components/UnitInbox";

export const metadata: Metadata = { title: "Bandeja de unidad · Radar Urbano" };

export default function UnidadPage() {
  return <UnitInbox />;
}
