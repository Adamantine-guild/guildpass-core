import { parse, compare, satisfies } from "semver";

/**
 * Custom Error thrown when an invalid semantic version string is provided.
 */
export class InvalidVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVersionError";
  }
}

/**
 * Custom Error thrown when an invalid constraint string is provided.
 */
export class InvalidConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConstraintError";
  }
}

/**
 * Represents a parsed semantic version with strongly typed components.
 */
export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
  build: readonly string[];
  raw: string;
}

/**
 * Represents a version constraint operator.
 */
export type ConstraintOperator = "=" | ">" | ">=" | "<" | "<=";

/**
 * Represents a parsed version constraint.
 */
export interface VersionConstraint {
  operator: ConstraintOperator;
  version: SemanticVersion;
  raw: string;
}

/**
 * Parses a semantic version string into a strongly typed SemanticVersion object.
 * 
 * @param versionString - The semantic version string to parse (e.g., "1.2.3", "2.0.0-beta.1")
 * @returns A SemanticVersion object
 * @throws InvalidVersionError if the version string is malformed
 */
export function parseVersion(versionString: string): SemanticVersion {
  if (typeof versionString !== "string" || versionString.trim() === "") {
    throw new InvalidVersionError(`Invalid version string: "${versionString}"`);
  }

  const parsed = parse(versionString);
  if (!parsed) {
    throw new InvalidVersionError(`Invalid semantic version: "${versionString}"`);
  }

  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
    build: parsed.build,
    raw: parsed.raw,
  };
}

/**
 * Parses a version constraint string into a VersionConstraint object.
 * Supports operators: =, >, >=, <, <=
 * 
 * @param constraintString - The constraint string to parse (e.g., ">=1.2.3", "<2.0.0")
 * @returns A VersionConstraint object
 * @throws InvalidConstraintError if the constraint string is malformed
 */
export function parseConstraint(constraintString: string): VersionConstraint {
  if (typeof constraintString !== "string" || constraintString.trim() === "") {
    throw new InvalidConstraintError(`Invalid constraint string: "${constraintString}"`);
  }

  const trimmed = constraintString.trim();
  
  // Match operator and version
  const match = trimmed.match(/^([><=]+)(.+)$/);
  if (!match) {
    throw new InvalidConstraintError(`Invalid constraint format: "${constraintString}"`);
  }

  const operator = match[1] as ConstraintOperator;
  const versionString = match[2].trim();

  // Validate operator
  const validOperators: ConstraintOperator[] = ["=", ">", ">=", "<", "<="];
  if (!validOperators.includes(operator)) {
    throw new InvalidConstraintError(`Invalid constraint operator: "${operator}"`);
  }

  const version = parseVersion(versionString);

  return {
    operator,
    version,
    raw: trimmed,
  };
}

/**
 * Compares two semantic versions according to semantic version precedence rules.
 * 
 * @param versionA - First version to compare
 * @param versionB - Second version to compare
 * @returns -1 if versionA < versionB, 0 if versionA === versionB, 1 if versionA > versionB
 */
export function compareVersions(versionA: SemanticVersion, versionB: SemanticVersion): number {
  return compare(versionA.raw, versionB.raw);
}

/**
 * Checks if a version satisfies a given constraint.
 * 
 * @param version - The version to check
 * @param constraint - The constraint to evaluate
 * @returns true if the version satisfies the constraint, false otherwise
 */
export function satisfiesConstraint(version: SemanticVersion, constraint: VersionConstraint): boolean {
  const versionString = version.raw;
  const constraintString = constraint.raw;

  try {
    return satisfies(versionString, constraintString);
  } catch (error) {
    throw new InvalidConstraintError(`Failed to evaluate constraint: "${constraintString}"`);
  }
}

/**
 * Evaluates whether a version string satisfies a constraint string.
 * This is a convenience function that combines parsing and evaluation.
 * 
 * @param versionString - The version string to check
 * @param constraintString - The constraint string to evaluate
 * @returns true if the version satisfies the constraint, false otherwise
 * @throws InvalidVersionError if the version string is malformed
 * @throws InvalidConstraintError if the constraint string is malformed
 */
export function evaluate(versionString: string, constraintString: string): boolean {
  const version = parseVersion(versionString);
  const constraint = parseConstraint(constraintString);
  return satisfiesConstraint(version, constraint);
}

/**
 * Determines if version A is greater than version B.
 * 
 * @param versionA - First version
 * @param versionB - Second version
 * @returns true if versionA > versionB
 */
export function isGreaterThan(versionA: SemanticVersion, versionB: SemanticVersion): boolean {
  return compareVersions(versionA, versionB) > 0;
}

/**
 * Determines if version A is greater than or equal to version B.
 * 
 * @param versionA - First version
 * @param versionB - Second version
 * @returns true if versionA >= versionB
 */
export function isGreaterThanOrEqual(versionA: SemanticVersion, versionB: SemanticVersion): boolean {
  return compareVersions(versionA, versionB) >= 0;
}

/**
 * Determines if version A is less than version B.
 * 
 * @param versionA - First version
 * @param versionB - Second version
 * @returns true if versionA < versionB
 */
export function isLessThan(versionA: SemanticVersion, versionB: SemanticVersion): boolean {
  return compareVersions(versionA, versionB) < 0;
}

/**
 * Determines if version A is less than or equal to version B.
 * 
 * @param versionA - First version
 * @param versionB - Second version
 * @returns true if versionA <= versionB
 */
export function isLessThanOrEqual(versionA: SemanticVersion, versionB: SemanticVersion): boolean {
  return compareVersions(versionA, versionB) <= 0;
}

/**
 * Determines if two versions are equal.
 * 
 * @param versionA - First version
 * @param versionB - Second version
 * @returns true if versionA === versionB
 */
export function isEqual(versionA: SemanticVersion, versionB: SemanticVersion): boolean {
  return compareVersions(versionA, versionB) === 0;
}
