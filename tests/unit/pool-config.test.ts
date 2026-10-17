import { describe, expect, it } from "vitest";
import { poolConfig } from "@/server/db/pool";

const SESSION = "postgresql://postgres.abcd:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres";

describe("poolConfig", () => {
  it("local sin TLS", () => {
    expect(poolConfig("postgres://localhost/radar_urbano", {}).ssl).toBeUndefined();
  });

  it("Supabase en modo sesión: TLS sin CA cifra sin verificar", () => {
    expect(poolConfig(SESSION, {}).ssl).toEqual({ rejectUnauthorized: false });
  });

  it("con DATABASE_CA_CERT verifica el servidor y acepta saltos de línea escapados", () => {
    const ssl = poolConfig(SESSION, { DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----" }).ssl;
    expect(ssl).toEqual({ ca: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----", rejectUnauthorized: true });
  });

  it("descarta sslmode de la URL para que no pise la configuración TLS", () => {
    const cfg = poolConfig(`${SESSION}?sslmode=require&application_name=web`, {});
    expect(cfg.connectionString).not.toContain("sslmode");
    expect(cfg.connectionString).toContain("application_name=web");
  });

  it("rechaza el pooler transaccional (6543): el migrador y los jobs necesitan sesión", () => {
    expect(() => poolConfig(SESSION.replace(":5432", ":6543"), {})).toThrow(/modo sesión/);
  });

  it("tamaño del pool por entorno", () => {
    expect(poolConfig(SESSION, { DATABASE_POOL_MAX: "3" }).max).toBe(3);
  });
});
