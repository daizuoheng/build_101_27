"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { PlanItemView, PlanResponse } from "@/shared/contracts/plan";
import { HttpError, api, errorMessage } from "@/app/_components/http";
import {
  ASSIGNMENT_STATUS, PLAN_ITEM_STATUS, PLAN_PENDING_REASON, PLAN_PROPOSAL_REASON, PLAN_TRIGGER, PRIORITY, STATUS, hours,
} from "./labels";

const REFRESH_MS = 10000;

/** Vista «Plan de atención» (ALCANCE §6): proyección de solo lectura del último plan; recalcular solo encola el job. */
export function PlanBoard({ territorySlug }: { territorySlug: string }) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const router = useRouter();

  const onAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof HttpError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/operacion/plan?territory=${territorySlug}`)}`);
        return true;
      }
      return false;
    },
    [router, territorySlug],
  );

  const load = useCallback(async () => {
    try {
      setData(await api<PlanResponse>(`/api/operacion/plan?${new URLSearchParams({ territory: territorySlug })}`));
      setError(null);
    } catch (err) {
      if (!onAuthError(err)) setError(errorMessage(err));
    }
  }, [territorySlug, onAuthError]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function replan() {
    setRequesting(true);
    setNotice(null);
    try {
      const r = await api<{ jobId: string; created: boolean }>("/api/operacion/plan", { method: "POST", json: { territory: territorySlug } });
      setNotice(r.created ? "Recálculo pedido. El plan nuevo aparece acá cuando termine." : "Ya hay un recálculo en curso. El plan nuevo aparece acá cuando termine.");
      setError(null);
    } catch (err) {
      if (!onAuthError(err)) setError(errorMessage(err));
    } finally {
      setRequesting(false);
    }
  }

  const run = data?.planRun ?? null;
  const items = data?.items ?? [];

  return (
    <div className="flex w-full flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <div>
          <nav aria-label="Operación">
            <Link href={`/operacion?territory=${encodeURIComponent(territorySlug)}`} className="font-semibold text-accent underline">
              ← Incidentes
            </Link>
          </nav>
          <h1 className="text-xl font-bold">Plan de atención</h1>
          <p className="text-ink-2" role="status">
            {!data
              ? "Cargando…"
              : run
                ? `Versión de política ${run.policyVersion} · calculado ${new Date(run.computedAt).toLocaleString("es-UY")} · ${PLAN_TRIGGER[run.trigger] ?? run.trigger} · ${items.length} incidentes`
                : "Todavía no hay un plan calculado."}
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={replan} disabled={requesting}>
          {requesting ? "Pidiendo…" : "Actualizar plan"}
        </button>
      </header>

      {notice && <p role="status" className="mx-4 mt-3 rounded-[var(--radius)] bg-info-soft px-3 py-2">{notice}</p>}
      {error && <p role="alert" className="mx-4 mt-3 rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">{error}</p>}

      <section aria-label="Cola priorizada" className="mx-auto flex w-full max-w-5xl flex-col gap-2 p-4">
        {data && !run && (
          <p className="card p-4 text-ink-2">
            Cuando el sistema calcule el primer plan vas a ver acá el orden recomendado, la unidad propuesta y los motivos.
          </p>
        )}
        {run && items.length === 0 && <p className="card p-4 text-ink-2">El plan no tiene incidentes abiertos.</p>}
        <ol className="flex flex-col gap-2">
          {items.map((it) => (
            <PlanRow key={it.incident.id} item={it} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function PlanRow({ item }: { item: PlanItemView }) {
  const p = PRIORITY[item.incident.priorityBand];
  const pending = item.status === "blocked" || item.blockedReason !== null;
  const reasonLabels = item.reasons.map((r) => PLAN_PROPOSAL_REASON[r] ?? PLAN_PENDING_REASON[r] ?? r);
  return (
    <li className="card flex gap-3 p-3" aria-label={`Puesto ${item.position}: ${item.incident.title}`}>
      <div className="flex w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-[var(--radius)] bg-surface-2 py-2"
        style={{ color: `var(--prio-${item.incident.priorityBand})` }}>
        <span className="text-ink font-bold">#{item.position}</span>
        <span aria-hidden className="text-2xl leading-none">{p.symbol}</span>
        <span className="font-bold">{p.label}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.incident.activeHazard && <span className="rounded-full bg-danger px-2 py-0.5 font-bold text-white">⚠ Peligro activo</span>}
          <h2 className="font-bold">{item.incident.title}</h2>
        </div>
        <p className="text-ink-2">
          {item.incident.problemType ?? "Tipo sin determinar"} · {item.incident.areaName ?? "zona sin determinar"} · {STATUS[item.incident.status as keyof typeof STATUS] ?? item.incident.status}
        </p>
        <p>
          Espera {hours(item.score.waitHours)} · {item.score.sources} {item.score.sources === 1 ? "fuente" : "fuentes"} · bonus {hours(item.score.bonusHours)} · puntaje {hours(item.score.score)}
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2">
          <span className={`font-semibold ${pending ? "text-warn" : ""}`}>{PLAN_ITEM_STATUS[item.status] ?? item.status}</span>
          {item.assignedUnit ? (
            <span>Asignada: <strong>{item.assignedUnit.name}</strong> (orden {ASSIGNMENT_STATUS[item.assignedUnit.status] ?? item.assignedUnit.status})</span>
          ) : item.proposedUnit ? (
            <span>Propuesta: <strong>{item.proposedUnit.name}</strong></span>
          ) : null}
          {item.blockedReason && <span className="text-warn">⚠ {PLAN_PENDING_REASON[item.blockedReason] ?? item.blockedReason}</span>}
        </div>
        {(item.explanation || reasonLabels.length > 0) && (
          <p className="text-ink-2">{item.explanation ?? `Motivo: ${reasonLabels.join(" · ")}`}</p>
        )}
      </div>
    </li>
  );
}
