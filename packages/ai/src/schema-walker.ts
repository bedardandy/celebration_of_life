/**
 * The smallest object a schema will accept.
 *
 * The mock provider needs *something* schema-valid to hand back when no fixture
 * covers a request, otherwise every new call site has to grow a fixture before
 * a single test can be written. Synthesising an empty-but-valid object keeps the
 * mock useful without anyone inventing fake family content by accident: strings
 * come back empty, numbers zero, arrays empty. It is obviously a placeholder,
 * which is exactly what we want it to look like.
 */
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export class SchemaSynthesisError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`cannot synthesize a value at ${path || '(root)'}: ${message}`);
    this.name = 'SchemaSynthesisError';
  }
}

/**
 * Minimal value satisfying a JSON Schema as produced by `z.toJSONSchema`.
 * Honours the constraints that would otherwise make the "minimal" value invalid
 * — `minLength`, `minItems`, `minimum`, `enum`, `const`.
 */
export function synthesizeFromJsonSchema(schema: JsonSchema, path = ''): unknown {
  const node = resolveNode(schema, schema, path);
  return build(node, schema, path);
}

/** Same, entered from the zod schema most call sites actually hold. */
export function synthesizeFromZodSchema<T extends z.ZodType>(schema: T): z.output<T> {
  return synthesizeFromJsonSchema(z.toJSONSchema(schema) as JsonSchema) as z.output<T>;
}

/* -------------------------------------------------------------------------- */

function resolveNode(node: JsonSchema, root: JsonSchema, path: string): JsonSchema {
  const ref = node['$ref'];
  if (typeof ref !== 'string') return node;
  if (!ref.startsWith('#')) throw new SchemaSynthesisError(path, `unsupported $ref "${ref}"`);
  const segments = ref
    .slice(1)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) {
      throw new SchemaSynthesisError(path, `$ref "${ref}" does not resolve`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== 'object' || current === null) {
    throw new SchemaSynthesisError(path, `$ref "${ref}" does not resolve`);
  }
  return resolveNode(current as JsonSchema, root, path);
}

function build(node: JsonSchema, root: JsonSchema, path: string): unknown {
  if (node['const'] !== undefined) return node['const'];
  if (node['default'] !== undefined) return node['default'];

  const enumValues = node['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];

  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return build(resolveNode(branches[0] as JsonSchema, root, path), root, `${path}.${key}[0]`);
    }
  }
  const allOf = node['allOf'];
  if (Array.isArray(allOf) && allOf.length > 0) {
    const merged: JsonSchema = {};
    for (const branch of allOf)
      Object.assign(merged, resolveNode(branch as JsonSchema, root, path));
    return build(merged, root, path);
  }

  switch (typeName(node)) {
    case 'string':
      return 'x'.repeat(numberAt(node, 'minLength', 0));
    case 'number':
    case 'integer':
      return minimumNumber(node);
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return buildArray(node, root, path);
    case 'object':
      return buildObject(node, root, path);
    default:
      // An unconstrained node ({} or {"type": ["string","null"]} with nothing
      // usable). Null is the least surprising placeholder.
      return null;
  }
}

function typeName(node: JsonSchema): string | undefined {
  const type = node['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type) && typeof type[0] === 'string') return type[0];
  if (node['properties'] !== undefined) return 'object';
  if (node['items'] !== undefined) return 'array';
  return undefined;
}

function numberAt(node: JsonSchema, key: string, fallback: number): number {
  const raw = node[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function minimumNumber(node: JsonSchema): number {
  const isInt = typeName(node) === 'integer' || node['multipleOf'] === 1;
  const exclusive = node['exclusiveMinimum'];
  if (typeof exclusive === 'number') return isInt ? Math.floor(exclusive) + 1 : exclusive + 1e-6;
  const minimum = node['minimum'];
  if (typeof minimum === 'number') return minimum;
  const maximum = node['maximum'];
  if (typeof maximum === 'number' && maximum < 0) return maximum;
  return 0;
}

function buildArray(node: JsonSchema, root: JsonSchema, path: string): unknown[] {
  const minItems = numberAt(node, 'minItems', 0);
  const prefix = node['prefixItems'];
  const out: unknown[] = [];

  if (Array.isArray(prefix)) {
    prefix.forEach((item, i) => {
      out.push(build(resolveNode(item as JsonSchema, root, path), root, `${path}[${i}]`));
    });
  }
  const items = node['items'];
  if (out.length < minItems) {
    if (typeof items !== 'object' || items === null) {
      throw new SchemaSynthesisError(path, `minItems ${minItems} but no item schema`);
    }
    const itemNode = resolveNode(items as JsonSchema, root, path);
    while (out.length < minItems) {
      out.push(build(itemNode, root, `${path}[${out.length}]`));
    }
  }
  return out;
}

function buildObject(node: JsonSchema, root: JsonSchema, path: string): Record<string, unknown> {
  const properties = (node['properties'] ?? {}) as Record<string, unknown>;
  const required = Array.isArray(node['required']) ? (node['required'] as string[]) : [];
  const out: Record<string, unknown> = {};
  for (const key of required) {
    const child = properties[key];
    if (typeof child !== 'object' || child === null) {
      // Required with no schema: any value will do, and null is honest.
      out[key] = null;
      continue;
    }
    const childPath = path ? `${path}.${key}` : key;
    out[key] = build(resolveNode(child as JsonSchema, root, childPath), root, childPath);
  }
  return out;
}
