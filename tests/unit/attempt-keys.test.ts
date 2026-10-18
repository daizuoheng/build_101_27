import { describe, expect, it } from "vitest";
import { AttemptKeys, RETRY_WINDOW_MS } from "@/app/operacion/_components/idempotency";

const seq = () => {
  let n = 0;
  return () => `k${++n}`;
};

describe("claves de reintento por acción", () => {
  it("un reintento después de un resultado incierto reutiliza la clave y la versión congelada", () => {
    const k = new AttemptKeys(seq());
    const a = k.take("unlink:r1", 3, 0);
    k.settle("unlink:r1", "uncertain", 1_000);
    expect(k.take("unlink:r1", 4, 5_000)).toEqual({ key: a.key, version: 3 });
  });

  it("un éxito o un rechazo del servidor descartan la clave: la próxima vez es un pedido nuevo", () => {
    const k = new AttemptKeys(seq());
    const a = k.take("set:severity", 3, 0);
    k.settle("set:severity", "applied", 10);
    expect(k.take("set:severity", 4, 20).key).not.toBe(a.key);
    const b = k.take("unlink:r1", 4, 30);
    k.settle("unlink:r1", "rejected", 40);
    expect(k.take("unlink:r1", 4, 50).key).not.toBe(b.key);
  });

  it("el éxito de otra acción no descarta la clave incierta de una distinta", () => {
    const k = new AttemptKeys(seq());
    const a = k.take("unlink:r1", 3, 0);
    k.settle("unlink:r1", "uncertain", 10);
    k.take("set:severity", 4, 20);
    k.settle("set:severity", "applied", 30);
    expect(k.take("unlink:r1", 5, 40).key).toBe(a.key);
  });

  it("pasada la ventana desde el último intento incierto, la misma acción es un pedido nuevo (el estado pudo dar la vuelta)", () => {
    const k = new AttemptKeys(seq());
    const a = k.take("unlink:r1", 3, 0);
    k.settle("unlink:r1", "uncertain", 1_000);
    const later = k.take("unlink:r1", 6, 1_000 + RETRY_WINDOW_MS + 1);
    expect(later.key).not.toBe(a.key);
    expect(later.version).toBe(6);
  });

  it("cada intento incierto renueva la ventana", () => {
    const k = new AttemptKeys(seq());
    const a = k.take("unlink:r1", 3, 0);
    k.settle("unlink:r1", "uncertain", 1_000);
    k.take("unlink:r1", 3, RETRY_WINDOW_MS);
    k.settle("unlink:r1", "uncertain", RETRY_WINDOW_MS);
    expect(k.take("unlink:r1", 3, RETRY_WINDOW_MS + 60_000).key).toBe(a.key);
  });
});
