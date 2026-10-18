"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssignmentAction, UnitAssignmentCard, UnitInboxResponse } from "@/shared/contracts/assignment";
import { api, errorMessage, HttpError } from "@/app/_components/http";
import { SiteHeader } from "@/app/_components/SiteHeader";
import { IconAlert, IconClock, IconPin, IconRefresh, IconTruck } from "@/app/_components/icons";
import { ACTION, ago, distance, PRIORITY, PRIORITY_RULE, PROPOSAL_REASON, STATUS } from "./labels";

const LeafletMap = dynamic(() => import("@/app/_components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="h-[180px] animate-pulse rounded-[var(--radius)] bg-surface-2" aria-hidden />,
});

const POLL_MS = 3_000;
/** Cuánto queda resaltada una orden que llegó con la bandeja abierta. */
const FRESH_MS = 15_000;
type UnitAction = Exclude<AssignmentAction, "cancel">;
type Notice = { tone: "ok" | "warn" | "error"; text: string } | null;

/** Aviso de orden nueva: vibración y un tono corto. El navegador puede bloquearlos sin un toque previo; no es crítico. */
function alertNewOrder() {
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {}
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.connect(ctx.destination);
    [880, 1175].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.15);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {}
}

/**
 * Bandeja de la unidad: órdenes activas, de la más urgente a la menos. Se actualiza sola cada 3 s (con la pestaña
 * visible). Solo muestra las acciones que el servidor permite; si la orden cambió mientras tanto (409), recarga.
 * Una orden que llega con la bandeja abierta se resalta y avisa (vibración, tono y título de la pestaña).
 */
