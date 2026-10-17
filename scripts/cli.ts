import { loadEnv } from "../src/server/env";

loadEnv();

type Command = (args: Record<string, string>) => Promise<number | void>;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = "true";
    }
  }
  return out;
}

const commands: Record<string, () => Promise<Command>> = {
  migrate: async () => async () => {
    const { getPool } = await import("../src/server/db/pool");
    const { migrate } = await import("../src/server/db/migrate");
    const applied = await migrate(getPool());
    console.log(applied.length ? `aplicadas: ${applied.join(", ")}` : "sin migraciones pendientes");
  },
  seed: async () => async () => {
    const { getPool } = await import("../src/server/db/pool");
    const { seedAll } = await import("../seeds");
    await seedAll(getPool());
    const { rows } = await getPool().query(`select
      (select count(*) from problem_types)::int as tipos, (select count(*) from policy_versions where active)::int as politicas,
      (select count(*) from message_templates)::int as plantillas, (select count(*) from areas)::int as areas`);
    console.log("seed ok", rows[0]);
  },
  "smoke-jev": async () => (await import("./smoke-jev")).smokeJev,
  "smoke-llm": async () => (await import("./smoke-llm")).smokeLlm,
  // Publica como versión nueva activa la política del seed de un kind si difiere (los seeds nunca pisan filas).
  "policy-upgrade": async () => async (args) => {
    const { spawnSync } = await import("node:child_process");
    const kinds = (args.kind ?? "").split(",").filter(Boolean);
    if (!kinds.length) {
      console.error("uso: policy-upgrade --kind <grouping[,evaluation,...]> [--territory montevideo]");
      return 2;
    }
    for (const k of kinds) {
      const r = spawnSync("tsx", ["scripts/policy-upgrade.ts", k, "--territory", args.territory ?? "montevideo"], { stdio: "inherit" });
      if (r.status !== 0) return r.status ?? 1;
    }
  },
  "seed-demo": async () => async (args) => {
    const { getPool } = await import("../src/server/db/pool");
    const { seedDemo } = await import("../seeds/demo");
    const r = await seedDemo(getPool(), args.territory ?? "montevideo");
    console.log(`unidades creadas: ${r.unitsCreated.join(", ") || "ninguna (ya existían)"}`);
    console.log(`usuarios creados: ${r.usersCreated.join(", ") || "ninguno (ya existían)"}`);
    console.log("posiciones de demo sin fecha: correr `pnpm cli refresh-demo-positions` antes de la demo");
  },
  "refresh-demo-positions": async () => async (args) => {
    const { getPool } = await import("../src/server/db/pool");
    const { refreshDemoPositions } = await import("../seeds/demo");
    const n = await refreshDemoPositions(getPool(), args.territory ?? "montevideo");
    console.log(`posiciones simuladas marcadas vigentes: ${n} unidad(es)`);
  },
  "reset-demo": async () => async (args) => {
    if (args.yes !== "true") {
      console.error("reset-demo borra reportes, incidentes, órdenes, planes, revisión, jobs y eventos. Confirmá con --yes");
      return 2;
    }
    const { getPool } = await import("../src/server/db/pool");
    const { resetDemo } = await import("../seeds/demo");
    await resetDemo(getPool());
    console.log("datos operativos borrados; configuración, unidades y usuarios conservados");
  },
  "import-areas": async () => async (args) => {
    const { getPool } = await import("../src/server/db/pool");
    const { importAreas } = await import("../src/server/geo/import-areas");
    // El mapeo de propiedades depende de la fuente: sin valores por defecto que puedan no coincidir.
    if (!args.territory || !args.file || !args["name-property"] || !args["id-property"]) {
      console.error("uso: import-areas --territory <slug> --file <geojson> --name-property <prop> --id-property <prop> [--source-url url]");
      return 2;
    }
    const r = await importAreas(getPool(), {
      territorySlug: args.territory,
      file: args.file,
      nameProperty: args["name-property"],
      idProperty: args["id-property"],
      sourceUrl: args["source-url"],
    });
    console.log(`áreas insertadas: ${r.inserted}, actualizadas: ${r.updated}, total: ${r.total}`);
  },
};

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const load = commands[name];
  if (!load) {
    console.error(`uso: pnpm cli <${Object.keys(commands).join(" | ")}> [--opciones]`);
    process.exit(1);
  }
  const code = await (await load())(parseArgs(rest));
  const { getPool } = await import("../src/server/db/pool");
  await getPool().end().catch(() => {});
  process.exit(typeof code === "number" ? code : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
