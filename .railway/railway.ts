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

// Conexiones: el pooler de sesión de Supabase da un backend por cliente. Peor caso en un redeploy, con el despliegue
// viejo y el nuevo a la vez: (4 web + 3 worker) × 2 = 14, más el migrador y el healthcheck de web. El pool size del proyecto
// (Database Settings → Connection pooling) tiene que alcanzar: ver la guía de despliegue.
// Las dos aplican migraciones antes de arrancar; el advisory lock del migrador las serializa.
const migrate = "pnpm cli migrate";

export default defineRailway(() => {
  const web = service("web", {
    source: github(REPO, { branch: BRANCH }),
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm build",
      // `next build` verifica tipos de todo el include de tsconfig (src, tests, seeds, scripts): solo se excluye lo que
      // no entra ni al build ni al runtime. `.railway/` se aplica con `railway config apply`, no con un deploy.
      watchPatterns: ["**", "!docs/**", "!/*.md", "!.railway/**"],
    },
    // Binario directo, no `pnpm start`: pnpm como PID 1 no reenvía SIGTERM y el redeploy mataría a la fuerza.
    start: "node_modules/.bin/next start",
    preDeploy: migrate,
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ALWAYS" },
    env: { ...shared, SESSION_SECRET: preserve(), DATABASE_POOL_MAX: "4" },
  });

  const worker = service("worker", {
    source: github(REPO, { branch: BRANCH }),
    // Corre con tsx: en vez de `next build`, el build verifica los tipos de lo que el worker importa
    // (no del repo entero: un error solo en src/app no debe frenar ni redesplegar al worker).
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm exec tsc --noEmit -p .railway/tsconfig.worker.json",
      // Lo que verifica el build, lo que lee en ejecución (tsx resuelve `@/*` con tsconfig.json) y su pre-deploy.
      // Anclados a la raíz con `/` (sintaxis gitignore): sin barra, `tsconfig.json` también matchearía el de .railway/.
      watchPatterns: [
        "/src/server/**",
        "/src/shared/**",
        "/src/worker/**",
        "/migrations/**",
        "/scripts/cli.ts",
        "/tsconfig.json",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/.railway/tsconfig.worker.json",
      ],
    },
    // tsx reenvía SIGTERM al worker, que deja de tomar jobs; el que está en curso no se cancela: termina y lo cierra
    // (completeJob/failJob) si le alcanza el drenaje.
    start: "node_modules/.bin/tsx src/worker/index.ts",
    preDeploy: migrate,
    // Railway da por defecto 0 s entre SIGTERM y SIGKILL. 120 s dan margen a un job con varias llamadas a Jev y al LLM
    // (topes de 5 a 20 s por llamada en las políticas sembradas); uno que muera igual con SIGKILL lo retoma otro worker
    // al vencer el lease (60 s) y gasta un intento, como cualquier caída.
    deploy: { restartPolicyType: "ALWAYS", drainingSeconds: 120 },
    env: { ...shared, DATABASE_POOL_MAX: "3" },
  });

  return project("radar-urbano", { resources: [web, worker] });
});
