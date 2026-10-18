"use client";

import { useSyncExternalStore } from "react";
import { Icon } from "./Icons";
import { THEME_KEY, type ThemeChoice } from "./theme";

// Selector de apariencia de la consola. «Sistema» (por defecto) sigue a prefers-color-scheme;
// «Claro»/«Oscuro» se guardan en este navegador y fijan `data-theme` en el contenedor `.ops`.

const EVENT = "ru-theme-change";

function read(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function apply(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* almacenamiento bloqueado: se aplica solo a esta pestaña */
  }
  document.querySelectorAll<HTMLElement>(".ops").forEach((el) => {
    if (choice === "system") delete el.dataset.theme;
    else el.dataset.theme = choice;
  });
  window.dispatchEvent(new Event(EVENT));
}

const OPTIONS: { value: ThemeChoice; label: string; icon: "monitor" | "sun" | "moon" }[] = [
  { value: "system", label: "Sistema", icon: "monitor" },
  { value: "light", label: "Claro", icon: "sun" },
  { value: "dark", label: "Oscuro", icon: "moon" },
];

/** Control segmentado accesible (grupo de radio). `compact` muestra solo íconos con nombre accesible. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const current = useSyncExternalStore(subscribe, read, () => "system" as ThemeChoice);
  return (
    <div role="radiogroup" aria-label="Apariencia" className="ops-segmented">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={current === o.value}
          aria-label={compact ? o.label : undefined}
          title={o.label}
          className="ops-segment"
          onClick={() => apply(o.value)}
        >
          <Icon name={o.icon} size={18} />
          {!compact && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
