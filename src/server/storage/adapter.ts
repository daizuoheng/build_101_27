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

class SupabaseStorage implements StorageAdapter {
  constructor(private url: string, private serviceKey: string, private bucket: string) {}
  private endpoint(key: string) {
    return `${this.url.replace(/\/$/, "")}/storage/v1/object/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    const res = await fetch(this.endpoint(key), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.serviceKey}`, "Content-Type": contentType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(`Supabase Storage put ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  async get(key: string) {
    const res = await fetch(this.endpoint(key), { headers: { Authorization: `Bearer ${this.serviceKey}` } });
    if (!res.ok) throw new Error(`Supabase Storage get ${res.status}`);
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
    storage = new LocalStorage(path.resolve(process.env.STORAGE_LOCAL_DIR ?? "storage"));
  }
  return storage;
}
