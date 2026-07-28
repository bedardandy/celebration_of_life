import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InterviewTurnSchema, PhotoAnalysisSchema } from '@col/schemas';
import { synthesizeFromJsonSchema, synthesizeFromZodSchema } from './schema-walker';

describe('synthesizeFromZodSchema', () => {
  it('produces the emptiest value each type will accept', () => {
    const schema = z
      .object({
        name: z.string(),
        count: z.number(),
        flag: z.boolean(),
        kind: z.enum(['a', 'b', 'c']),
        tags: z.array(z.string()),
        nested: z.object({ inner: z.string() }).strict(),
      })
      .strict();

    expect(synthesizeFromZodSchema(schema)).toEqual({
      name: '',
      count: 0,
      flag: false,
      kind: 'a',
      tags: [],
      nested: { inner: '' },
    });
  });

  it('leaves optional fields out', () => {
    const schema = z.object({ a: z.string(), b: z.string().optional() }).strict();
    expect(synthesizeFromZodSchema(schema)).toEqual({ a: '' });
  });

  it('honours minLength rather than producing something invalid', () => {
    const schema = z.object({ name: z.string().min(3) }).strict();
    const value = synthesizeFromZodSchema(schema);
    expect(schema.safeParse(value).success).toBe(true);
    expect((value as { name: string }).name).toHaveLength(3);
  });

  it('honours a minimum on a number', () => {
    const schema = z.object({ score: z.number().min(0.5).max(1) }).strict();
    expect(synthesizeFromZodSchema(schema)).toEqual({ score: 0.5 });
  });

  it('honours minItems', () => {
    const schema = z.object({ list: z.array(z.string()).min(2) }).strict();
    expect(synthesizeFromZodSchema(schema)).toEqual({ list: ['', ''] });
  });

  it('takes the first branch of a union', () => {
    const schema = z.object({ v: z.union([z.number(), z.string()]) }).strict();
    const value = synthesizeFromZodSchema(schema);
    expect(schema.safeParse(value).success).toBe(true);
  });

  it('uses a default when the schema declares one', () => {
    const schema = z.object({ mode: z.string().default('quiet') }).strict();
    expect(synthesizeFromZodSchema(schema)).toEqual({ mode: 'quiet' });
  });

  it('round-trips the real schemas the product uses', () => {
    for (const schema of [PhotoAnalysisSchema, InterviewTurnSchema]) {
      const value = synthesizeFromZodSchema(schema);
      const parsed = schema.safeParse(value);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    }
  });
});

describe('synthesizeFromJsonSchema', () => {
  it('resolves internal $refs', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/leaf' } },
      required: ['a'],
      $defs: { leaf: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
    };
    expect(synthesizeFromJsonSchema(schema)).toEqual({ a: { x: '' } });
  });

  it('prefers const over everything', () => {
    expect(synthesizeFromJsonSchema({ type: 'string', const: 'fixed' })).toBe('fixed');
  });

  it('falls back to null for a node it cannot read', () => {
    expect(synthesizeFromJsonSchema({})).toBeNull();
  });
});
