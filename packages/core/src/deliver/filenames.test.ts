/**
 * The file name is part of the product.
 *
 * It gets read aloud down a telephone, typed into a search box by somebody
 * else's IT person, and copied onto a FAT32 stick that will refuse half of
 * Unicode. These tests are mostly about the day that goes wrong.
 */
import { describe, expect, it } from 'vitest';
import { deliverableFilename, deliverableTitle, sanitizeFilenamePart } from './filenames';

describe('folding a name into something a venue machine will open', () => {
  it('keeps an ordinary name readable', () => {
    expect(sanitizeFilenamePart('Ruth Middleton')).toBe('Ruth-Middleton');
  });

  it('strips accents rather than mangling them', () => {
    expect(sanitizeFilenamePart('José García')).toBe('Jose-Garcia');
    expect(sanitizeFilenamePart('Renée Lefèvre')).toBe('Renee-Lefevre');
  });

  it('transliterates the Latin letters that decomposition leaves behind', () => {
    // ø is not an o with a mark on it, so NFKD alone would drop it entirely and
    // leave a stranger reading "Bj rn" off a USB stick.
    expect(sanitizeFilenamePart('Björn Sørensen')).toBe('Bjorn-Sorensen');
    expect(sanitizeFilenamePart('Æsa Þórsdóttir')).toBe('AEsa-Thorsdottir');
  });

  it('removes the punctuation FAT32 and Windows argue about', () => {
    expect(sanitizeFilenamePart('Mary O’Brien')).toBe('Mary-OBrien');
    expect(sanitizeFilenamePart('A/B\\C:D*E?F"G<H>I|J')).toBe('A-B-C-D-E-F-G-H-I-J');
  });

  it('never produces a name that starts or ends with a dot or a dash', () => {
    expect(sanitizeFilenamePart('...hidden...')).toBe('hidden');
    expect(sanitizeFilenamePart('  -- Ruth --  ')).toBe('Ruth');
  });

  it('falls back rather than returning an empty name', () => {
    // A name with nothing ASCII in it is a real case, not an edge case.
    expect(sanitizeFilenamePart('陳美玲')).toBe('Celebration-of-Life');
    expect(sanitizeFilenamePart('   ')).toBe('Celebration-of-Life');
    expect(sanitizeFilenamePart('', 'Tribute')).toBe('Tribute');
  });

  it('caps a very long name instead of producing an unusable path', () => {
    expect(sanitizeFilenamePart('a'.repeat(300)).length).toBeLessThanOrEqual(80);
  });

  it('collapses runs of separators', () => {
    expect(sanitizeFilenamePart('Ruth    Anne     Middleton')).toBe('Ruth-Anne-Middleton');
  });
});

describe('what the download is called', () => {
  it('names the service video without any quality jargon on it', () => {
    expect(
      deliverableFilename({ decedentName: 'Ruth Middleton', cut: 'service', preset: 'final1080' }),
    ).toBe('Ruth-Middleton-Celebration-of-Life-Service.mp4');
  });

  it('marks the family version', () => {
    expect(
      deliverableFilename({ decedentName: 'Ruth Middleton', cut: 'family', preset: 'final1080' }),
    ).toBe('Ruth-Middleton-Celebration-of-Life-Family.mp4');
  });

  it('marks a draft and a backup so neither is played at a funeral by mistake', () => {
    expect(
      deliverableFilename({ decedentName: 'Ruth Middleton', cut: 'service', preset: 'draft360' }),
    ).toContain('Quick-preview');
    expect(
      deliverableFilename({ decedentName: 'Ruth Middleton', cut: 'service', preset: 'backup720' }),
    ).toContain('720p-backup');
  });

  it('offers the same string without an extension, for a heading', () => {
    expect(
      deliverableTitle({ decedentName: 'Ruth Middleton', cut: 'service', preset: 'final1080' }),
    ).toBe('Ruth-Middleton-Celebration-of-Life-Service');
  });

  it('produces something safe even for a name it cannot use', () => {
    const name = deliverableFilename({ decedentName: '///', cut: 'service', preset: 'final1080' });
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.mp4$/);
  });
});
