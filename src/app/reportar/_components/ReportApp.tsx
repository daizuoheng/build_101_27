"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftView, MessageView, MyReportItem as MyReportItemSchema } from "@/shared/contracts/intake";
import type { z } from "zod";
import { api, errorMessage } from "@/app/_components/http";
import { LocationPanel, type LocationMode, type Proposed } from "./LocationPanel";
import { DraftCardView } from "./DraftCardView";

type MyReportItem = z.infer<typeof MyReportItemSchema>;
type Pending = { clientMessageId: string; body: string; kind: "text" | "photo"; file?: File; failed?: string };

const POLL_MS = 4000;

function newId() {
  return crypto.randomUUID();
}

export function ReportApp({ territorySlug }: { territorySlug: string }) {
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [history, setHistory] = useState<MyReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [location, setLocation] = useState<{ mode: LocationMode; proposed?: Proposed | null } | null>(null);
  const retryText = useRef<{ body: string; id: string } | null>(null);
  const confirmKey = useRef<{ revision: number; key: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const draftUrl = (id: string) => `/api/reportar/drafts/${encodeURIComponent(id)}`;

  const createDraft = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const d = await api<DraftView>("/api/reportar/drafts", { method: "POST", json: { territorySlug } });
      setDraft(d);
      setPending([]);
      setLocation(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [territorySlug]);

  // Al entrar: retomar el último borrador o crear uno si no hay reportes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api<MyReportItem[]>(`/api/reportar/drafts?territory=${encodeURIComponent(territorySlug)}`);
        if (cancelled) return;
        setHistory(list);
        const latest = list[0];
        if (latest) {
          const d = await api<DraftView>(draftUrl(latest.id));
          if (!cancelled) setDraft(d);
        } else {
          await createDraft();
        }
      } catch (err) {
        if (!cancelled) setFatal(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [territorySlug, createDraft]);

  // Polling mientras hay análisis pendiente o procesamiento posterior al envío.
  const shouldPoll =
    !!draft && (draft.analysisPending || (draft.tracking !== null && ["pending", "running"].includes(draft.tracking.processing)));
  useEffect(() => {
    if (!shouldPoll || !draft) return;
    const id = draft.id;
    const t = setInterval(async () => {
      try {
        setDraft(await api<DraftView>(draftUrl(id)));
      } catch {
        /* se reintenta en el próximo ciclo */
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [shouldPoll, draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [draft?.messages.length, pending.length]);

  async function sendText(e?: React.FormEvent) {
    e?.preventDefault();
    if (!draft) return;
    const body = text.trim();
    if (!body) return;
    // Reintentar el mismo texto reutiliza su clientMessageId: el servidor no lo duplica.
    const id = retryText.current?.body === body ? retryText.current.id : newId();
    retryText.current = { body, id };
    setText("");
    setError(null);
    setPending((p) => [...p, { clientMessageId: id, body, kind: "text" }]);
    try {
      const d = await api<DraftView>(`${draftUrl(draft.id)}/messages`, { method: "POST", json: { clientMessageId: id, body } });
      setDraft(d);
      retryText.current = null;
      setPending((p) => p.filter((x) => x.clientMessageId !== id));
    } catch (err) {
      setPending((p) => p.filter((x) => x.clientMessageId !== id));
      setText((t) => t || body);
      setError(errorMessage(err));
    }
  }

  async function sendPhoto(file: File, clientMessageId = newId()) {
    if (!draft) return;
    setError(null);
    setPending((p) => [...p.filter((x) => x.clientMessageId !== clientMessageId), { clientMessageId, body: "Foto", kind: "photo", file }]);
    const form = new FormData();
    form.append("file", file);
    form.append("clientMessageId", clientMessageId);
    try {
      const d = await api<DraftView>(`${draftUrl(draft.id)}/attachments`, { method: "POST", body: form });
      setDraft(d);
      setPending((p) => p.filter((x) => x.clientMessageId !== clientMessageId));
    } catch (err) {
      const msg = errorMessage(err);
      setPending((p) => p.map((x) => (x.clientMessageId === clientMessageId ? { ...x, failed: msg } : x)));
    }
  }

  async function confirmLocation(loc: { lon: number; lat: number; source: "gps" | "map" | "geocoded"; text?: string }) {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const d = await api<DraftView>(`${draftUrl(draft.id)}/location`, { method: "POST", json: loc });
      setDraft(d);
      setLocation(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmReport() {
    if (!draft) return;
    if (!confirmKey.current || confirmKey.current.revision !== draft.revision) {
      confirmKey.current = { revision: draft.revision, key: newId() };
    }
    setBusy(true);
    setError(null);
    try {
      const d = await api<DraftView>(`${draftUrl(draft.id)}/confirm`, { method: "POST", json: { idempotencyKey: confirmKey.current.key } });
      setDraft(d);
      setLocation(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p role="status" className="p-4 text-ink-2">Cargando…</p>;
  }
  if (fatal) {
    return (
      <div className="p-4">
        <p role="alert" className="card border-danger p-3 text-danger">{fatal}</p>
      </div>
    );
  }

  const territory = draft?.territory;
  const areaWord = territory?.areaLabel.toLowerCase();
  const confirmed = draft?.status === "confirmed";
  const lastUiIndex = draft ? lastIndexWithUi(draft.messages) : -1;
  const showCard = !!draft && !confirmed && (draft.card.typeName !== null || draft.location !== null);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col">
      <header className="sticky top-0 z-[500] border-b border-line bg-bg/95 px-4 py-3 backdrop-blur">
        <h1 className="text-xl font-bold">{areaWord ? `Reportá un problema en tu ${areaWord}` : "Reportá un problema"}</h1>
        {territory && <p className="text-sm text-ink-2">{territory.name} · piloto con unidades de prueba</p>}
      </header>

      <main className="flex flex-1 flex-col gap-3 px-4 py-4" aria-live="polite">
        {history.length > 1 && <PastReports items={history} currentId={draft?.id} />}

        {draft?.messages.map((m, i) => (
          <Bubble key={m.id} message={m}>
            {m.ui && !confirmed && i === lastUiIndex && (
              <UiControls
                message={m}
                draft={draft}
                onLocation={(mode, proposed) => setLocation({ mode, proposed })}
                onPhoto={() => fileInput.current?.click()}
                onFocusText={() => document.getElementById("composer")?.focus()}
              />
            )}
            {m.ui?.kind === "active_hazard" && territory?.emergencyText && <EmergencyNotice text={territory.emergencyText} />}
            {m.ui?.kind === "confirmed" && <CodeBadge code={m.ui.publicCode} />}
          </Bubble>
        ))}

        {pending.map((p) => (
          <div key={p.clientMessageId} className="ml-auto max-w-[85%] rounded-[var(--radius)] bg-accent-soft px-3 py-2 opacity-80">
            <p>{p.kind === "photo" ? "📷 Enviando foto…" : p.body}</p>
            {p.failed && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span role="alert" className="text-danger">{p.failed}</span>
                {p.file && (
                  <button type="button" className="btn" onClick={() => sendPhoto(p.file!, p.clientMessageId)}>
                    Reintentar
                  </button>
                )}
                <button type="button" className="btn" onClick={() => setPending((x) => x.filter((y) => y.clientMessageId !== p.clientMessageId))}>
                  Descartar
                </button>
              </div>
            )}
          </div>
        ))}

        {draft?.analysisPending && (
          <p role="status" className="text-ink-2">Analizando tu mensaje…</p>
        )}

        {draft && territory && location && !confirmed && (
          <LocationPanel
            key={`${location.mode}-${location.proposed?.lon ?? ""}`}
            draftId={draft.id}
            territory={territory}
            initialMode={location.mode}
            proposed={location.proposed}
            busy={busy}
            onConfirm={confirmLocation}
            onClose={() => setLocation(null)}
          />
        )}

        {confirmed && draft && <Tracking draft={draft} onNew={createDraft} busy={busy} />}

        <div ref={bottom} />
      </main>

      {draft && !confirmed && (
        <footer className="sticky bottom-0 z-[500] flex flex-col gap-2 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur">
          {showCard && (
            <DraftCardView
              card={draft.card}
              location={draft.location}
              areaLabel={draft.territory.areaLabel}
              busy={busy}
              onConfirm={confirmReport}
              onChangeLocation={() => setLocation({ mode: "map" })}
            />
          )}
          {error && (
            <p role="alert" className="rounded-[var(--radius)] bg-danger-soft px-3 py-2 text-danger">
              {error}
            </p>
          )}
          <form onSubmit={sendText} className="flex items-end gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) sendPhoto(f);
              }}
            />
            <button type="button" className="btn" onClick={() => fileInput.current?.click()} aria-label="Adjuntar foto">
              📷
            </button>
            <label htmlFor="composer" className="sr-only">Mensaje</label>
            <textarea
              id="composer"
              className="field resize-none"
              rows={1}
              value={text}
              maxLength={2000}
              placeholder="Contá qué pasa y dónde…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendText();
                }
              }}
            />
            <button className="btn btn-primary" disabled={!text.trim()}>
              Enviar
            </button>
          </form>
        </footer>
      )}
    </div>
  );
}

function lastIndexWithUi(messages: MessageView[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].ui) return i;
  return -1;
}

function Bubble({ message, children }: { message: MessageView; children?: React.ReactNode }) {
  const mine = message.role === "citizen";
  if (message.role === "system") {
    return <p className="text-center text-sm text-ink-2">{message.body}</p>;
  }
  return (
    <div className={`flex max-w-[85%] flex-col gap-2 ${mine ? "ml-auto items-end" : "mr-auto items-start"}`}>
      <div className={`rounded-[var(--radius)] px-3 py-2 ${mine ? "bg-accent-soft" : "card"}`}>
        <span className="sr-only">{mine ? "Vos: " : "Radar Urbano: "}</span>
        {message.attachmentId && <p className="font-semibold">📷 Foto adjunta</p>}
        {message.body && <p className="whitespace-pre-wrap">{message.body}</p>}
      </div>
      {children}
    </div>
  );
}

function UiControls({
  message,
  draft,
  onLocation,
  onPhoto,
  onFocusText,
}: {
  message: MessageView;
  draft: DraftView;
  onLocation: (mode: LocationMode, proposed?: Proposed | null) => void;
  onPhoto: () => void;
  onFocusText: () => void;
}) {
  const ui = message.ui!;
  const loc = draft.location;
  // Ubicación ya confirmada: no volver a pedirla. Un pin propuesto se oculta solo si es el punto ya confirmado;
  // un pin de corrección (posterior a la ficha lista) apunta a otro lugar y tiene que poder aceptarse.
  if (loc?.confirmed && ui.kind === "ask_location") return null;
  if (loc?.confirmed && ui.kind === "propose_location" && Math.abs(loc.lon - ui.lon) < 1e-6 && Math.abs(loc.lat - ui.lat) < 1e-6) return null;
  switch (ui.kind) {
    case "ask_location":
      return (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => onLocation("gps")}>Usar mi ubicación</button>
          <button type="button" className="btn" onClick={() => onLocation("map")}>Elegir en el mapa</button>
          <button type="button" className="btn" onClick={() => onLocation("address")}>Escribir dirección</button>
        </div>
      );
    case "propose_location":
      return (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => onLocation("proposed", { lon: ui.lon, lat: ui.lat, label: ui.label })}>
            Ver en el mapa y confirmar
          </button>
          <button type="button" className="btn" onClick={() => onLocation("map")}>Elegir otro punto</button>
        </div>
      );
    case "ask_evidence":
      return (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`btn ${ui.requestedField === "photo" ? "btn-primary" : ""}`} onClick={onPhoto}>
            Sacar otra foto
          </button>
          <button type="button" className={`btn ${ui.requestedField === "description" ? "btn-primary" : ""}`} onClick={onFocusText}>
            Contar más
          </button>
        </div>
      );
    default:
      return null;
  }
}

