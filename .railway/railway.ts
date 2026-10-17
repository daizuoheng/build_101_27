// Infraestructura de Railway como código (reemplaza a railway.json, deprecado). Pasos en docs/superpowers/notes/despliegue.md.
// Builder nativo (Railpack): detecta pnpm por `packageManager`, Node por `engines` y cachea `.next/cache`; sin imagen que mantener.
// Secretos con preserve(): el archivo declara la variable y el valor se pega en Railway, nunca en el repo.
import { defineRailway, github, preserve, project, service } from "railway/iac";

const REPO = "daizuoheng/build_101_27";
const BRANCH = "main";

/**
 * Variables que leen web y worker. Supabase: Postgres en modo sesión (puerto 5432) y Storage privado.
 * `DATABASE_CA_CERT` (opcional) no se declara hasta tener el certificado: cómo agregarla en la guía de despliegue.
 */
const shared = {
  DATABASE_URL: preserve(),
  TYPESAFE_API_KEY: preserve(),
  LLM_BASE_URL: "https://api.deepseek.com",
  LLM_API_KEY: preserve(),
  LLM_MODEL: "deepseek-flash",
  STORAGE_DRIVER: "supabase",
  SUPABASE_URL: preserve(),
  SUPABASE_SERVICE_ROLE_KEY: preserve(),
  SUPABASE_BUCKET: "report-photos",
  NOMINATIM_USER_AGENT: preserve(),
};

// Las dos aplican migraciones antes de arrancar; el advisory lock del migrador las serializa.
const migrate = "pnpm cli migrate";

export default defineRailway(() => {
  const web = service("web", {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: "RAILPACK", buildCommand: "pnpm build" },
    // Binario directo, no `pnpm start`: pnpm como PID 1 no reenvía SIGTERM y el redeploy mataría a la fuerza.
    start: "node_modules/.bin/next start",
    preDeploy: migrate,
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    env: { ...shared, SESSION_SECRET: preserve(), DATABASE_POOL_MAX: "5" },
  });

  const worker = service("worker", {
    source: github(REPO, { branch: BRANCH }),
    // Corre con tsx: en vez de `next build`, el build verifica tipos para no desplegar un worker roto
    // (`pnpm typecheck` genera antes los tipos de rutas con `next typegen`, que en un clon limpio no existen).
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm typecheck",
      // Lo que lee el worker en ejecución (tsx resuelve `@/*` con tsconfig.json) y su pre-deploy (scripts/cli.ts + migrations).
      watchPatterns: [
        "src/server/**",
        "src/shared/**",
        "src/worker/**",
        "migrations/**",
        "scripts/cli.ts",
        "tsconfig.json",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ],
    },
    // tsx reenvía SIGTERM: el worker termina el job en curso y suelta el lease.
    start: "node_modules/.bin/tsx src/worker/index.ts",
    preDeploy: migrate,
    deploy: { restartPolicyType: "ALWAYS" },
    env: { ...shared, DATABASE_POOL_MAX: "3" },
  });

  return project("radar-urbano", { resources: [web, worker] });
});
