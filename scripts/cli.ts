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
  // Lleva las plantillas globales al texto del seed (los seeds nunca pisan filas); no toca las de territorio.
  "template-upgrade": async () => async () => {
    const { getPool } = await import("../src/server/db/pool");
    const { parseTemplateUpgradeArgs, upgradeTemplates } = await import("../seeds/template-upgrade");
    // Tokens crudos (después de `cli.ts template-upgrade`): el parseArgs genérico perdería un flag mal escrito.
    const opts = parseTemplateUpgradeArgs(process.argv.slice(3));
    if (!opts) {
      console.error("uso: template-upgrade (--keys <ask_location[,draft_ready,...]> | --all) [--dry-run]");
      return 2;
    }
    const { keys: selection, dryRun } = opts;
    // Una clave mal escrita no deja aplicadas las demás a medias: primero se mira y, si hay desconocidas, no se escribe.
    let r = await upgradeTemplates(getPool(), { keys: selection, dryRun: true });
    if (!dryRun && !r.unknown.length) r = await upgradeTemplates(getPool(), { keys: selection });
    const list = (xs: string[]) => xs.join(", ") || "ninguna";
    console.log(dryRun ? "simulación, sin cambios en la base" : r.unknown.length ? "claves desconocidas: no se aplicó nada" : "aplicado");
    console.log(`actualizadas: ${list(r.updated)}`);
    console.log(`insertadas: ${list(r.inserted)}`);
    console.log(`sin cambios: ${list(r.unchanged)}`);
    console.log(`desconocidas: ${list(r.unknown)}`);
    return r.unknown.length ? 2 : 0;
  },
  "seed-demo": async () => async (args) => {
    const { getPool } = await import("../src/server/db/pool");
    const { seedDemo } = await import("../seeds/demo");
    const r = await seedDemo(getPool(), args.territory ?? "montevideo");
    console.log(`unidades creadas: ${r.unitsCreated.join(", ") || "ninguna (ya existían)"}`);
    console.log(`usuarios creados: ${r.usersCreated.join(", ") || "ninguno (ya existían)"}`);
    console.log("posiciones de demo sin fecha: correr `pnpm cli refresh-demo-positions --near <lat,lon> --watch 10` antes de la demo");
  },
  "refresh-demo-positions": async () => async (args) => {
    const { getPool } = await import("../src/server/db/pool");
    const { refreshDemoPositions } = await import("../seeds/demo");
    let near: { lon: number; lat: number } | undefined;
    if (args.near) {
      const [lat, lon] = args.near.split(",").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.error("uso: refresh-demo-positions [--near <lat,lon>] [--watch <minutos>]");
        return 2;
      }
      near = { lon, lat };
    }
    const run = async () => {
      const n = await refreshDemoPositions(getPool(), args.territory ?? "montevideo", { near });
      console.log(`${new Date().toLocaleTimeString()} posiciones simuladas marcadas vigentes: ${n} unidad(es)${near ? `; cuadrilla de la demo en ${args.near}` : ""}`);
    };
    await run();
    // Las posiciones vencen (planning.position_max_age_min): durante la demo se renuevan solas hasta Ctrl+C.
    const every = Number(args.watch);
    if (args.watch && every > 0) {
      console.log(`renovando cada ${every} min; Ctrl+C para cortar`);
      for (;;) {
        await new Promise((r) => setTimeout(r, every * 60_000));
        await run();
      }
    }
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
