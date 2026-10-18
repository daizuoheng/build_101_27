import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Storage privado de fotos. Nunca se expone por URL pública: se sirve tras autorizar. */
export interface StorageAdapter {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

class LocalStorage implements StorageAdapter {
  constructor(private root: string) {}
  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("clave de storage inválida");
    return full;
  }
  async put(key: string, bytes: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
  async get(key: string) {
    return readFile(this.resolve(key));
  }
}

/**
 * Supabase Storage por REST con la clave de servicio, sobre un bucket privado.
 * Las claves nuevas (`sb_secret_…`) no son JWT y van solo en `apikey`; la `service_role` heredada (JWT)
 * va además como `Authorization: Bearer`.
 */
class SupabaseStorage implements StorageAdapter {
  private readonly auth: Record<string, string>;
  constructor(private url: string, serviceKey: string, private bucket: string) {
    const jwt = serviceKey.split(".").length === 3;
    this.auth = jwt ? { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } : { apikey: serviceKey };
  }
  private endpoint(key: string) {
    return `${this.url.replace(/\/$/, "")}/storage/v1/object/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    const res = await fetch(this.endpoint(key), {
      method: "POST",
      headers: { ...this.auth, "Content-Type": contentType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(`Supabase Storage put ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  async get(key: string) {
    const res = await fetch(this.endpoint(key), { headers: this.auth });
    if (!res.ok) throw new Error(`Supabase Storage get ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

let storage: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (storage) return storage;
  const driver = process.env.STORAGE_DRIVER ?? "local";
  if (driver === "supabase") {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_BUCKET) throw new Error("faltan variables SUPABASE_* para STORAGE_DRIVER=supabase");
    storage = new SupabaseStorage(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET);
  } else {
    // En Railway web y worker son contenedores distintos con disco efímero: el disco local perdería fotos.
    if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT) throw new Error("STORAGE_DRIVER=local no sirve en Railway: usá supabase");
    // Directorio de datos en tiempo de ejecución, no código: fuera del rastreo de archivos del build.
    storage = new LocalStorage(path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_LOCAL_DIR ?? "storage"));
  }
  return storage;
}
