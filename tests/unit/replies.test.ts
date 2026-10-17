import { describe, expect, it } from "vitest";
import { policies } from "../../seeds/policies";
import { IntakePolicy } from "@/server/config/policies";
import { classifyReply, extractPublicCode, normalizeReply } from "@/server/intake/replies";

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
  });
});
