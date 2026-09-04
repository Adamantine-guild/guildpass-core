/**
 * A deterministic resource identifier with namespace isolation
 */
export interface ResourceIdentifier {
  /** The namespace of the resource (e.g., "community", "document") */
  readonly namespace: string;
  /** The segments that identify the specific resource within the namespace */
  readonly segments: readonly string[];
}

/**
 * Configuration options for resource identifier parsing and formatting
 */
export interface ResourceIdConfig {
  /** Maximum length for namespace */
  readonly maxNamespaceLength: number;
  /** Maximum length for each segment */
  readonly maxSegmentLength: number;
  /** Maximum number of segments */
  readonly maxSegments: number;
  /** Maximum total identifier length */
  readonly maxTotalLength: number;
}

/**
 * Error codes for resource identifier validation
 */
export const enum ResourceIdErrorCode {
  EMPTY_NAMESPACE = 'EMPTY_NAMESPACE',
  EMPTY_SEGMENT = 'EMPTY_SEGMENT',
  INVALID_NAMESPACE = 'INVALID_NAMESPACE',
  INVALID_SEGMENT = 'INVALID_SEGMENT',
  NAMESPACE_TOO_LONG = 'NAMESPACE_TOO_LONG',
  SEGMENT_TOO_LONG = 'SEGMENT_TOO_LONG',
  TOO_MANY_SEGMENTS = 'TOO_MANY_SEGMENTS',
  IDENTIFIER_TOO_LONG = 'IDENTIFIER_TOO_LONG',
  MALFORMED_ENCODING = 'MALFORMED_ENCODING',
  INVALID_FORMAT = 'INVALID_FORMAT',
}

/**
 * Error thrown when resource identifier validation fails
 */
export class ResourceIdError extends Error {
  constructor(
    public readonly code: ResourceIdErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceIdError';
  }
}

/**
 * Default configuration for resource identifiers
 */
export const DEFAULT_CONFIG: ResourceIdConfig = {
  maxNamespaceLength: 32,
  maxSegmentLength: 64,
  maxSegments: 8,
  maxTotalLength: 512,
} as const;