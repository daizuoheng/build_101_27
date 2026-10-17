import { getPool } from "./db/pool";
import { createJevClient } from "./ai/jev/client";
import { createLlmClient } from "./ai/llm/client";
import { getStorage } from "./storage/adapter";
import type { IntakeDeps } from "./intake/orchestrator";

let deps: IntakeDeps | null = null;

/** Dependencias reales compartidas por web y worker. Los tests construyen las suyas. */
export function getDeps(): IntakeDeps {
  deps ??= { pool: getPool(), jev: createJevClient(), llm: createLlmClient(), storage: getStorage() };
  return deps;
}
