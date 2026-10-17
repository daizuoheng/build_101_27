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
