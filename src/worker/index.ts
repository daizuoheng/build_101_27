import { hostname } from "node:os";
import { loadEnv } from "../server/env";

loadEnv();

async function main() {
  const { getDeps } = await import("../server/deps");
  const { handlers } = await import("../server/jobs/handlers");
  const { runWorker } = await import("../server/jobs/worker-loop");
  const { periodicPlanTask } = await import("../server/pipeline/plan");
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());
  const workerId = `${hostname()}:${process.pid}`;
  const log = (m: string) => console.log(new Date().toISOString(), m);
  const periodic = periodicPlanTask(handlers, getDeps().pool, log);
  console.log(`worker ${workerId} iniciado${periodic ? "" : " (sin handler plan: replanificación periódica apagada)"}`);
  await runWorker(getDeps(), handlers, { workerId, signal: controller.signal, log, periodic });
  await getDeps().pool.end();
  console.log("worker detenido");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
