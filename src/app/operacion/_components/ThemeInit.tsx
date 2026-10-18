"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { THEME_INIT_SCRIPT, THEME_KEY } from "./theme";

const noSubscribe = () => () => {};

/**
 * Aplica la apariencia guardada antes de pintar. En la carga inicial lo hace el script inline del HTML del servidor;
 * cuando React monta el layout en el cliente (navegación) no ejecuta `<script>` y avisa por consola, así que ahí no
 * se emite y el tema lo aplica el efecto.
 */
export function ThemeInit() {
  const fromServer = useSyncExternalStore(noSubscribe, () => false, () => true);
  useLayoutEffect(() => {
    let t: string | null = null;
    try {
      t = localStorage.getItem(THEME_KEY);
    } catch {
      /* almacenamiento bloqueado: queda el tema del sistema */
    }
    if (t !== "light" && t !== "dark") return;
    const theme = t;
    document.querySelectorAll<HTMLElement>(".ops").forEach((el) => {
      el.dataset.theme = theme;
    });
  }, []);
  return fromServer ? <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /> : null;
}
