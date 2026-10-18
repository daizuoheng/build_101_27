"use client";

import { useState } from "react";
import { BrandMark } from "../_components/BrandMark";
import { api, errorMessage } from "../_components/http";

/**
 * Solo rutas del mismo origen: evita redirecciones abiertas. Se resuelve con URL porque el navegador
 * trata `/\evil.com` como `//evil.com` (otro host).
 */
function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith("/")) return null;
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : null;
  } catch {
    return null;
  }
}

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ home: string }>("/api/auth/login", { method: "POST", json: { username, password } });
      window.location.href = safeNext(new URLSearchParams(window.location.search).get("next")) ?? res.home;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <BrandMark size={64} />
        <div>
          <h1 className="ru-wordmark text-[28px] font-bold leading-[34px] text-ink">Radar Urbano</h1>
          <p className="mt-1 text-ink-2">Acceso para operación y unidades</p>
        </div>
      </div>
      <form onSubmit={submit} className="card flex flex-col gap-4 p-5" aria-busy={busy}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[15px] font-semibold">Usuario</span>
          <input className="field" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[15px] font-semibold">Contraseña</span>
          <input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p role="alert" className="rounded-[var(--r-md)] bg-danger-soft p-3 text-danger">
            {error}
          </p>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
    </main>
  );
}
