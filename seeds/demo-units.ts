// Unidades de demo del piloto (ALCANCE §6): la cuadrilla de la demo en vivo, tres cuadrillas móviles y una oficina responsable de zona.
// Posiciones SIMULADAS (is_demo). La seed no les pone fecha: solo `refresh-demo-positions` las marca vigentes.

export type DemoUnit = {
  slug: string;
  name: string;
  unitKind: "mobile_crew" | "zone_office";
  capacity: number;
  capabilities: string[];
  position?: { lon: number; lat: number };
  serviceRadiusM?: number;
  /** Responsabilidad por zona: áreas por external_id del GeoJSON y tipos por slug. */
  zones?: { areaExternalIds: string[]; problemTypes: string[]; precedence: number };
};

/**
 * Cuadrilla de la demo en vivo: atiende todo tipo que se despacha por distancia, así la orden del reporte de la demo
 * le llega a ella sea cual sea la categoría. `refresh-demo-positions --near lat,lon` la ubica donde se hace la demo.
 */
export const DEMO_STAGE_UNIT = "cuadrilla-demo";

export const demoUnits: Record<string, DemoUnit[]> = {
  montevideo: [
    {
      slug: DEMO_STAGE_UNIT,
      name: "Cuadrilla Respuesta Rápida (demo)",
      unitKind: "mobile_crew",
      capacity: 3,
      capabilities: ["limpieza", "vialidad", "fuego", "poda", "señalizacion", "drenaje"],
      position: { lon: -56.1882, lat: -34.9058 }, // centro del territorio, hasta que `--near` la mueva
      serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-limpieza",
      name: "Cuadrilla Limpieza (demo)",
      unitKind: "mobile_crew",
      capacity: 1,
      capabilities: ["limpieza"],
      position: { lon: -56.1916, lat: -34.9035 }, // Centro
      serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-vial",
      name: "Cuadrilla Vialidad y Limpieza (demo)",
      unitKind: "mobile_crew",
      capacity: 1,
      capabilities: ["vialidad", "limpieza"],
      position: { lon: -56.1805, lat: -34.9012 }, // Cordón
      serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-fuego",
      name: "Cuadrilla Fuego y Limpieza (demo)",
      unitKind: "mobile_crew",
      capacity: 1,
      capabilities: ["fuego", "limpieza"],
      position: { lon: -56.2055, lat: -34.9070 }, // Ciudad Vieja
      serviceRadiusM: 3000,
    },
    {
      slug: "oficina-alumbrado",
      name: "Oficina de Alumbrado zona Centro (demo)",
      unitKind: "zone_office",
      capacity: 5,
      capabilities: ["alumbrado"],
      zones: { areaExternalIds: ["51", "50"], problemTypes: ["alumbrado"], precedence: 1 }, // CENTRO, CORDON
    },
  ],
};
