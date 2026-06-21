/**
 * observability/index.ts
 *
 * Barrel export for all observability concerns so the rest of the app imports
 * from a single, stable path:
 *
 *   import { buildPinoHttp, maskWallet, registry, metrics } from './observability';
 */

export { buildPinoHttp, maskWallet } from './logger';
export { registry, metrics } from './metrics';