function EmergencyNotice({ text }: { text: string }) {
  return (
    <div role="alert" className="flex gap-2 rounded-[var(--radius)] border-2 border-danger bg-danger-soft p-3 text-danger">
      <span aria-hidden className="text-xl">⚠</span>
      <p className="font-semibold">Si hay fuego o riesgo para personas ahora: {text}</p>
    </div>
  );
}

function CodeBadge({ code }: { code: string }) {
  return (
    <p className="card px-4 py-3 text-center">
      <span className="block text-sm text-ink-2">Código de reporte</span>
      <span className="font-mono text-2xl font-bold tracking-widest">{code}</span>
    </p>
  );
}

function Tracking({ draft, onNew, busy }: { draft: DraftView; onNew: () => void; busy: boolean }) {
  const t = draft.tracking;
  const working = t && ["pending", "running"].includes(t.processing);
  return (
    <section aria-label="Estado del reporte" className="card flex flex-col gap-3 p-4">
      {draft.publicCode && <CodeBadge code={draft.publicCode} />}
      {t && (
        <p role="status" className="text-lg">
          <span className="font-semibold">Estado:</span> {t.statusLabel}
          {working && <span className="text-ink-2"> (actualizando…)</span>}
        </p>
      )}
      <p className="text-sm text-ink-2">
        Podés volver a ver este estado desde este mismo navegador. Recibir el reporte no significa que ya esté resuelto.
      </p>
      <button type="button" className="btn btn-primary" onClick={onNew} disabled={busy}>
        Nuevo reporte
      </button>
    </section>
  );
}

function PastReports({ items, currentId }: { items: MyReportItem[]; currentId?: string }) {
  const others = items.filter((i) => i.id !== currentId && i.status === "confirmed");
  if (!others.length) return null;
  return (
    <details className="card p-3">
      <summary className="min-h-[44px] cursor-pointer content-center font-semibold">Mis reportes anteriores ({others.length})</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {others.map((r) => (
          <li key={r.id} className="text-ink-2">
            <span className="font-mono font-semibold text-ink">{r.publicCode}</span> · {new Date(r.createdAt).toLocaleString("es-UY")}
            {r.preview && <> · {r.preview}</>}
          </li>
        ))}
      </ul>
    </details>
  );
}