export function UnitInbox() {
  const [inbox, setInbox] = useState<UnitInboxResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notAUnit, setNotAUnit] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const keys = useRef(new Map<string, string>());
  // Cada carga y cada acción toman un número; solo se aplica la respuesta del último pedido lanzado. Así un polling
  // que salió antes de «Aceptar» no vuelve a mostrar la orden como nueva cuando llega después.
  const generation = useRef(0);
  // Mientras hay una acción en curso no se lanzan cargas: su respuesta ya trae la bandeja posterior a la acción.
  const acting = useRef(false);
  // Órdenes ya vistas (null hasta la primera carga, que no avisa) y las recién llegadas, que se resaltan.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const router = useRouter();

  const load = useCallback(async () => {
    if (acting.current) return;
    const gen = ++generation.current;
    try {
      const data = await api<UnitInboxResponse>("/api/unidad/assignments");
      if (gen !== generation.current) return;
      const arrived = seen.current ? data.assignments.filter((a) => !seen.current!.has(a.id)) : [];
      seen.current = new Set([...(seen.current ?? []), ...data.assignments.map((a) => a.id)]);
      if (arrived.length > 0) {
        setFresh((f) => new Set([...f, ...arrived.map((a) => a.id)]));
        alertNewOrder();
      }
      setInbox(data);
      setLoadError(null);
      setNow(Date.now());
    } catch (err) {
      if (gen !== generation.current) return;
      if (err instanceof HttpError && err.status === 401) {
        router.replace("/login?next=%2Funidad");
        return;
      }
      if (err instanceof HttpError && err.status === 403) {
        setNotAUnit(true);
        return;
      }
      setLoadError(errorMessage(err));
    }
  }, [router]);

  useEffect(() => {
    // Carga inicial + polling; los setState ocurren al resolver la promesa, no dentro del efecto.
    const first = setTimeout(load, 0);
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Mientras haya órdenes recién llegadas, la pestaña lo dice; el resaltado se apaga a los FRESH_MS de la última.
  useEffect(() => {
    if (fresh.size === 0) return;
    const original = document.title;
    document.title = `● Nueva orden · ${original}`;
    const t = setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => {
      clearTimeout(t);
      document.title = original;
    };
  }, [fresh]);

  // Recién llegadas que siguen en la bandeja (una cancelada en el medio no deja el aviso colgado).
  const arrivedNow = inbox?.assignments.filter((a) => fresh.has(a.id)).length ?? 0;

  async function act(card: UnitAssignmentCard, action: UnitAction, reason?: string) {
    // Misma clave para reintentos de la misma acción sobre la misma versión: el servidor no la aplica dos veces.
    const k = `${card.id}:${action}:${card.version}`;
    if (!keys.current.has(k)) keys.current.set(k, crypto.randomUUID());
    setBusyId(card.id);
    setNotice(null);
    // La acción invalida las cargas que ya estaban en vuelo y frena las nuevas hasta terminar.
    ++generation.current;
    acting.current = true;
    try {
      const res = await api<{ inbox: UnitInboxResponse }>(`/api/unidad/assignments/${encodeURIComponent(card.id)}`, {
        method: "POST",
        json: { action, expectedVersion: card.version, idempotencyKey: keys.current.get(k), reason: reason || undefined },
      });
      acting.current = false;
      seen.current = new Set([...(seen.current ?? []), ...res.inbox.assignments.map((a) => a.id)]);
      setInbox(res.inbox);
      setNow(Date.now());
      setNotice({ tone: "ok", text: ACTION[action].done });
    } catch (err) {
      acting.current = false; // antes de recargar ante un 409
      if (err instanceof HttpError && err.status === 409) {
        setNotice({ tone: "warn", text: "La orden cambió mientras tanto. Actualizamos la bandeja; revisala de nuevo." });
        await load();
      } else if (err instanceof HttpError && err.status === 503) {
        setNotice({ tone: "warn", text: err.message });
      } else if (err instanceof HttpError && err.status === 401) {
        router.replace("/login?next=%2Funidad");
      } else {
        setNotice({ tone: "error", text: errorMessage(err) });
      }
    } finally {
      acting.current = false;
      setBusyId(null);
    }
  }

  async function logout() {
    await api("/api/auth/login", { method: "DELETE" }).catch(() => null);
    router.replace("/login?next=%2Funidad");
  }

  const unit = inbox?.unit;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader
        active="unidad"
        right={
          (unit || notAUnit) && (
            <button type="button" className="btn" onClick={logout}>
              Salir
            </button>
          )
        }
      />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-2">
              <IconTruck className="h-[18px] w-[18px]" /> Bandeja de unidad
            </p>
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-primary lg:text-[32px]">{unit?.name ?? "Órdenes asignadas"}</h1>
            {unit && (
              <p className="text-ink-2">
                {unit.activeOrders} de {unit.capacity} {unit.capacity === 1 ? "orden activa" : "órdenes activas"} · actualizado {ago(inbox!.generatedAt, now)}
              </p>
            )}
          </div>
          {unit && (
            <button type="button" className="btn" onClick={() => void load()}>
              <IconRefresh className="h-[18px] w-[18px]" /> Actualizar
            </button>
          )}
        </header>

        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`rounded-xl px-4 py-3 font-semibold ${
              notice.tone === "ok" ? "bg-success-soft text-success" : notice.tone === "warn" ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger-strong"
            }`}
          >
            {notice.text}
          </p>
        )}

        {arrivedNow > 0 && (
          <p role="status" className="rounded-xl bg-success-soft px-4 py-3 font-semibold text-success">
            {arrivedNow === 1 ? "Llegó una orden nueva." : `Llegaron ${arrivedNow} órdenes nuevas.`}
          </p>
        )}

        {notAUnit && (
          <p role="alert" className="card p-4">Esta bandeja es para usuarios de una unidad de respuesta. Entrá con la cuenta de la unidad.</p>
        )}
        {loadError && !inbox && (
          <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 p-4 text-danger-strong">
            {loadError}
            <button type="button" className="btn" onClick={() => void load()}>Reintentar</button>
          </div>
        )}
        {loadError && inbox && <p role="status" className="text-sm text-ink-2">Sin conexión; mostramos la última versión. {loadError}</p>}
        {!inbox && !loadError && !notAUnit && <p role="status" className="text-ink-2">Cargando…</p>}

        {inbox && inbox.assignments.length === 0 && (
          <section className="card flex flex-col items-center gap-2 p-10 text-center">
            <IconTruck className="h-10 w-10 text-ink-2" />
            <h2 className="text-lg font-bold">No tenés órdenes activas</h2>
            <p className="text-ink-2">Cuando el sistema te asigne una, aparece acá. La bandeja se actualiza sola.</p>
          </section>
        )}

        {inbox && inbox.assignments.length > 0 && (
          <ul className="grid gap-5 lg:grid-cols-2">
            {inbox.assignments.map((a) => (
              <li key={a.id}>
                <AssignmentCard card={a} now={now} fresh={fresh.has(a.id)} busy={busyId === a.id} disabled={busyId !== null} onAction={act} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function AssignmentCard({
  card,
  now,
  fresh,
  busy,
  disabled,
  onAction,
}: {
  card: UnitAssignmentCard;
  now: number;
  fresh: boolean;
  busy: boolean;
  disabled: boolean;
  onAction: (c: UnitAssignmentCard, a: UnitAction, reason?: string) => void;
}) {
  const [confirming, setConfirming] = useState<UnitAction | null>(null);
  const [reason, setReason] = useState("");
  const i = card.incident;
  const prio = PRIORITY[i.priorityBand];
  const rules = i.priorityRules.map((r) => PRIORITY_RULE[r]).filter(Boolean);
  const dist = distance(card.distanceM);
  const actions = card.allowedActions.filter((a): a is UnitAction => a !== "cancel");
  const titleId = `orden-${card.id}`;

  function press(a: UnitAction) {
    if (ACTION[a].confirm) {
      setConfirming(a);
      setReason("");
    } else onAction(card, a);
  }

  return (
    <article aria-labelledby={titleId} className={`card flex h-full flex-col gap-4 p-4 sm:p-5 ${i.activeHazard ? "border-2 border-danger-line" : ""} ${fresh ? "ru-fresh" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${prio.className}`}>
          <span aria-hidden>{prio.symbol}</span> {prio.label}
        </span>
        {i.activeHazard && (
          <span className="badge badge-high">
            <IconAlert className="h-3.5 w-3.5" /> Peligro activo
          </span>
        )}
        {i.areaName && <span className="badge badge-muted">{i.areaName}</span>}
        <span className="badge badge-info ml-auto">{STATUS[card.status]}</span>
      </div>

      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-xl font-bold leading-snug text-ink">{i.title}</h2>
        {rules.length > 0 && <p className="text-[15px] text-ink-2">Prioridad por: {rules.join(", ")}.</p>}
      </div>

      <dl className="grid gap-3 text-[15px] sm:grid-cols-2">
        <div className="flex items-start gap-2">
          <IconPin className="mt-0.5 h-[18px] w-[18px] shrink-0 text-accent" />
          <div>
            <dt className="sr-only">Lugar</dt>
            <dd className="font-semibold text-ink">{i.locationText ?? "Ubicación compartida por el ciudadano"}</dd>
            {dist && <dd className="text-ink-2">A {dist} de tu última posición</dd>}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <IconClock className="mt-0.5 h-[18px] w-[18px] shrink-0 text-accent" />
          <div>
            <dt className="sr-only">Tiempos</dt>
            <dd className="text-ink">Asignada {ago(card.offeredAt, now)}</dd>
            {card.startedAt && <dd className="text-ink-2">Iniciada {ago(card.startedAt, now)}</dd>}
            {!card.startedAt && card.acceptedAt && <dd className="text-ink-2">Aceptada {ago(card.acceptedAt, now)}</dd>}
          </div>
        </div>
      </dl>

      <LeafletMap label={`Mapa de ${i.title}`} center={{ lon: i.lon, lat: i.lat }} zoom={16} pin={{ lon: i.lon, lat: i.lat }} height={180} />
      <a
        className="-mt-2 inline-flex min-h-[44px] items-center self-start font-semibold text-accent underline-offset-2 hover:underline"
        href={`https://www.openstreetmap.org/?mlat=${i.lat}&mlon=${i.lon}#map=18/${i.lat}/${i.lon}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Abrir en el mapa (nueva pestaña)
      </a>

      {i.summary && <p className="text-ink">{i.summary}</p>}

      {i.citizenTexts.length > 0 && (
        <section aria-label="Lo que reportaron">
          <h3 className="text-xs font-bold uppercase tracking-wide text-ink-2">
            Lo que reportaron {i.citizenTexts.length > 1 ? `(${i.citizenTexts.length} reportes)` : ""}
          </h3>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {i.citizenTexts.slice(0, 4).map((t, idx) => (
              <li key={idx} className="rounded-lg bg-surface-low px-3 py-2 text-[15px] text-ink">“{t}”</li>
            ))}
          </ul>
          {i.citizenTexts.length > 4 && <p className="mt-1 text-sm text-ink-2">y {i.citizenTexts.length - 4} más.</p>}
        </section>
      )}

      {i.photoIds.length > 0 && (
        <section aria-label="Fotos">
          <h3 className="text-xs font-bold uppercase tracking-wide text-ink-2">Fotos ({i.photoIds.length})</h3>
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {i.photoIds.map((p, idx) => (
              <li key={p}>
                <a href={`/api/unidad/photos/${encodeURIComponent(p)}`} target="_blank" rel="noopener noreferrer" className="block h-20 w-20 overflow-hidden rounded-lg border border-line-soft">
                  {/* eslint-disable-next-line @next/next/no-img-element -- foto privada servida por ruta autorizada */}
                  <img src={`/api/unidad/photos/${encodeURIComponent(p)}?size=thumb`} alt={`Foto ${idx + 1} del reporte`} className="h-full w-full object-cover" loading="lazy" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.reasons.length > 0 && (
        <p className="text-sm text-ink-2">
          Por qué a esta unidad: {card.reasons.map((r) => PROPOSAL_REASON[r]).filter(Boolean).join(". ") || "asignada por el planificador"}.
        </p>
      )}

      {card.reviewBlocked && (
        <p className="flex items-start gap-2 rounded-lg bg-warn-soft p-3 font-semibold text-warn">
          <IconAlert className="mt-0.5 h-5 w-5 shrink-0" />
          Operación está revisando cambios en este incidente. Esperá antes de iniciar o completar.
        </p>
      )}

      <div className="mt-auto flex flex-col gap-3 border-t border-line-soft pt-4">
        {confirming ? (
          <div className="flex flex-col gap-3">
            {confirming === "reject" ? (
              <label className="flex flex-col gap-1.5">
                <span className="font-semibold">{ACTION.reject.confirm}</span>
                <textarea className="field resize-none" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: no tenemos el equipo necesario" />
              </label>
            ) : (
              <p className="font-semibold">{ACTION[confirming].confirm}</p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className={`btn flex-1 ${confirming === "reject" ? "btn-danger" : ACTION[confirming].className}`}
                disabled={busy || disabled}
                onClick={() => {
                  onAction(card, confirming, confirming === "reject" ? reason.trim() : undefined);
                  setConfirming(null);
                }}
              >
                {busy ? "Enviando…" : `Sí, ${ACTION[confirming].label.toLowerCase()}`}
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(null)}>
                Volver
              </button>
            </div>
          </div>
        ) : actions.length > 0 ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                className={`btn ${ACTION[a].className} ${a === "reject" ? "" : "flex-1"} min-h-12 text-[17px]`}
                disabled={busy || disabled}
                onClick={() => press(a)}
              >
                {busy ? "Enviando…" : ACTION[a].label}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-ink-2">No hay acciones disponibles por ahora.</p>
        )}
      </div>
    </article>
  );
}
