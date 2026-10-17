import { config } from "dotenv";

/** Carga `.env.local` y luego `.env` para procesos fuera de Next (CLI, worker, tests). No pisa variables ya definidas. */
export function loadEnv(): void {
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
}
