// Apariencia de la consola (módulo sin "use client": lo usan los layouts del servidor y el selector).

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "ru-theme";

/** Corre antes de pintar: aplica la elección guardada y evita el parpadeo del tema equivocado. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.currentScript.parentElement.dataset.theme=t}catch(e){}`;
