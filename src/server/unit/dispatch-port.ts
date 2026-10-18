import type { TransitionAssignment } from "../contracts";
import { transitionAssignment as fromDispatch } from "../dispatch/transitions";

/**
 * Punto de integración con Operación: la bandeja de unidad transiciona órdenes con `transitionAssignment`
 * (`src/server/dispatch/transitions.ts`). Si vuelve a quedar en null, la ruta de acciones responde 503
 * `dispatch_unavailable` en vez de simular el despacho.
 */
export const transitionAssignment: TransitionAssignment | null = fromDispatch;
