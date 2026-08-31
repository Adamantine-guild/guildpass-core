// Export types and interfaces
export type {
  ResourceIdentifier,
  ResourceIdConfig,
} from './types.js';

export {
  ResourceIdError,
  ResourceIdErrorCode,
  DEFAULT_CONFIG,
} from './types.js';

// Export codec functions
export {
  parseResourceId,
  formatResourceId,
  areResourceIdsEqual,
  getCanonicalForm,
  compareResourceIds,
  createResourceId,
} from './codec.js';