import { describe, expect, it } from 'vitest';
import {
  PHASE_HELP,
  PHASE_LABELS,
  WORKFLOW_PHASES,
  checkFfmpeg,
  isWorkflowPhase,
  nextPhase,
  phaseIndex,
  previousPhase,
} from './index';

describe('workflow phases', () => {
  it('declares the seven phases in order', () => {
    expect([...WORKFLOW_PHASES]).toEqual([
      'collect',
      'interview',
      'curate',
      'sequence',
      'score',
      'render',
      'deliver',
    ]);
  });

  it('has plain-language label and help text for every phase', () => {
    for (const phase of WORKFLOW_PHASES) {
      expect(PHASE_LABELS[phase]).toBeTruthy();
      expect(PHASE_HELP[phase]).toBeTruthy();
    }
  });

  it('navigates forwards and backwards, with defined ends', () => {
    expect(phaseIndex('collect')).toBe(0);
    expect(nextPhase('collect')).toBe('interview');
    expect(previousPhase('interview')).toBe('collect');
    expect(nextPhase('deliver')).toBeUndefined();
    expect(previousPhase('collect')).toBeUndefined();
  });

  it('guards unknown values', () => {
    expect(isWorkflowPhase('curate')).toBe(true);
    expect(isWorkflowPhase('mourn')).toBe(false);
    expect(isWorkflowPhase(3)).toBe(false);
  });
});

describe('checkFfmpeg', () => {
  it('memoises the probe and reports ffmpeg in this environment', async () => {
    const a = await checkFfmpeg();
    const b = await checkFfmpeg();
    expect(a).toBe(b);
    expect(a.ok).toBe(true);
  });
});
