import type { TransitionAssignment } from "../contracts";

/**
 * Punto de integración con Operación. Cuando `src/server/dispatch/transitions.ts` esté en la épica, reemplazar por:
 *
 *   export { transitionAssignment } from "../dispatch/transitions";
 *
 * Mientras tanto la ruta de acciones responde 503 `dispatch_unavailable` (no se simula el despacho).
 */
export const transitionAssignment: TransitionAssignment | null = null;
