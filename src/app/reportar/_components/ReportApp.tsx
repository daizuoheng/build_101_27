"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { DraftView, MessageUi, MessageView, MyReportItem as MyReportItemSchema } from "@/shared/contracts/intake";
import { api, errorMessage } from "@/app/_components/http";
import { SiteHeader } from "@/app/_components/SiteHeader";
import { IconAlert, IconCamera, IconChat, IconCheck, IconEdit, IconLocate, IconMap, IconPin, IconSend } from "@/app/_components/icons";
import { LocationPanel, type LocationMode, type Proposed } from "./LocationPanel";
import { ReviewCard } from "./DraftCardView";

type MyReportItem = z.infer<typeof MyReportItemSchema>;
type Pending = { clientMessageId: string; body: string; kind: "text" | "photo"; file?: File; preview?: string; failed?: string };
type LocationState = { mode: LocationMode; proposed?: Proposed | null } | null;

const POLL_MS = 4000;
// Fotos: cualquier imagen; HEIC/HEIF por extensión porque algunos navegadores no informan su tipo MIME.
const PHOTO_ACCEPT = "image/*,.heic,.heif";

const newId = () => crypto.randomUUID();
const time = (iso: string) => new Date(iso).toLocaleTimeString("es-UY", { hour: "2-digit", minute: "2-digit" });

