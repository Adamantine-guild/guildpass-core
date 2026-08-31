import {
  ResourceIdentifier,
  ResourceIdConfig,
  ResourceIdError,
  ResourceIdErrorCode,
  DEFAULT_CONFIG,
} from './types.js';

/**
 * Delimiter used to separate namespace from segments
 */
const NAMESPACE_DELIMITER = ':';

/**
 * Delimiter used to separate segments
 */
const SEGMENT_DELIMITER = '/';

/**
 * Characters that need to be encoded in segments
 */
const RESERVED_CHARS = new Set([':', '/', '%']);

/**
 * Regular expression for valid namespace characters (alphanumeric, underscore, hyphen)
 */
const NAMESPACE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Encode reserved characters in a segment using percent-encoding
 */
function encodeSegment(segment: string): string {
  return segment.replace(/[:%/]/g, (char) => {
    return '%' + char.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase();
  });
}

/**
 * Decode percent-encoded characters in a segment
 */
function decodeSegment(encoded: string): string {
  try {
    return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => {
      const charCode = parseInt(hex, 16);
      return String.fromCharCode(charCode);
    });
  } catch (error) {
    throw new ResourceIdError(
      ResourceIdErrorCode.MALFORMED_ENCODING,
      `Invalid percent encoding in segment: ${encoded}`,
    );
  }
}

/**
 * Validate namespace syntax
 */
function validateNamespace(namespace: string, config: ResourceIdConfig): void {
  if (!namespace) {
    throw new ResourceIdError(
      ResourceIdErrorCode.EMPTY_NAMESPACE,
      'Namespace cannot be empty',
    );
  }

  if (namespace.length > config.maxNamespaceLength) {
    throw new ResourceIdError(
      ResourceIdErrorCode.NAMESPACE_TOO_LONG,
      `Namespace exceeds maximum length of ${config.maxNamespaceLength} characters`,
    );
  }

  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new ResourceIdError(
      ResourceIdErrorCode.INVALID_NAMESPACE,
      'Namespace must contain only alphanumeric characters, underscores, and hyphens',
    );
  }
}

/**
 * Validate segment content
 */
function validateSegment(segment: string, config: ResourceIdConfig): void {
  if (!segment) {
    throw new ResourceIdError(
      ResourceIdErrorCode.EMPTY_SEGMENT,
      'Segment cannot be empty',
    );
  }

  if (segment.length > config.maxSegmentLength) {
    throw new ResourceIdError(
      ResourceIdErrorCode.SEGMENT_TOO_LONG,
      `Segment exceeds maximum length of ${config.maxSegmentLength} characters`,
    );
  }

  // Check for path traversal patterns
  if (segment === '.' || segment === '..' || segment.includes('\\')) {
    throw new ResourceIdError(
      ResourceIdErrorCode.INVALID_SEGMENT,
      'Segment cannot contain path traversal patterns',
    );
  }
}

/**
 * Parse a resource identifier string into its components
 */
