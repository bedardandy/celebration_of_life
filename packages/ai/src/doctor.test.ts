import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MOCK_PROVIDER_ID,
  doctorExitCode,
  formatDoctorReport,
  registerProvider,
  resetMockState,
  runDoctor,
} from './index';
import type { AiProvider, CheckableProvider } from './types';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePhoto = path.join(repoRoot, 'fixtures', 'photos', '01-portrait.jpg');

/**
 * Every doctor test passes an explicit env. The doctor is the one thing here
 * that is *supposed* to reach real providers, so it must never be allowed to
 * pick one up from the machine running the tests.
 */
const mockEnv = { AI_PROVIDER: MOCK_PROVIDER_ID };

beforeEach(() => {
  resetMockState();
});

describe('runDoctor with the mock provider', () => {
  it('passes every check it can run and skips the rest', async () => {
    const reports = await runDoctor({
      env: mockEnv,
      tasks: ['default'],
      ...(existsSync(fixturePhoto) ? { fixturePhoto } : {}),
    });

    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.providerId).toBe(MOCK_PROVIDER_ID);
    expect(report?.ok).toBe(true);
    expect(doctorExitCode(reports)).toBe(0);

    const byName = Object.fromEntries((report?.checks ?? []).map((c) => [c.name, c]));
    expect(byName['available']?.status).toBe('pass');
    expect(byName['text']?.status).toBe('pass');
    expect(byName['generateObject']?.status).toBe('pass');
    // The mock has no sessions, so that row is skipped rather than failed.
    expect(byName['session resume']?.status).toBe('skip');
    expect(byName['vision']?.status).toBe(existsSync(fixturePhoto) ? 'pass' : 'skip');
  });

  it('reports one row per distinct provider, not one per task', async () => {
    const reports = await runDoctor({ env: mockEnv });
    expect(reports).toHaveLength(1);
  });

  it('skips vision when there is no photo to look at', async () => {
    const reports = await runDoctor({ env: mockEnv, tasks: ['default'] });
    const vision = reports[0]?.checks.find((c) => c.name === 'vision');
    expect(vision?.status).toBe('skip');
    expect(vision?.detail).toMatch(/no fixture photo/);
  });
});

describe('runDoctor degrading', () => {
  it('names an adapter that does not exist instead of throwing', async () => {
    const reports = await runDoctor({ env: { AI_PROVIDER: 'gpt-9000' }, tasks: ['default'] });
    expect(reports[0]?.ok).toBe(false);
    expect(reports[0]?.checks[0]?.detail).toMatch(/no adapter called "gpt-9000"/);
    expect(doctorExitCode(reports)).toBe(1);
  });

  it('reports a missing binary or key with its remedy, and skips the rest', async () => {
    const unavailable: CheckableProvider = {
      ...bare('needs-setup'),
      checkAvailability: () => ({
        ok: false,
        reason: 'the "claude" command is not on PATH',
        remedy: 'Install Claude Code and run `claude` once to sign in.',
      }),
    };
    registerProvider(unavailable);

    const reports = await runDoctor({ env: { AI_PROVIDER: 'needs-setup' }, tasks: ['default'] });
    expect(reports[0]?.ok).toBe(false);
    const checks = reports[0]?.checks ?? [];
    expect(checks[0]?.status).toBe('fail');
    expect(checks[0]?.detail).toContain('Install Claude Code');
    // Nothing after availability is attempted — no spawn, no network.
    expect(checks.slice(1).every((c) => c.status === 'skip')).toBe(true);
  });

  it('turns a thrown provider error into one failed row', async () => {
    registerProvider({
      ...bare('explodes'),
      async complete() {
        throw new Error('connection reset by peer');
      },
    });
    const reports = await runDoctor({ env: { AI_PROVIDER: 'explodes' }, tasks: ['default'] });
    expect(reports[0]?.ok).toBe(false);
    const text = reports[0]?.checks.find((c) => c.name === 'text');
    expect(text?.status).toBe('fail');
    expect(text?.detail).toContain('connection reset');
  });
});

describe('formatDoctorReport', () => {
  it('prints a readable table with a verdict', async () => {
    const reports = await runDoctor({ env: mockEnv, tasks: ['default'] });
    const text = formatDoctorReport(reports, mockEnv);
    expect(text).toContain(MOCK_PROVIDER_ID);
    expect(text).toContain('chosen by AI_PROVIDER');
    expect(text).toContain('✅');
    expect(text).toContain('All configured providers are working.');
  });

  it('says which providers need attention', async () => {
    const reports = await runDoctor({ env: { AI_PROVIDER: 'gpt-9000' }, tasks: ['default'] });
    expect(formatDoctorReport(reports, {})).toMatch(/1 provider needs attention: gpt-9000/);
  });

  it('warns when a test environment is quietly overriding the configuration', () => {
    const text = formatDoctorReport([], { NODE_ENV: 'test', AI_PROVIDER: 'claude-cli' });
    expect(text).toContain('NODE_ENV=test forces the mock provider');
    expect(text).toContain('AI_PROVIDER');
  });
});

function bare(id: string): AiProvider {
  return {
    id,
    capabilities: {
      text: true,
      nativeJsonSchema: false,
      vision: false,
      visionInput: 'none',
      nativeSessions: false,
      maxImagesPerCall: 0,
      costTier: 'free',
    },
    async complete() {
      return { text: '{}' };
    },
  };
}