export function ReportApp({ territorySlug }: { territorySlug: string }) {
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [location, setLocation] = useState<LocationState>(null);
  const [modifying, setModifying] = useState(false);
  const [reviewEarly, setReviewEarly] = useState(false);
  const retryText = useRef<{ body: string; id: string } | null>(null);
  const confirmKey = useRef<{ revision: number; key: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const draftUrl = (id: string) => `/api/reportar/drafts/${encodeURIComponent(id)}`;

  const applyDraft = useCallback((d: DraftView) => {
    setDraft(d);
    setModifying(false);
    setReviewEarly(false);
  }, []);

  const createDraft = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      applyDraft(await api<DraftView>("/api/reportar/drafts", { method: "POST", json: { territorySlug } }));
      setPending([]);
      setLocation(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [territorySlug, applyDraft]);

  // Al entrar: retomar el último borrador o crear uno si no hay reportes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api<MyReportItem[]>(`/api/reportar/drafts?territory=${encodeURIComponent(territorySlug)}`);
        if (cancelled) return;
        if (list[0]) {
          const d = await api<DraftView>(draftUrl(list[0].id));
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
      if (document.hidden) return;
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
  }, [draft?.messages.length, pending.length, location, modifying, reviewEarly]);

  async function sendBody(body: string) {
    if (!draft) return;
    // Reintentar el mismo texto reutiliza su clientMessageId: el servidor no lo duplica.
    const id = retryText.current?.body === body ? retryText.current.id : newId();
    retryText.current = { body, id };
    setError(null);
    setLocation(null);
    setPending((p) => [...p, { clientMessageId: id, body, kind: "text" }]);
    try {
      applyDraft(await api<DraftView>(`${draftUrl(draft.id)}/messages`, { method: "POST", json: { clientMessageId: id, body } }));
      retryText.current = null;
      setPending((p) => p.filter((x) => x.clientMessageId !== id));
    } catch (err) {
      setPending((p) => p.filter((x) => x.clientMessageId !== id));
      setText((t) => t || body);
      setError(errorMessage(err));
    }
  }

  function sendText(e?: React.FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    if (composer.current) composer.current.style.height = "auto";
    void sendBody(body);
  }

  async function sendPhoto(file: File, clientMessageId = newId()) {
    if (!draft) return;
    setError(null);
    setLocation(null);
    const preview = file.type.startsWith("image/") && !/hei[cf]/i.test(file.type) ? URL.createObjectURL(file) : undefined;
    setPending((p) => [...p.filter((x) => x.clientMessageId !== clientMessageId), { clientMessageId, body: file.name, kind: "photo", file, preview }]);
    const form = new FormData();
    form.append("file", file);
    form.append("clientMessageId", clientMessageId);
    try {
      applyDraft(await api<DraftView>(`${draftUrl(draft.id)}/attachments`, { method: "POST", body: form }));
      setPending((p) => p.filter((x) => x.clientMessageId !== clientMessageId));
      if (preview) URL.revokeObjectURL(preview);
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
      applyDraft(await api<DraftView>(`${draftUrl(draft.id)}/location`, { method: "POST", json: loc }));
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
      applyDraft(await api<DraftView>(`${draftUrl(draft.id)}/confirm`, { method: "POST", json: { idempotencyKey: confirmKey.current.key } }));
      setLocation(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function focusComposer(placeholder?: string) {
    if (composer.current) {
      if (placeholder) composer.current.placeholder = placeholder;
      composer.current.focus();
    }
  }

  if (loading) {
    return (
      <Shell territorySlug={territorySlug}>
        <p role="status" className="p-6 text-ink-2">Cargando…</p>
      </Shell>
    );
  }
  if (fatal || !draft) {
    return (
      <Shell territorySlug={territorySlug}>
        <p role="alert" className="card m-6 border-danger-line p-4 text-danger-strong">{fatal ?? "No pudimos abrir el chat."}</p>
      </Shell>
    );
  }

  const territory = draft.territory;
  const confirmed = draft.status === "confirmed";
  const lastUiIndex = lastIndexWithUi(draft.messages);
  const lastUi = lastUiIndex >= 0 ? draft.messages[lastUiIndex].ui : null;
  const status = statusOf(draft, lastUi);
  const area = draft.location?.confirmed ? draft.location.areaName : null;

  const review = (
    <div className="flex w-full flex-col gap-3">
      <ReviewCard
        draft={draft}
        busy={busy}
        onConfirm={confirmReport}
        onModify={() => {
          setModifying(true);
          focusComposer("Escribí qué querés cambiar…");
        }}
      />
      {modifying && (
        <div className="flex flex-col gap-2">
          <p className="text-[15px] text-ink-2">Escribime qué querés cambiar, o elegí:</p>
          <QuickReplies>
            <button type="button" className="chip" onClick={() => setLocation({ mode: "map" })}>
              <IconMap className="h-[18px] w-[18px]" /> Cambiar ubicación
            </button>
            <button type="button" className="chip" onClick={() => fileInput.current?.click()}>
              <IconCamera className="h-[18px] w-[18px]" /> Agregar foto
            </button>
          </QuickReplies>
        </div>
      )}
    </div>
  );
  const reviewInline = lastUi?.kind === "ready" || reviewEarly;
  // Se puede enviar aunque no haya mensaje "ready" (p. ej. Jev tarda y el worker evalúa después): la ficha
  // aparece igual, salvo que el asistente esté pidiendo algo concreto.
  const fallbackReview = !confirmed && !location && draft.card.ready && !reviewInline && !(lastUi && actionable(lastUi, draft));

  const controls = (m: MessageView) => {
    const ui = m.ui!;
    if (location) return null;
    if (reviewInline) return review;
    return (
      <UiControls
        ui={ui}
        draft={draft}
        busy={busy}
        onLocation={(mode, proposed) => setLocation({ mode, proposed })}
        onConfirmProposed={(p) => confirmLocation({ lon: p.lon, lat: p.lat, source: "geocoded", text: p.label })}
        onPhoto={() => fileInput.current?.click()}
        onFocusText={() => focusComposer("Contá un poco más qué pasa…")}
        onReview={() => setReviewEarly(true)}
      />
    );
  };

  return (
    <Shell territorySlug={territorySlug} territoryName={territory.name} emergencyText={territory.emergencyText}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 px-0 pb-0 pt-3 sm:px-4 sm:pb-4">
        <h1 className="sr-only">{`Reportá un problema en tu ${territory.areaLabel.toLowerCase()}`}</h1>
        <div className="px-3 sm:px-0">
          <StatusBand status={status} areaLabel={territory.areaLabel} area={area} code={draft.publicCode} />
        </div>

        <section aria-label="Chat" className="flex flex-1 flex-col border-line-soft bg-surface sm:rounded-2xl sm:border sm:shadow-sm">
          <div className="flex-1 px-3 py-4 sm:px-6 sm:py-6">
          <ol aria-label="Conversación" aria-live="polite" className="flex flex-col gap-5">
            <li className="flex justify-center">
              <span className="badge badge-muted">Hoy · {territory.name}</span>
            </li>
            {draft.messages.map((m, i) => (
              <li key={m.id} className="flex flex-col gap-2">
                <Bubble message={m} draftId={draft.id} emergencyText={territory.emergencyText} />
                {m.ui && !confirmed && i === lastUiIndex && <div className="flex flex-col gap-2 pl-0 sm:pl-11">{controls(m)}</div>}
              </li>
            ))}

            {pending.map((p) => (
              <li key={p.clientMessageId} className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
                {p.kind === "photo" ? (
                  <PhotoCard src={p.preview} name={p.body} state={p.failed ? "failed" : "sending"} />
                ) : (
                  <div className="rounded-2xl rounded-br-none bg-primary px-4 py-2.5 text-white opacity-80">
                    <p className="whitespace-pre-wrap">{p.body}</p>
                  </div>
                )}
                {p.failed ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span role="alert" className="text-[15px] text-danger-strong">{p.failed}</span>
                    {p.file && (
                      <button type="button" className="btn" onClick={() => sendPhoto(p.file!, p.clientMessageId)}>Reintentar</button>
                    )}
                    <button type="button" className="btn" onClick={() => setPending((x) => x.filter((y) => y.clientMessageId !== p.clientMessageId))}>
                      Descartar
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-ink-2">Enviando…</span>
                )}
              </li>
            ))}

            {location && !confirmed && (
              <li className="sm:pl-11">
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
              </li>
            )}

            {fallbackReview && (
              <li className="flex flex-col gap-2">
                <div className="flex max-w-[92%] items-start gap-3">
                  <BotAvatar />
                  <p className="rounded-2xl rounded-tl-none bg-surface-low px-4 py-3">Revisá tu reporte antes de mandarlo:</p>
                </div>
                <div className="sm:pl-11">{review}</div>
              </li>
            )}

            {(draft.analysisPending || pending.some((p) => !p.failed)) && (
              <li className="flex items-center gap-3" role="status">
                <BotAvatar />
                <span className="rounded-2xl rounded-tl-none bg-surface-low px-4 py-3 text-ink-2">
                  <span className="sr-only">Radar Urbano está analizando tu mensaje</span>
                  <span aria-hidden className="inline-flex gap-1">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-ink-2 [animation-delay:-0.2s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-ink-2 [animation-delay:-0.1s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-ink-2" />
                  </span>
                </span>
              </li>
            )}

            {confirmed && (
              <li>
                <Tracking draft={draft} onNew={createDraft} busy={busy} />
              </li>
            )}
          </ol>
            <div ref={bottom} className="scroll-mb-40" />
          </div>

          {!confirmed && (
            <div className="sticky bottom-0 z-[500] border-t border-line-soft bg-surface/95 px-3 pb-2 pt-3 backdrop-blur sm:px-4">
              {error && (
                <p role="alert" className="mb-2 rounded-lg bg-danger-soft px-3 py-2 text-danger-strong">{error}</p>
              )}
              <form onSubmit={sendText} className="flex items-end gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept={PHOTO_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) sendPhoto(f);
                  }}
                />
                <button
                  type="button"
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-surface-low text-ink hover:text-accent"
                  onClick={() => fileInput.current?.click()}
                  aria-label="Adjuntar foto"
                >
                  <IconCamera />
                </button>
                <label htmlFor="composer" className="sr-only">Mensaje</label>
                <textarea
                  ref={composer}
                  id="composer"
                  className="field max-h-40 min-h-12 resize-none rounded-xl py-3"
                  rows={1}
                  value={text}
                  maxLength={2000}
                  placeholder="Escribí un mensaje…"
                  enterKeyHint="send"
                  onChange={(e) => {
                    setText(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                />
                <button
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-ink hover:bg-primary disabled:opacity-55"
                  disabled={!text.trim()}
                  aria-label="Enviar mensaje"
                >
                  <IconSend />
                </button>
              </form>
              <p className="mt-2 text-center text-xs text-ink-2">Te responde un asistente automático.</p>
            </div>
          )}
        </section>
      </main>
    </Shell>
  );
}

function Shell({ territorySlug, territoryName, emergencyText, children }: { territorySlug: string; territoryName?: string; emergencyText?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="reportar" territorySlug={territorySlug} territoryName={territoryName} emergencyText={emergencyText} />
      {children}
    </div>
  );
}

type Status = { text: string; tone: "neutral" | "working" | "action" | "ready" | "done" };

/** Estado real del borrador (nada de pasos fijos): lo que falta o lo que está pasando. */
function statusOf(draft: DraftView, lastUi: MessageUi | null): Status {
  if (draft.status === "confirmed") return { text: `Enviado · ${draft.tracking?.statusLabel ?? "recibido"}`, tone: "done" };
  if (draft.analysisPending) return { text: "Analizando tu mensaje…", tone: "working" };
  if (lastUi?.kind === "propose_location" && draft.location?.confirmed) return { text: "Confirmá la nueva ubicación", tone: "action" };
  if (draft.card.missing.includes("description")) return { text: "Contanos qué pasa", tone: "action" };
  if (draft.card.missing.includes("location")) return { text: "Falta indicar dónde es", tone: "action" };
  if (draft.card.ready) return { text: "Listo para enviar", tone: "ready" };
  return { text: "Revisando tu reporte", tone: "neutral" };
}

function StatusBand({ status, areaLabel, area, code }: { status: Status; areaLabel: string; area: string | null; code: string | null }) {
  const dot = { neutral: "bg-line", working: "bg-warn", action: "bg-accent", ready: "bg-success", done: "bg-success" }[status.tone];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-low px-4 py-2.5">
      <p role="status" className="flex items-center gap-2 font-semibold text-primary">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        {status.text}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {code && <span className="badge badge-info">Código {code}</span>}
        {area && <span className="badge badge-success">{areaLabel} · {area}</span>}
      </div>
    </div>
  );
}

/** El asistente está pidiendo algo concreto que la persona todavía puede responder. */
function actionable(ui: MessageUi, draft: DraftView): boolean {
  const loc = draft.location;
  if (ui.kind === "ask_evidence") return true;
  if (ui.kind === "ask_location") return !loc?.confirmed;
  if (ui.kind === "propose_location") return !(loc?.confirmed && Math.abs(loc.lon - ui.lon) < 1e-6 && Math.abs(loc.lat - ui.lat) < 1e-6);
  return false;
}

function lastIndexWithUi(messages: MessageView[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const k = messages[i].ui?.kind;
    if (k && k !== "active_hazard" && k !== "status") return i;
  }
  return -1;
}

function BotAvatar() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink" aria-hidden>
      <IconChat className="h-[18px] w-[18px]" />
    </span>
  );
}

function Bubble({ message, draftId, emergencyText }: { message: MessageView; draftId: string; emergencyText: string | null }) {
  const at = time(message.createdAt);
  if (message.role === "system") return <p className="text-center text-sm text-ink-2">{message.body}</p>;

  if (message.role === "citizen") {
    return (
      <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
        <span className="sr-only">Vos:</span>
        {message.attachmentId ? (
          <PhotoCard src={`/api/reportar/drafts/${encodeURIComponent(draftId)}/photos/${encodeURIComponent(message.attachmentId)}`} state="sent" />
        ) : (
          <div className="rounded-2xl rounded-br-none bg-primary px-4 py-2.5 text-white shadow-sm">
            <p className="whitespace-pre-wrap">{message.body}</p>
          </div>
        )}
        <span className="flex items-center gap-1 pr-1 text-xs text-ink-2">
          {at} <IconCheck className="h-3.5 w-3.5 text-success" />
        </span>
      </div>
    );
  }

  const hazard = message.ui?.kind === "active_hazard";
  return (
    <div className="flex max-w-[92%] items-start gap-3">
      <BotAvatar />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <span className="sr-only">Radar Urbano:</span>
        <div
          role={hazard ? "alert" : undefined}
          className={`rounded-2xl rounded-tl-none px-4 py-3 ${hazard ? "border-2 border-danger-line bg-danger-soft font-semibold text-danger-strong" : "bg-surface-low text-ink"}`}
        >
          {hazard && <IconAlert className="mb-1 h-5 w-5" />}
          <p className="whitespace-pre-wrap">{message.body}</p>
          {hazard && emergencyText && !message.body.includes(emergencyText) && <p className="mt-1">{emergencyText}</p>}
        </div>
        <span className="pl-1 text-xs text-ink-2">Radar Urbano · {at}</span>
      </div>
    </div>
  );
}

function PhotoCard({ src, name, state }: { src?: string; name?: string; state: "sent" | "sending" | "failed" }) {
  return (
    <div className="flex w-64 max-w-full items-center gap-3 rounded-2xl rounded-br-none bg-surface-container p-2.5 shadow-sm">
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-2">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- foto privada servida por ruta autorizada
          <img src={src} alt="Foto adjunta" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-ink-2"><IconCamera /></span>
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate font-semibold text-primary">{name ?? "Foto"}</p>
        {state === "sent" && <span className="badge badge-success mt-1"><IconCheck className="h-3.5 w-3.5" /> Enviada</span>}
        {state === "sending" && <span className="text-sm text-ink-2">Subiendo…</span>}
        {state === "failed" && <span className="text-sm text-danger-strong">No se pudo subir</span>}
      </div>
    </div>
  );
}

function QuickReplies({ children }: { children: React.ReactNode }) {
  return (
    <div role="group" aria-label="Respuestas sugeridas" className="flex flex-wrap gap-2">
      {children}
    </div>
  );
}

/** Respuestas sugeridas según lo que pidió el asistente (equivalen a botones de respuesta en WhatsApp). */
function UiControls({
  ui,
  draft,
  busy,
  onLocation,
  onConfirmProposed,
  onPhoto,
  onFocusText,
  onReview,
}: {
  ui: MessageUi;
  draft: DraftView;
  busy: boolean;
  onLocation: (mode: LocationMode, proposed?: Proposed | null) => void;
  onConfirmProposed: (p: Proposed) => void;
  onPhoto: () => void;
  onFocusText: () => void;
  onReview: () => void;
}) {
  const loc = draft.location;
  // Ubicación ya confirmada: no volver a pedirla. Un pin propuesto se oculta solo si es el punto ya confirmado;
  // un pin de corrección (posterior a la ficha lista) apunta a otro lugar y tiene que poder aceptarse.
  if (loc?.confirmed && ui.kind === "ask_location") return null;
  if (loc?.confirmed && ui.kind === "propose_location" && Math.abs(loc.lon - ui.lon) < 1e-6 && Math.abs(loc.lat - ui.lat) < 1e-6) return null;

  switch (ui.kind) {
    case "ask_location":
      return (
        <QuickReplies>
          <button type="button" className="chip chip-primary" onClick={() => onLocation("address")}>
            <IconPin className="h-[18px] w-[18px]" /> Dirección
          </button>
          <button type="button" className="chip" onClick={() => onLocation("gps")}>
            <IconLocate className="h-[18px] w-[18px]" /> Mi ubicación
          </button>
          <button type="button" className="chip" onClick={() => onLocation("map")}>
            <IconMap className="h-[18px] w-[18px]" /> En el mapa
          </button>
        </QuickReplies>
      );
    case "propose_location": {
      const p = { lon: ui.lon, lat: ui.lat, label: ui.label };
      return (
        <div className="flex flex-col gap-2">
          <p className="inline-flex items-center gap-2 rounded-xl border border-line-soft bg-surface px-3 py-2 font-semibold text-primary">
            <IconPin className="h-[18px] w-[18px] shrink-0" /> {ui.label}
          </p>
          <QuickReplies>
            <button type="button" className="chip chip-primary" disabled={busy} onClick={() => onConfirmProposed(p)}>
              <IconCheck className="h-[18px] w-[18px]" /> Sí, es ahí
            </button>
            <button type="button" className="chip" onClick={() => onLocation("proposed", p)}>
              <IconMap className="h-[18px] w-[18px]" /> Ver en el mapa
            </button>
            <button type="button" className="chip" onClick={() => onLocation("map")}>
              <IconEdit className="h-[18px] w-[18px]" /> Elegir otro punto
            </button>
          </QuickReplies>
        </div>
      );
    }
    case "ask_evidence":
      return (
        <QuickReplies>
          <button type="button" className={`chip ${ui.requestedField === "photo" ? "chip-primary" : ""}`} onClick={onPhoto}>
            <IconCamera className="h-[18px] w-[18px]" /> Mandar una foto
          </button>
          <button type="button" className={`chip ${ui.requestedField === "description" ? "chip-primary" : ""}`} onClick={onFocusText}>
            <IconEdit className="h-[18px] w-[18px]" /> Contar más
          </button>
          {draft.card.ready && (
            <button type="button" className="chip" onClick={onReview}>
              <IconSend className="h-[18px] w-[18px]" /> Enviar así
            </button>
          )}
        </QuickReplies>
      );
    default:
      return null;
  }
}

function CodeBadge({ code }: { code: string }) {
  return (
    <p className="card px-4 py-3 text-center">
      <span className="block text-sm text-ink-2">Código de reporte</span>
      <span className="font-mono text-2xl font-bold tracking-widest text-primary">{code}</span>
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
      <p className="text-[15px] text-ink-2">
        Podés volver a ver este estado desde este mismo navegador. Recibir el reporte no significa que ya esté resuelto.
      </p>
      <button type="button" className="btn btn-primary" onClick={onNew} disabled={busy}>
        Nuevo reporte
      </button>
    </section>
  );
}
