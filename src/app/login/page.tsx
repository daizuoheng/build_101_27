"use client";

import { useState } from "react";
import { api, errorMessage } from "../_components/http";

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
      const next = new URLSearchParams(window.location.search).get("next");
      // Solo rutas internas relativas: evita redirecciones abiertas.
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : res.home;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Radar Urbano</h1>
        <p className="text-ink-2">Acceso para operación y unidades.</p>
      </div>
      <form onSubmit={submit} className="card flex flex-col gap-4 p-5">
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Usuario</span>
          <input className="field" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Contraseña</span>
          <input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft p-3 text-danger">
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
