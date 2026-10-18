import { describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { parseTemplateUpgradeArgs, upgradeTemplates } from "../../seeds/template-upgrade";
import { templates } from "../../seeds/templates";
import { territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

describe("template-upgrade", () => {
  it("template-upgrade actualiza el texto global cambiado en el seed, inserta las claves nuevas y no toca las de territorio", async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool, { importAreas: false });
    const t = await territoryId(pool);
    const draft = templates.find((x) => x.key === "draft_ready")!;
    await pool.query("update message_templates set body = 'texto viejo' where key = 'draft_ready' and territory_id is null");
    await pool.query("delete from message_templates where key = 'status_not_found'");
    await pool.query(
      "insert into message_templates (territory_id, key, locale, body, variables) values ($1, 'draft_ready', 'es', 'personalizado', '[]')",
      [t],
    );

    const dry = await upgradeTemplates(pool, { keys: ["draft_ready", "status_not_found", "no_existe"], dryRun: true });
    expect(dry).toEqual({ updated: ["draft_ready"], inserted: ["status_not_found"], unchanged: [], unknown: ["no_existe"] });
    expect((await pool.query("select body from message_templates where key = 'draft_ready' and territory_id is null")).rows[0].body).toBe(
      "texto viejo",
    );

    await upgradeTemplates(pool, { keys: ["draft_ready", "status_not_found"] });
    expect((await pool.query("select body from message_templates where key = 'draft_ready' and territory_id is null")).rows[0].body).toBe(
      draft.body,
    );
    expect(
      (await pool.query("select body from message_templates where key = 'draft_ready' and territory_id = $1", [t])).rows[0].body,
    ).toBe("personalizado");
    expect((await pool.query("select count(*)::int as n from message_templates where key = 'status_not_found'")).rows[0].n).toBe(1);
    expect((await pool.query("select data->>'previous_body' as prev from events where kind = 'template_upgraded'")).rows).toEqual([
      { prev: "texto viejo" },
    ]);

    expect(await upgradeTemplates(pool, { keys: "all" })).toMatchObject({ updated: [], inserted: [], unknown: [] });
  });

  it("los argumentos del CLI: una opción mal escrita no termina escribiendo en la base", () => {
    expect(parseTemplateUpgradeArgs({ keys: "draft_ready, ask_location", "dry-run": "true" })).toEqual({
      keys: ["draft_ready", "ask_location"],
      dryRun: true,
    });
    expect(parseTemplateUpgradeArgs({ all: "true" })).toEqual({ keys: "all", dryRun: false });
    for (const bad of <Record<string, string>[]>[
      {},
      { all: "true", keys: "draft_ready" },
      { keys: "true" },
      { all: "x" },
      { all: "true", "dry-run=true": "true" },
      { all: "true", dryrun: "true" },
      { all: "true", "dry-run": "false" },
    ])
      expect(parseTemplateUpgradeArgs(bad)).toBeNull();
  });
});
