import { describe, expect, it } from 'vitest';
import { decadeOf, recommendStructure } from './shape';

function eras(spec: Record<string, number>): string[] {
  return Object.entries(spec).flatMap(([era, count]) => Array.from({ length: count }, () => era));
}

describe('reading a decade off a photograph', () => {
  it('takes it from a label or a year, and gives up honestly', () => {
    expect(decadeOf('1960s')).toBe(1960);
    expect(decadeOf('1974')).toBe(1970);
    expect(decadeOf('late 1990s')).toBe(1990);
    expect(decadeOf('unknown')).toBeUndefined();
    expect(decadeOf(null)).toBeUndefined();
    expect(decadeOf('')).toBeUndefined();
  });
});

describe('recommending a shape', () => {
  it('recommends a chronology when a life is spread across the decades', () => {
    const result = recommendStructure({
      eras: eras({ '1940s': 6, '1960s': 8, '1980s': 9, '2000s': 7, '2010s': 5 }),
    });
    expect(result.recommended).toBe('chrono');
    expect(result.decadesCovered).toBe(5);
    expect(result.why).toContain('5 decades');
  });

  it('recommends themes when the photographs cluster in a few years', () => {
    const result = recommendStructure({ eras: eras({ '2010s': 22, '2020s': 9 }) });
    expect(result.recommended).toBe('thematic');
  });

  it('recommends a loose order for everything in between', () => {
    const result = recommendStructure({ eras: eras({ '1980s': 10, '1990s': 8, '2010s': 9 }) });
    expect(result.recommended).toBe('mixed');
  });

  it('does not pretend to know when most photographs are undated', () => {
    const result = recommendStructure({
      eras: [...eras({ '1960s': 2, '1980s': 1, '1990s': 1, '2010s': 1 }), ...Array(20).fill(null)],
    });
    expect(result.recommended).toBe('mixed');
    expect(result.why).toContain('no date');
  });

  it('has something to say about a memorial with no photographs at all', () => {
    const result = recommendStructure({ eras: [] });
    expect(result.recommended).toBe('mixed');
    expect(result.options).toHaveLength(3);
  });

  it('always offers three options, recommendation first, each one only once', () => {
    const result = recommendStructure({
      eras: eras({ '1950s': 4, '1970s': 4, '1990s': 4, '2010s': 4 }),
    });
    expect(result.options[0]?.id).toBe(result.recommended);
    expect(new Set(result.options.map((o) => o.id)).size).toBe(3);
  });

  it('gives the same answer for the same photographs', () => {
    const input = { eras: eras({ '1950s': 3, '1980s': 5, '2000s': 2 }) };
    expect(recommendStructure(input)).toEqual(recommendStructure(input));
  });
});
