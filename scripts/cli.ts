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
    if (!args.territory || !args.file) {
      console.error("uso: import-areas --territory <slug> --file <geojson> [--name-property barrio] [--id-property ogc_fid] [--source-url url]");
      return 2;
    }
    const r = await importAreas(getPool(), {
      territorySlug: args.territory,
      file: args.file,
      nameProperty: args["name-property"] ?? "name",
      idProperty: args["id-property"] ?? "id",
      sourceUrl: args["source-url"],
    });
    console.log(`áreas insertadas: ${r.inserted}, total: ${r.total}`);
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
