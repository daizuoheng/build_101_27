"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { applyThemeToDom, readTheme, THEME_INIT_SCRIPT } from "./theme";

const noSubscribe = () => () => {};

/**
 * Aplica la apariencia guardada antes de pintar. En la carga inicial lo hace el script inline del HTML del servidor;
 * cuando React monta el layout en el cliente (navegación) no ejecuta `<script>` y avisa por consola, así que ahí no
 * se emite y el tema lo aplica el efecto.
 */
export function ThemeInit() {
  const fromServer = useSyncExternalStore(noSubscribe, () => false, () => true);
  useLayoutEffect(() => {
    const t = readTheme();
    if (t !== "system") applyThemeToDom(t);
  }, []);
  return fromServer ? <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /> : null;
}