export function parseResourceId(
  identifier: string,
  config: ResourceIdConfig = DEFAULT_CONFIG,
): ResourceIdentifier {
  if (!identifier) {
    throw new ResourceIdError(
      ResourceIdErrorCode.INVALID_FORMAT,
      'Identifier cannot be empty',
    );
  }

  if (identifier.length > config.maxTotalLength) {
    throw new ResourceIdError(
      ResourceIdErrorCode.IDENTIFIER_TOO_LONG,
      `Identifier exceeds maximum length of ${config.maxTotalLength} characters`,
    );
  }

  // Check for malformed percent encoding patterns
  if (identifier.includes('%') && !/^([^%]|%[0-9A-Fa-f]{2})*$/.test(identifier)) {
    throw new ResourceIdError(
      ResourceIdErrorCode.MALFORMED_ENCODING,
      'Invalid percent encoding pattern',
    );
  }

  const colonIndex = identifier.indexOf(NAMESPACE_DELIMITER);
  if (colonIndex === -1) {
    throw new ResourceIdError(
      ResourceIdErrorCode.INVALID_FORMAT,
      'Identifier must contain namespace delimiter (:)',
    );
  }

  const namespace = identifier.slice(0, colonIndex);
  const segmentsPart = identifier.slice(colonIndex + 1);

  validateNamespace(namespace, config);

  if (!segmentsPart) {
    throw new ResourceIdError(
      ResourceIdErrorCode.EMPTY_SEGMENT,
      'At least one segment is required',
    );
  }

  const encodedSegments = segmentsPart.split(SEGMENT_DELIMITER);

  if (encodedSegments.length > config.maxSegments) {
    throw new ResourceIdError(
      ResourceIdErrorCode.TOO_MANY_SEGMENTS,
      `Too many segments: ${encodedSegments.length}, maximum allowed: ${config.maxSegments}`,
    );
  }

  const segments: string[] = [];
  for (const encodedSegment of encodedSegments) {
    if (!encodedSegment) {
      throw new ResourceIdError(
        ResourceIdErrorCode.EMPTY_SEGMENT,
        'Empty segments are not allowed',
      );
    }

    const decodedSegment = decodeSegment(encodedSegment);
    validateSegment(decodedSegment, config);
    segments.push(decodedSegment);
  }

  return {
    namespace,
    segments: Object.freeze(segments),
  };
}

/**
 * Format a resource identifier into its canonical string representation
 */
export function formatResourceId(
  resourceId: ResourceIdentifier,
  config: ResourceIdConfig = DEFAULT_CONFIG,
): string {
  validateNamespace(resourceId.namespace, config);

  if (!resourceId.segments.length) {
    throw new ResourceIdError(
      ResourceIdErrorCode.EMPTY_SEGMENT,
      'At least one segment is required',
    );
  }

  if (resourceId.segments.length > config.maxSegments) {
    throw new ResourceIdError(
      ResourceIdErrorCode.TOO_MANY_SEGMENTS,
      `Too many segments: ${resourceId.segments.length}, maximum allowed: ${config.maxSegments}`,
    );
  }

  const encodedSegments: string[] = [];
  for (const segment of resourceId.segments) {
    validateSegment(segment, config);
    encodedSegments.push(encodeSegment(segment));
  }

  const formatted = `${resourceId.namespace}${NAMESPACE_DELIMITER}${encodedSegments.join(SEGMENT_DELIMITER)}`;

  if (formatted.length > config.maxTotalLength) {
    throw new ResourceIdError(
      ResourceIdErrorCode.IDENTIFIER_TOO_LONG,
      `Formatted identifier exceeds maximum length of ${config.maxTotalLength} characters`,
    );
  }

  return formatted;
}

/**
 * Compare two resource identifiers for equality
 */
export function areResourceIdsEqual(a: ResourceIdentifier, b: ResourceIdentifier): boolean {
  if (a.namespace !== b.namespace) {
    return false;
  }

  if (a.segments.length !== b.segments.length) {
    return false;
  }

  for (let i = 0; i < a.segments.length; i++) {
    if (a.segments[i] !== b.segments[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Create a canonical string representation for comparison purposes
 */
export function getCanonicalForm(resourceId: ResourceIdentifier): string {
  return formatResourceId(resourceId);
}

/**
 * Compare two resource identifiers lexicographically
 * Returns: < 0 if a < b, 0 if a === b, > 0 if a > b
 */
export function compareResourceIds(a: ResourceIdentifier, b: ResourceIdentifier): number {
  const canonicalA = getCanonicalForm(a);
  const canonicalB = getCanonicalForm(b);
  
  if (canonicalA < canonicalB) return -1;
  if (canonicalA > canonicalB) return 1;
  return 0;
}

/**
 * Create a resource identifier with validation
 */
export function createResourceId(
  namespace: string,
  segments: string[],
  config: ResourceIdConfig = DEFAULT_CONFIG,
): ResourceIdentifier {
  const resourceId: ResourceIdentifier = {
    namespace,
    segments: Object.freeze([...segments]),
  };

  // Validate by formatting (which performs all validations)
  formatResourceId(resourceId, config);

  return resourceId;
}