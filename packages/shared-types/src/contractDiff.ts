/**
 * contractDiff.ts
 *
 * JSON Schema-aware diffing engine for API contract compatibility.
 * Compares a published contract snapshot against the current live schemas
 * and classifies changes as BREAKING, ADDITIVE, or NONE.
 *
 * Used by apiContractCompatibility.test.ts to enforce versioning discipline.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractSnapshot {
  version: string;
  snapshotDate: string;
  description: string;
  sharedComponents: Record<string, JsonSchema>;
  endpoints: Record<string, EndpointContract>;
}

export interface EndpointContract {
  method: string;
  path: string;
  requestBody?: JsonSchema;
  successResponse: JsonSchema;
}

export type JsonSchema = Record<string, unknown>;

export interface BreakingChange {
  type:
    | 'removed_endpoint'
    | 'removed_field'
    | 'type_changed'
    | 'enum_narrowed'
    | 'required_added'
    | 'required_field_removed_from_schema'
    | 'response_type_changed'
    | 'request_required_added';
  path: string;
  detail: string;
}

export interface AdditiveChange {
  type: 'added_endpoint' | 'added_optional_field' | 'enum_widened' | 'added_request_optional';
  path: string;
  detail: string;
}

export interface ContractDiffResult {
  breaking: BreakingChange[];
  additive: AdditiveChange[];
  isCompatible: boolean;
}

// ---------------------------------------------------------------------------
// Resolution helpers — inline $ref so we can diff two flat schemas
// ---------------------------------------------------------------------------

function resolveRef(
  ref: string,
  root: ContractSnapshot,
): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object')
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current && typeof current === 'object'
    ? (current as JsonSchema)
    : undefined;
}

function resolveSchema(
  schema: JsonSchema | undefined,
  root: ContractSnapshot,
): JsonSchema {
  if (!schema) return {};
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    return resolveRef(ref, root) ?? {};
  }
  return schema;
}

/**
 * Recursively resolve all $ref pointers inside a schema so we get a fully
 * inlined version for comparison.  Handles nested `items`, `properties`,
 * `allOf`, `oneOf`, `anyOf`.
 */
