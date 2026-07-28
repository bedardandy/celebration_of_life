import { describe, expect, it } from 'vitest';
import { parseJsonLoose, salvageJsonText, stripCodeFences } from './json';

describe('stripCodeFences', () => {
  it('unwraps a labelled fence', () => {
    expect(stripCodeFences('here you go:\n```json\n{"a":1}\n```\nhope that helps')).toBe('{"a":1}');
  });

  it('keeps the largest fenced block when there are several', () => {
    const raw = '```\nnope\n```\ntext\n```json\n{"a":1,"b":2}\n```';
    expect(stripCodeFences(raw)).toBe('{"a":1,"b":2}');
  });

  it('leaves unfenced text alone', () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('salvageJsonText', () => {
  it('pulls an object out of surrounding prose', () => {
    expect(salvageJsonText('Sure! {"a":1} — let me know.')).toBe('{"a":1}');
  });

  it('respects braces inside strings', () => {
    const raw = 'x {"note":"she said }{ a lot","a":1} y';
    expect(salvageJsonText(raw)).toBe('{"note":"she said }{ a lot","a":1}');
  });

  it('respects escaped quotes inside strings', () => {
    const raw = '{"note":"a \\" then }","a":1} trailing';
    expect(salvageJsonText(raw)).toBe('{"note":"a \\" then }","a":1}');
  });

  it('handles arrays', () => {
    expect(salvageJsonText('result: [1,2,3]')).toBe('[1,2,3]');
  });

  it('returns undefined when there is nothing to salvage', () => {
    expect(salvageJsonText('I would rather not answer that.')).toBeUndefined();
  });
});

describe('parseJsonLoose', () => {
  it('parses clean JSON without reporting a salvage', () => {
    const result = parseJsonLoose('{"a":1}');
    expect(result).toEqual({ ok: true, value: { a: 1 }, salvaged: false });
  });

  it('salvages from a fenced, commented response', () => {
    const result = parseJsonLoose('Of course.\n```json\n{"a":1}\n```\nAnything else?');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1 });
      expect(result.salvaged).toBe(true);
    }
  });

  it('reports a readable reason when nothing parses', () => {
    const result = parseJsonLoose('no json here');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no JSON object or array/);
  });

  it('reports emptiness plainly', () => {
    const result = parseJsonLoose('   ');
    expect(result.ok).toBe(false);
  });
});
