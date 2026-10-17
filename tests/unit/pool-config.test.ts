import { describe, expect, it, vi } from "vitest";
import { createPool, poolConfig } from "@/server/db/pool";

const SESSION = "postgresql://postgres.abcd:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres";

describe("poolConfig", () => {
  it("local sin TLS (IPv6, mayúsculas, host por defecto y socket Unix)", () => {
    for (const url of [
      "postgres://localhost/radar_urbano",
      "postgres://LOCALHOST/radar_urbano",
      "postgres://[::1]:5432/radar_urbano",
      "postgres:///radar_urbano",
      "postgres:///radar_urbano?host=/tmp",
    ]) {
      expect(poolConfig(url, {}).ssl, url).toBeUndefined();
    }
  });

  it("?host= remoto pisa al host vacío de la URL: va con TLS", () => {
    expect(poolConfig("postgres:///app?host=db.remote.example", {}).ssl).toEqual({ rejectUnauthorized: false });
  });

  it("sslmode=verify-full sin DATABASE_CA_CERT falla en vez de degradar a TLS sin verificar", () => {
    expect(() => poolConfig(`${SESSION}?sslmode=verify-full`, {})).toThrow(/DATABASE_CA_CERT/);
    expect(() => poolConfig(`${SESSION}?sslmode=verify-ca`, { DATABASE_CA_CERT: "" })).toThrow(/DATABASE_CA_CERT/);
    const cfg = poolConfig(`${SESSION}?sslmode=verify-full`, { DATABASE_CA_CERT: "PEM" });
    expect(cfg.ssl).toEqual({ ca: "PEM", rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain("sslmode");
  });

  it("sslmode=disable apaga TLS en un host remoto (CI, red privada)", () => {
    const cfg = poolConfig("postgres://u:p@db:5432/app?sslmode=disable", {});
    expect(cfg.ssl).toBe(false);
    expect(cfg.connectionString).not.toContain("sslmode");
  });

  it("rechaza archivos de certificado en la URL en vez de ignorarlos", () => {
    expect(() => poolConfig(`${SESSION}?sslrootcert=/etc/ca.pem`, {})).toThrow(/DATABASE_CA_CERT/);
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
    expect(() => poolConfig(`${SESSION.replace(":5432", "")}?port=6543`, {})).toThrow(/modo sesión/);
  });

  it("sslmode explícito manda también en local (túnel hacia la base remota)", () => {
    expect(poolConfig("postgres://localhost:6432/postgres?sslmode=require", {}).ssl).toEqual({ rejectUnauthorized: false });
    expect(poolConfig("postgres://localhost:6432/postgres?sslmode=verify-full", { DATABASE_CA_CERT: "PEM" }).ssl).toEqual({
      ca: "PEM",
      rejectUnauthorized: true,
    });
  });

  it("sslmode sin distinguir mayúsculas; prefer/allow y desconocidos dan error", () => {
    expect(poolConfig("postgres://u:p@db:5432/app?sslmode=DISABLE", {}).ssl).toBe(false);
    expect(() => poolConfig(`${SESSION}?sslmode=VERIFY-FULL`, {})).toThrow(/DATABASE_CA_CERT/);
    for (const mode of ["prefer", "allow", "requiere"]) {
      expect(() => poolConfig(`${SESSION}?sslmode=${mode}`, {}), mode).toThrow(/no se admite/);
    }
  });

  it("tamaño del pool por entorno; vacío usa el default y un valor inválido falla", () => {
    expect(poolConfig(SESSION, { DATABASE_POOL_MAX: "3" }).max).toBe(3);
    expect(poolConfig(SESSION, { DATABASE_POOL_MAX: "" }).max).toBe(10);
    expect(() => poolConfig(SESSION, { DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => poolConfig(SESSION, { DATABASE_POOL_MAX: "cinco" })).toThrow(/DATABASE_POOL_MAX/);
  });

  it("una conexión ociosa cortada por el servidor no tira el proceso", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPool("postgres://localhost/radar_urbano");
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    await pool.end();
  });
});
