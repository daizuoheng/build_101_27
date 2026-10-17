import Link from "next/link";

// Accesos de la demo del piloto. El territorio es un parámetro de la URL; la app no depende de él.
const PILOT_TERRITORY = "montevideo";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-ink-2">Piloto</p>
        <h1 className="text-3xl font-bold">Radar Urbano</h1>
        <p className="text-lg text-ink-2">
          Reportá problemas del espacio público conversando. Cada reporte se evalúa, se agrupa con otros del mismo
          problema y se asigna a una unidad de respuesta.
        </p>
        <p className="text-sm text-ink-2">
          Demo con unidades de prueba: los reportes no llegan a un servicio municipal real.
        </p>
      </header>
      <nav aria-label="Accesos" className="flex flex-col gap-3 sm:flex-row">
        <Link className="btn btn-primary text-lg" href={`/reportar/${PILOT_TERRITORY}`}>
          Reportar un problema
        </Link>
        <Link className="btn text-lg" href="/unidad">
          Bandeja de unidad
        </Link>
        <Link className="btn text-lg" href={`/operacion?territory=${PILOT_TERRITORY}`}>
          Operación
        </Link>
      </nav>
    </main>
  );
}
