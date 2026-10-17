// Catálogo inicial del piloto (ALCANCE §2). Valores de ejemplo: viven solo acá y se insertan por clave natural.

export const capabilities = [
  { slug: "limpieza", name: "Limpieza" },
  { slug: "vialidad", name: "Vialidad" },
  { slug: "fuego", name: "Respuesta a fuego" },
  { slug: "alumbrado", name: "Alumbrado público" },
  { slug: "poda", name: "Poda y arbolado" },
  { slug: "accesibilidad", name: "Accesibilidad" },
  { slug: "señalizacion", name: "Señalización" },
  { slug: "drenaje", name: "Drenaje" },
];

type Criteria = { is: string; is_not: string; examples: string[] };

export const problemTypes: {
  slug: string;
  name: string;
  description: string;
  criteria: Criteria;
  requires: string[];
}[] = [
  {
    slug: "bache",
    name: "Bache",
    description: "Deterioro en la calzada",
    criteria: {
      is: "A pothole or broken road surface where vehicles drive.",
      is_not: "Damage on the sidewalk (that is vereda_rota).",
      examples: ["pozo enorme en la calle", "se rompió el asfalto en la esquina"],
    },
    requires: ["vialidad"],
  },
  {
    slug: "basura_acumulada",
    name: "Basura acumulada",
    description: "Residuos fuera del lugar previsto o desborde",
    criteria: {
      is: "Garbage outside its container, overflowing containers or dumped waste.",
      is_not: "A damaged or burning container (contenedor_danado / contenedor_fuego).",
      examples: ["bolsas tiradas en la vereda", "el contenedor está desbordado"],
    },
    requires: ["limpieza"],
  },
  {
    slug: "accesibilidad_obstruida",
    name: "Accesibilidad obstruida",
    description: "Rampa, vereda o paso peatonal bloqueado",
    criteria: {
      is: "A ramp, curb cut, sidewalk or pedestrian crossing blocked so people with reduced mobility cannot pass.",
      is_not: "Broken sidewalk tiles without obstruction (vereda_rota).",
      examples: ["hay bolsas tapando la rampa", "un auto estacionado sobre la rampa"],
    },
    requires: ["limpieza"],
  },
  {
    slug: "contenedor_danado",
    name: "Contenedor dañado",
    description: "Quemado sin fuego activo, roto o volcado",
    criteria: {
      is: "A garbage container that is broken, tipped over or burnt WITHOUT active fire now.",
      is_not: "A container that is currently on fire (contenedor_fuego).",
      examples: ["el contenedor está todo quemado", "volcaron el contenedor"],
    },
    requires: ["limpieza"],
  },
  {
    slug: "contenedor_fuego",
    name: "Contenedor con fuego",
    description: "Fuego activo reportado u observado; atención urgente especializada",
    criteria: {
      is: "A container or waste currently burning: flames or active smoke reported or visible.",
      is_not: "Burn marks or a burnt container with no fire now (contenedor_danado).",
      examples: ["se está prendiendo fuego el contenedor", "sale humo y llamas del contenedor"],
    },
    requires: ["fuego"],
  },
  {
    slug: "vereda_rota",
    name: "Vereda rota",
    description: "Baldosas levantadas, hundimiento o superficie deteriorada",
    criteria: {
      is: "Raised or missing tiles, sinking or deteriorated sidewalk surface.",
      is_not: "Road damage where cars drive (bache).",
      examples: ["baldosas levantadas por las raíces", "se hundió la vereda"],
    },
    requires: ["vialidad"],
  },
  {
    slug: "carteleria",
    name: "Cartelería dañada u obstruida",
    description: "Cartel roto, caído, tapado o que obstaculiza el paso",
    criteria: {
      is: "A sign that is broken, fallen, covered or blocking the way, including road signs.",
      is_not: "A fallen tree or branch (arbol_caido).",
      examples: ["el cartel de pare está tirado", "no se ve el cartel por las ramas"],
    },
    requires: ["señalizacion"],
  },
  {
    slug: "alumbrado",
    name: "Alumbrado público",
    description: "Luminaria apagada, dañada o intermitente",
    criteria: {
      is: "A street light that is off, damaged or flickering, as reported by the citizen.",
      is_not: "A daytime photo alone does not prove a light is off; rely on the citizen's statement.",
      examples: ["la columna de luz no prende hace una semana", "la luz titila toda la noche"],
    },
    requires: ["alumbrado"],
  },
  {
    slug: "arbol_caido",
    name: "Árbol o rama caída",
    description: "Obstáculo en vereda o calzada",
    criteria: {
      is: "A fallen tree or branch obstructing sidewalk or road.",
      is_not: "Leaves or minor debris (basura_acumulada).",
      examples: ["se cayó una rama grande sobre la calle", "árbol caído tapando la vereda"],
    },
    requires: ["poda"],
  },
  {
    slug: "desague_obstruido",
    name: "Desagüe obstruido",
    description: "Sumidero tapado o acumulación de agua asociada",
    criteria: {
      is: "A clogged storm drain or water accumulating because a drain is blocked.",
      is_not: "A burst water pipe (out of catalog: other).",
      examples: ["la boca de tormenta está tapada", "se inunda la esquina cada vez que llueve"],
    },
    requires: ["drenaje"],
  },
];

/** Cualquier tipo con peligro activo exige esta capacidad además de las propias. */
export const activeHazardCapability = "fuego";
