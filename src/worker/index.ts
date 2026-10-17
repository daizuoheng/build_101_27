import { hostname } from "node:os";
import { loadEnv } from "../server/env";

loadEnv();

async function main() {
  const { getDeps } = await import("../server/deps");
  const { handlers } = await import("../server/jobs/handlers");
  const { runWorker } = await import("../server/jobs/worker-loop");
  const { enqueuePeriodicPlans } = await import("../server/pipeline/plan");
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());
  const workerId = `${hostname()}:${process.pid}`;
  console.log(`worker ${workerId} iniciado`);
  await runWorker(getDeps(), handlers, {
    workerId,
    signal: controller.signal,
    log: (m) => console.log(new Date().toISOString(), m),
    // Solo cada cuánto se mira el reloj: el intervalo de replanificación sale de la política planning.replan_interval_min.
    periodic: {
      everyMs: 60_000,
      run: async () => {
        const n = await enqueuePeriodicPlans(getDeps().pool);
        if (n) console.log(new Date().toISOString(), `replanificación periódica: ${n} territorio(s)`);
      },
    },
  });
  await getDeps().pool.end();
  console.log("worker detenido");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
