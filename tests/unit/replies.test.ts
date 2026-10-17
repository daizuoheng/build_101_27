import { describe, expect, it } from "vitest";
import { policies } from "../../seeds/policies";
import { IntakePolicy } from "@/server/config/policies";
import { classifyReply, extractPublicCode, isOnlyAddress, normalizeReply } from "@/server/intake/replies";
import { newCode } from "@/server/intake/confirm";

const lexicon = IntakePolicy.parse(policies.intake).replies!;

describe("classifyReply", () => {
  it("reconoce respuestas cortas sin importar tildes, mayúsculas ni signos", () => {
    expect(classifyReply("Sí", lexicon)).toBe("yes");
    expect(classifyReply("si!!", lexicon)).toBe("yes");
    expect(classifyReply("Sí, es ahí", lexicon)).toBe("yes");
    expect(classifyReply("dale", lexicon)).toBe("yes");
    expect(classifyReply("No", lexicon)).toBe("no");
    expect(classifyReply("no es ahí", lexicon)).toBe("no");
    expect(classifyReply("ENVIAR", lexicon)).toBe("send");
    expect(classifyReply("mandalo", lexicon)).toBe("send");
    expect(classifyReply("👍", lexicon)).toBe("yes");
    expect(classifyReply("👍🏽", lexicon)).toBe("yes");
    expect(classifyReply("✅", lexicon)).toBe("yes");
  });

  it("un mensaje con más contenido no es una confirmación", () => {
    expect(classifyReply("sí, y además hay basura", lexicon)).toBeNull();
    expect(classifyReply("no sé si es ahí", lexicon)).toBeNull();
    expect(classifyReply("18 de julio y ejido", lexicon)).toBeNull();
  });

  it("normaliza", () => {
    expect(normalizeReply("  ¡Sí,  ES AHÍ!  ")).toBe("si es ahi");
  });
});

describe("extractPublicCode", () => {
  it("encuentra el código en una consulta", () => {
    expect(extractPublicCode("estado de MKGWXM")).toBe("MKGWXM");
    expect(extractPublicCode("¿cómo va el reporte a9umuq?")).toBe("A9UMUQ");
    expect(extractPublicCode("WKTA64")).toBe("WKTA64");
  });

  it("no confunde palabras comunes ni usa caracteres fuera del alfabeto", () => {
    expect(extractPublicCode("hay basura en las calles")).toBeNull();
    expect(extractPublicCode("frente al 1234 de 18 de julio")).toBeNull();
    expect(extractPublicCode("ABCDE0")).toBeNull(); // 0 no existe en el alfabeto
    expect(extractPublicCode("HAY BASURA EN TODAS LAS CALLES")).toBeNull();
    expect(extractPublicCode("CALLES")).toBeNull(); // palabra sola en mayúsculas, sin dígito
    expect(extractPublicCode("estado de MKGWXM")).toBe("MKGWXM"); // sin dígito pero con contexto
  });

  it("un código dentro de un relato no es una consulta de estado", () => {
    expect(extractPublicCode("hay agua en 18 de julio, codigo AB2CD9")).toBeNull();
    expect(extractPublicCode("hola, quiero saber el estado del reporte AB2CD9 por favor")).toBe("AB2CD9");
    expect(extractPublicCode("cual es el estado de AB2CD9")).toBe("AB2CD9");
    expect(extractPublicCode("buenas tardes, estado de AB2CD9, gracias")).toBe("AB2CD9");
    expect(extractPublicCode("en que estado esta AB2CD9")).toBe("AB2CD9");
  });

  it("con Jev diciendo que es consulta de estado, alcanza con encontrar el código", () => {
    expect(extractPublicCode("che, ¿en qué anda lo que mandé ayer, el AB2CD9?")).toBeNull();
    expect(extractPublicCode("che, ¿en qué anda lo que mandé ayer, el AB2CD9?", { requireQueryOnly: false })).toBe("AB2CD9");
    expect(extractPublicCode("hay basura en las CALLES", { requireQueryOnly: false })).toBeNull();
  });
});

describe("isOnlyAddress", () => {
  it("solo la dirección (con relleno) sí; si agrega relato, no", () => {
    expect(isOnlyAddress("18 de julio y ejido", "18 de Julio y Ejido")).toBe(true);
    expect(isOnlyAddress("es en 18 de julio esquina ejido", "18 de Julio y Ejido")).toBe(true);
    expect(isOnlyAddress("frente al 1234 de 18 de julio", "18 de Julio 1234")).toBe(true);
    expect(isOnlyAddress("en 18 de julio y ejido, está lleno de agua", "18 de Julio y Ejido")).toBe(false);
    expect(isOnlyAddress("hay un pozo en 18 de julio 1234", "18 de Julio 1234")).toBe(false);
    expect(isOnlyAddress("creo que esta por ahi", "18 de Julio y Ejido")).toBe(false); // solo relleno
  });
});

describe("newCode", () => {
  it("siempre incluye al menos un dígito", () => {
    for (let i = 0; i < 500; i++) expect(newCode()).toMatch(/^(?=.*[2-9])[A-HJ-NP-Z2-9]{6}$/);
  });
});
