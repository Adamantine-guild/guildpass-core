import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  parseResourceId,
  formatResourceId,
  areResourceIdsEqual,
  getCanonicalForm,
  compareResourceIds,
  createResourceId,
  ResourceIdError,
  ResourceIdErrorCode,
  DEFAULT_CONFIG,
  type ResourceIdentifier,
} from '../dist/index.js';

describe('Resource Identifier Codec', () => {
  describe('parseResourceId', () => {
    test('should parse valid simple identifier', () => {
      const result = parseResourceId('community:abc123');
      assert.deepStrictEqual(result, {
        namespace: 'community',
        segments: ['abc123'],
      });
    });

    test('should parse identifier with multiple segments', () => {
      const result = parseResourceId('document:folder/subfolder/file');
      assert.deepStrictEqual(result, {
        namespace: 'document',
        segments: ['folder', 'subfolder', 'file'],
      });
    });

    test('should parse identifier with encoded special characters', () => {
      const result = parseResourceId('resource:segment%2Fwith%2Fslashes/another%3Awith%3Acolons');
      assert.deepStrictEqual(result, {
        namespace: 'resource',
        segments: ['segment/with/slashes', 'another:with:colons'],
      });
    });

    test('should handle Unicode characters in segments', () => {
      const result = parseResourceId('community:café/naïve/résumé');
      assert.deepStrictEqual(result, {
        namespace: 'community',
        segments: ['café', 'naïve', 'résumé'],
      });
    });

    test('should reject empty identifier', () => {
      assert.throws(
        () => parseResourceId(''),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.INVALID_FORMAT
      );
    });

    test('should reject identifier without namespace delimiter', () => {
      assert.throws(
        () => parseResourceId('communityabc123'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.INVALID_FORMAT
      );
    });

    test('should reject empty namespace', () => {
      assert.throws(
        () => parseResourceId(':abc123'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.EMPTY_NAMESPACE
      );
    });

    test('should reject empty segments', () => {
      assert.throws(
        () => parseResourceId('community:'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.EMPTY_SEGMENT
      );

      assert.throws(
        () => parseResourceId('community:abc//def'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.EMPTY_SEGMENT
      );
    });

    test('should reject namespace with invalid characters', () => {
      assert.throws(
        () => parseResourceId('commu nity:abc123'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.INVALID_NAMESPACE
      );

      assert.throws(
        () => parseResourceId('commu@nity:abc123'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.INVALID_NAMESPACE
      );
    });

    test('should reject namespace that is too long', () => {
      const longNamespace = 'a'.repeat(DEFAULT_CONFIG.maxNamespaceLength + 1);
      assert.throws(
        () => parseResourceId(`${longNamespace}:abc123`),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.NAMESPACE_TOO_LONG
      );
    });

    test('should reject segment that is too long', () => {
      const longSegment = 'a'.repeat(DEFAULT_CONFIG.maxSegmentLength + 1);
      assert.throws(
        () => parseResourceId(`community:${longSegment}`),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.SEGMENT_TOO_LONG
      );
    });

    test('should reject too many segments', () => {
      const manySegments = Array(DEFAULT_CONFIG.maxSegments + 1).fill('seg').join('/');
      assert.throws(
        () => parseResourceId(`community:${manySegments}`),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.TOO_MANY_SEGMENTS
      );
    });

    test('should reject identifier that is too long overall', () => {
      const config = { ...DEFAULT_CONFIG, maxTotalLength: 20 };
      assert.throws(
        () => parseResourceId('community:verylongsegmentname', config),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.IDENTIFIER_TOO_LONG
      );
    });

    test('should reject malformed percent encoding', () => {
      assert.throws(
        () => parseResourceId('community:segment%2'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.MALFORMED_ENCODING
      );

      assert.throws(
        () => parseResourceId('community:segment%ZZ'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.MALFORMED_ENCODING
      );
    });

    test('should reject path traversal patterns', () => {
      assert.throws(
        () => parseResourceId('community:.'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.INVALID_SEGMENT
      );

      assert.throws(
        () => parseResourceId('community:..'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.INVALID_SEGMENT
      );

      assert.throws(
        () => parseResourceId('community:segment\\\\path'),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.INVALID_SEGMENT
      );
    });
  });

  describe('formatResourceId', () => {
    test('should format simple identifier', () => {
      const resourceId: ResourceIdentifier = {
        namespace: 'community',
        segments: ['abc123'],
      };
      assert.strictEqual(formatResourceId(resourceId), 'community:abc123');
    });

    test('should format identifier with multiple segments', () => {
      const resourceId: ResourceIdentifier = {
        namespace: 'document',
        segments: ['folder', 'subfolder', 'file'],
      };
      assert.strictEqual(formatResourceId(resourceId), 'document:folder/subfolder/file');
    });

    test('should encode special characters in segments', () => {
      const resourceId: ResourceIdentifier = {
        namespace: 'resource',
        segments: ['segment/with/slashes', 'another:with:colons', 'percent%signs'],
      };
      const expected = 'resource:segment%2Fwith%2Fslashes/another%3Awith%3Acolons/percent%25signs';
      assert.strictEqual(formatResourceId(resourceId), expected);
    });

    test('should handle Unicode characters', () => {
      const resourceId: ResourceIdentifier = {
        namespace: 'community',
        segments: ['café', 'naïve', 'résumé'],
      };
      assert.strictEqual(formatResourceId(resourceId), 'community:café/naïve/résumé');
    });

    test('should reject empty segments array', () => {
      const resourceId: ResourceIdentifier = {
        namespace: 'community',
        segments: [],
      };
      assert.throws(
        () => formatResourceId(resourceId),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.EMPTY_SEGMENT
      );
    });
  });

  describe('round-trip consistency', () => {
    test('should maintain consistency for simple identifiers', () => {
      const original = 'community:abc123';
      const parsed = parseResourceId(original);
      const formatted = formatResourceId(parsed);
      assert.strictEqual(formatted, original);
    });

    test('should maintain consistency for complex identifiers', () => {
      const original = 'document:folder/subfolder/file';
      const parsed = parseResourceId(original);
      const formatted = formatResourceId(parsed);
      assert.strictEqual(formatted, original);
    });

    test('should maintain consistency for encoded identifiers', () => {
      const original = 'resource:segment%2Fwith%2Fslashes/another%3Awith%3Acolons';
      const parsed = parseResourceId(original);
      const formatted = formatResourceId(parsed);
      assert.strictEqual(formatted, original);
    });

    test('should maintain consistency for Unicode identifiers', () => {
      const original = 'community:café/naïve/résumé';
      const parsed = parseResourceId(original);
      const formatted = formatResourceId(parsed);
      assert.strictEqual(formatted, original);
    });
  });

  describe('areResourceIdsEqual', () => {
    test('should return true for identical identifiers', () => {
      const id1: ResourceIdentifier = { namespace: 'community', segments: ['abc123'] };
      const id2: ResourceIdentifier = { namespace: 'community', segments: ['abc123'] };
      assert.strictEqual(areResourceIdsEqual(id1, id2), true);
    });

    test('should return false for different namespaces', () => {
      const id1: ResourceIdentifier = { namespace: 'community', segments: ['abc123'] };
      const id2: ResourceIdentifier = { namespace: 'document', segments: ['abc123'] };
      assert.strictEqual(areResourceIdsEqual(id1, id2), false);
    });

    test('should return false for different segments', () => {
      const id1: ResourceIdentifier = { namespace: 'community', segments: ['abc123'] };
      const id2: ResourceIdentifier = { namespace: 'community', segments: ['def456'] };
      assert.strictEqual(areResourceIdsEqual(id1, id2), false);
    });

    test('should return false for different segment counts', () => {
      const id1: ResourceIdentifier = { namespace: 'community', segments: ['abc123'] };
      const id2: ResourceIdentifier = { namespace: 'community', segments: ['abc123', 'def456'] };
      assert.strictEqual(areResourceIdsEqual(id1, id2), false);
    });
  });

  describe('getCanonicalForm and compareResourceIds', () => {
    test('should produce canonical form', () => {
      const resourceId: ResourceIdentifier = {
        namespace: 'community',
        segments: ['abc123'],
      };
      assert.strictEqual(getCanonicalForm(resourceId), 'community:abc123');
    });

    test('should compare identifiers lexicographically', () => {
      const id1: ResourceIdentifier = { namespace: 'community', segments: ['abc'] };
      const id2: ResourceIdentifier = { namespace: 'community', segments: ['def'] };
      const id3: ResourceIdentifier = { namespace: 'document', segments: ['abc'] };

      assert.strictEqual(compareResourceIds(id1, id1), 0);
      assert(compareResourceIds(id1, id2) < 0);
      assert(compareResourceIds(id2, id1) > 0);
      assert(compareResourceIds(id1, id3) < 0);
    });
  });

  describe('createResourceId', () => {
    test('should create valid resource identifier', () => {
      const resourceId = createResourceId('community', ['abc123']);
      assert.deepStrictEqual(resourceId, {
        namespace: 'community',
        segments: ['abc123'],
      });
    });

    test('should validate during creation', () => {
      assert.throws(
        () => createResourceId('', ['abc123']),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.EMPTY_NAMESPACE
      );
    });

    test('should freeze segments array', () => {
      const resourceId = createResourceId('community', ['abc123']);
      assert(Object.isFrozen(resourceId.segments));
    });
  });

  describe('custom configuration', () => {
    test('should respect custom length limits', () => {
      const config = {
        maxNamespaceLength: 5,
        maxSegmentLength: 5,
        maxSegments: 2,
        maxTotalLength: 20,
      };

      assert.throws(
        () => parseResourceId('toolong:abc', config),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.NAMESPACE_TOO_LONG
      );

      assert.throws(
        () => parseResourceId('short:toolong', config),
        (err: ResourceIdError) => err.code === ResourceIdErrorCode.SEGMENT_TOO_LONG
      );
    });
  });

  describe('edge cases and boundary conditions', () => {
    test('should handle maximum valid lengths', () => {
      const maxNamespace = 'a'.repeat(DEFAULT_CONFIG.maxNamespaceLength);
      const maxSegment = 'b'.repeat(DEFAULT_CONFIG.maxSegmentLength);
      
      const result = parseResourceId(`${maxNamespace}:${maxSegment}`);
      assert.strictEqual(result.namespace, maxNamespace);
      assert.deepStrictEqual(result.segments, [maxSegment]);
    });

    test('should handle maximum number of segments', () => {
      const segments = Array(DEFAULT_CONFIG.maxSegments).fill('seg');
      const identifier = `community:${segments.join('/')}`;
      
      const result = parseResourceId(identifier);
      assert.strictEqual(result.segments.length, DEFAULT_CONFIG.maxSegments);
    });

    test('should handle all reserved characters', () => {
      const resourceId: ResourceIdentifier = {
        namespace: 'test',
        segments: ['colon:', 'slash/', 'percent%'],
      };
      
      const formatted = formatResourceId(resourceId);
      const parsed = parseResourceId(formatted);
      
      assert.deepStrictEqual(parsed, resourceId);
    });

    test('should handle mixed encoded and unencoded content', () => {
      const original = 'test:normal/encoded%2Fsegment/normal';
      const parsed = parseResourceId(original);
      
      assert.deepStrictEqual(parsed.segments, ['normal', 'encoded/segment', 'normal']);
    });
  });
});