function deepResolve(schema: JsonSchema, root: ContractSnapshot): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const resolved = resolveRef(ref, root);
    return resolved ? deepResolve(resolved, root) : {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref') continue; // already resolved
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? deepResolve(item as JsonSchema, root)
          : item,
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = deepResolve(value as JsonSchema, root);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Property extraction
// ---------------------------------------------------------------------------

function getProperties(schema: JsonSchema): Record<string, JsonSchema> {
  return (schema.properties as Record<string, JsonSchema>) ?? {};
}

function getRequired(schema: JsonSchema): Set<string> {
  const req = schema.required;
  if (!Array.isArray(req)) return new Set();
  return new Set(req.filter((r): r is string => typeof r === 'string'));
}

function getEnumValues(schema: JsonSchema): string[] | undefined {
  const e = schema.enum;
  if (!Array.isArray(e)) return undefined;
  return e.filter((v): v is string => typeof v === 'string');
}

function getBaseType(schema: JsonSchema): string | undefined {
  return typeof schema.type === 'string' ? schema.type : undefined;
}

// ---------------------------------------------------------------------------
// Field-level diff
// ---------------------------------------------------------------------------

function diffFieldSchemas(
  snapshotField: JsonSchema,
  currentField: JsonSchema,
  path: string,
  rootSnapshot: ContractSnapshot,
  rootCurrent: ContractSnapshot,
): { breaking: BreakingChange[]; additive: AdditiveChange[] } {
  const breaking: BreakingChange[] = [];
  const additive: AdditiveChange[] = [];

  const snapResolved = deepResolve(snapshotField, rootSnapshot);
  const currResolved = deepResolve(currentField, rootCurrent);

  // Type change
  const snapType = getBaseType(snapResolved);
  const currType = getBaseType(currResolved);
  if (snapType && currType && snapType !== currType) {
    breaking.push({
      type: 'type_changed',
      path,
      detail: `Field type changed from "${snapType}" to "${currType}"`,
    });
    return { breaking, additive }; // further checks are moot
  }

  // Enum narrowing / widening
  const snapEnum = getEnumValues(snapResolved);
  const currEnum = getEnumValues(currResolved);
  if (snapEnum && currEnum) {
    const snapSet = new Set(snapEnum);
    const currSet = new Set(currEnum);
    for (const val of snapSet) {
      if (!currSet.has(val)) {
        breaking.push({
          type: 'enum_narrowed',
          path,
          detail: `Enum value "${val}" was removed (was: [${snapEnum.join(', ')}], now: [${currEnum.join(', ')}])`,
        });
      }
    }
    for (const val of currSet) {
      if (!snapSet.has(val)) {
        additive.push({
          type: 'enum_widened',
          path,
          detail: `Enum value "${val}" was added (was: [${snapEnum.join(', ')}], now: [${currEnum.join(', ')}])`,
        });
      }
    }
  }

  return { breaking, additive };
}

// ---------------------------------------------------------------------------
// Endpoint-level diff
// ---------------------------------------------------------------------------

function diffEndpoint(
  endpointKey: string,
  snapshotEp: EndpointContract,
  currentEp: EndpointContract | undefined,
  rootSnapshot: ContractSnapshot,
  rootCurrent: ContractSnapshot,
): { breaking: BreakingChange[]; additive: AdditiveChange[] } {
  const breaking: BreakingChange[] = [];
  const additive: AdditiveChange[] = [];

  if (!currentEp) {
    breaking.push({
      type: 'removed_endpoint',
      path: endpointKey,
      detail: `Endpoint "${snapshotEp.method} ${snapshotEp.path}" was removed`,
    });
    return { breaking, additive };
  }

  // --- Request body comparison ---
  if (snapshotEp.requestBody && currentEp.requestBody) {
    const snapBody = deepResolve(snapshotEp.requestBody, rootSnapshot);
    const currBody = deepResolve(currentEp.requestBody, rootCurrent);
    const snapRequired = getRequired(snapBody);
    const currRequired = getRequired(currBody);

    // New required fields in request body are breaking for consumers
    for (const field of currRequired) {
      if (!snapRequired.has(field)) {
        breaking.push({
          type: 'request_required_added',
          path: `${endpointKey}.requestBody`,
          detail: `New required request field "${field}" added`,
        });
      }
    }

    // Compare field shapes
    const snapProps = getProperties(snapBody);
    const currProps = getProperties(currBody);
    for (const [field, snapSchema] of Object.entries(snapProps)) {
      const currSchema = currProps[field];
      if (!currSchema) continue; // field removed — checked below
      const result = diffFieldSchemas(
        snapSchema,
        currSchema,
        `${endpointKey}.requestBody.${field}`,
        rootSnapshot,
        rootCurrent,
      );
      breaking.push(...result.breaking);
      additive.push(...result.additive);
    }

    // Removed request body fields
    for (const field of Object.keys(snapProps)) {
      if (!currProps[field]) {
        // Removing a field from a request body is generally safe (consumers
        // already sending it will still work), but we track it.
        additive.push({
          type: 'added_optional_field',
          path: `${endpointKey}.requestBody`,
          detail: `Request field "${field}" was removed from schema (consumers may still send it)`,
        });
      }
    }
  } else if (snapshotEp.requestBody && !currentEp.requestBody) {
    // Request body removed — consumers can still send it, so this is additive
    additive.push({
      type: 'added_optional_field',
      path: endpointKey,
      detail: 'Request body schema removed from endpoint',
    });
  } else if (!snapshotEp.requestBody && currentEp.requestBody && currentEp.requestBody.required) {
    const bodyRequired = getRequired(deepResolve(currentEp.requestBody, rootCurrent));
    if (bodyRequired.size > 0) {
      breaking.push({
        type: 'request_required_added',
        path: endpointKey,
        detail: `New required request body added with required fields: [${Array.from(bodyRequired).join(', ')}]`,
      });
    }
  }

  // --- Success response comparison ---
  const snapResp = deepResolve(snapshotEp.successResponse, rootSnapshot);
  const currResp = deepResolve(currentEp.successResponse, rootCurrent);

  const snapRespType = getBaseType(snapResp);
  const currRespType = getBaseType(currResp);
  if (snapRespType && currRespType && snapRespType !== currRespType) {
    breaking.push({
      type: 'response_type_changed',
      path: `${endpointKey}.successResponse`,
      detail: `Response type changed from "${snapRespType}" to "${currRespType}"`,
    });
  } else {
    const snapProps = getProperties(snapResp);
    const currProps = getProperties(currResp);
    const snapRequired = getRequired(snapResp);
    const currRequired = getRequired(currResp);

    // New required fields in response are breaking
    for (const field of currRequired) {
      if (!snapRequired.has(field)) {
        breaking.push({
          type: 'required_added',
          path: `${endpointKey}.successResponse`,
          detail: `New required response field "${field}" added`,
        });
      }
    }

    // Compare existing fields
    for (const [field, snapSchema] of Object.entries(snapProps)) {
      const currSchema = currProps[field];
      if (!currSchema) {
        breaking.push({
          type: 'removed_field',
          path: `${endpointKey}.successResponse.${field}`,
          detail: `Response field "${field}" was removed`,
        });
        continue;
      }
      const result = diffFieldSchemas(
        snapSchema,
        currSchema,
        `${endpointKey}.successResponse.${field}`,
        rootSnapshot,
        rootCurrent,
      );
      breaking.push(...result.breaking);
      additive.push(...result.additive);
    }

    // New optional fields in response are additive
    for (const field of Object.keys(currProps)) {
      if (!snapProps[field] && !currRequired.has(field)) {
        additive.push({
          type: 'added_optional_field',
          path: `${endpointKey}.successResponse.${field}`,
          detail: `New optional response field "${field}" added`,
        });
      }
    }
  }

  return { breaking, additive };
}

// ---------------------------------------------------------------------------
// Shared component diff
// ---------------------------------------------------------------------------

function diffSharedComponents(
  snapshot: ContractSnapshot,
  current: ContractSnapshot,
): { breaking: BreakingChange[]; additive: AdditiveChange[] } {
  const breaking: BreakingChange[] = [];
  const additive: AdditiveChange[] = [];

  for (const [name, snapSchema] of Object.entries(snapshot.sharedComponents)) {
    const currSchema = current.sharedComponents[name];
    if (!currSchema) {
      breaking.push({
        type: 'removed_field',
        path: `sharedComponents.${name}`,
        detail: `Shared component "${name}" was removed`,
      });
      continue;
    }
    const result = diffFieldSchemas(
      snapSchema,
      currSchema,
      `sharedComponents.${name}`,
      snapshot,
      current,
    );
    breaking.push(...result.breaking);
    additive.push(...result.additive);
  }

  // New shared components are additive
  for (const name of Object.keys(current.sharedComponents)) {
    if (!snapshot.sharedComponents[name]) {
      additive.push({
        type: 'added_optional_field',
        path: `sharedComponents.${name}`,
        detail: `New shared component "${name}" added`,
      });
    }
  }

  return { breaking, additive };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare a published contract snapshot against the current live contract.
 * Returns a structured diff with breaking and additive changes classified.
 */
export function diffContracts(
  snapshot: ContractSnapshot,
  current: ContractSnapshot,
): ContractDiffResult {
  const breaking: BreakingChange[] = [];
  const additive: AdditiveChange[] = [];

  // 1. Shared components
  const compDiff = diffSharedComponents(snapshot, current);
  breaking.push(...compDiff.breaking);
  additive.push(...compDiff.additive);

  // 2. Endpoints
  for (const [key, snapEp] of Object.entries(snapshot.endpoints)) {
    const currEp = current.endpoints[key];
    const result = diffEndpoint(key, snapEp, currEp, snapshot, current);
    breaking.push(...result.breaking);
    additive.push(...result.additive);
  }

  // 3. New endpoints (not in snapshot)
  for (const key of Object.keys(current.endpoints)) {
    if (!snapshot.endpoints[key]) {
      additive.push({
        type: 'added_endpoint',
        path: key,
        detail: `New endpoint "${current.endpoints[key].method} ${current.endpoints[key].path}" added`,
      });
    }
  }

  return {
    breaking,
    additive,
    isCompatible: breaking.length === 0,
  };
}
