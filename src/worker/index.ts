import { hostname } from "node:os";
import { loadEnv } from "../server/env";

loadEnv();

async function main() {
  const { getDeps } = await import("../server/deps");
  const { handlers } = await import("../server/jobs/handlers");
  const { runWorker } = await import("../server/jobs/worker-loop");
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());
  const workerId = `${hostname()}:${process.pid}`;
  console.log(`worker ${workerId} iniciado`);
  await runWorker(getDeps(), handlers, {
    workerId,
    signal: controller.signal,
    log: (m) => console.log(new Date().toISOString(), m),
  });
  await getDeps().pool.end();
  console.log("worker detenido");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
