// Apariencia de la consola (módulo sin "use client": lo usan los layouts del servidor y el selector).

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "ru-theme";

/** Corre antes de pintar: aplica la elección guardada y evita el parpadeo del tema equivocado. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.currentScript.parentElement.dataset.theme=t}catch(e){}`;

/** Elección guardada en este navegador (solo en el cliente). */
export function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Fija (o quita, con «Sistema») `data-theme` en los contenedores `.ops` (solo en el cliente). */
export function applyThemeToDom(choice: ThemeChoice) {
  document.querySelectorAll<HTMLElement>(".ops").forEach((el) => {
    if (choice === "system") delete el.dataset.theme;
    else el.dataset.theme = choice;
  });
}
