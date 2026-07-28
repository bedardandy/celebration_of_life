/**
 * Putting the slideshow together.
 *
 * One model call decides ordering, grouping and the words on the cards; every
 * number after that is arithmetic in `@col/core`. The handler's own job is
 * narrow and mostly about what it refuses to do:
 *
 *  1. It runs because somebody chose a story shape, never on its own.
 *  2. A provider that bills per token means the family's descriptions leave
 *     this machine, so it is gated on `aiConsentExternal`. Without that consent
 *     the family still gets a slideshow — every approved photograph, in the
 *     order they already see them — because "no AI" should mean a plainer
 *     video, not no video.
 *  3. If the model cannot produce something usable, the same plain slideshow is
 *     the answer. A family three days from a funeral cannot be told to try
 *     again later.
 */
import { AiSchemaError, friendlyAiMessage, resolveProvider, type AiProvider } from '@col/ai';
import { getById, memorials, slideshowProjects, type Db } from '@col/db';
import {
  assembleEdl,
  buildContext,
  generateEdl,
  plainProposal,
  projectCut,
  saveEdl,
  traditionNotesFor,
  type EdlBuildContext,
} from '@col/core';
import { defineHandler } from './types';

export type GenerateEdlOutcome = {
  status: 'done' | 'plain' | 'already-done' | 'nothing-to-do';
  projectId: string;
  slideCount: number;
  serviceSec: number;
  familySec: number;
  warnings: string[];
  providerId?: string;
  /** Why it came out plain, when it did. In words a log reader can act on. */
  reason?: string;
};

/**
 * Consent, in one place, and phrased as a question about where the words go
 * rather than about which vendor is fashionable. A CLI covered by the family's
 * own subscription, or a model on this machine, is not a third party.
 */
export function edlGenerationAllowed(
  provider: AiProvider,
  memorial: { aiConsentExternal: boolean },
): { allowed: true } | { allowed: false; reason: string } {
  if (provider.capabilities.costTier !== 'metered') return { allowed: true };
  if (memorial.aiConsentExternal) return { allowed: true };
  return {
    allowed: false,
    reason:
      `"${provider.id}" sends this memorial's descriptions and memories to a paid API, ` +
      'and that has not been agreed to. The slideshow was put together in plain order instead.',
  };
}

export const generateEdlHandler = defineHandler('generate-edl', async (ctx) => {
  const { memorialId, projectId, regenerate } = ctx.payload;
  const memorial = getById(ctx.db, memorials, memorialId);
  if (!memorial) throw new Error(`memorial ${memorialId} not found`);
  const project = getById(ctx.db, slideshowProjects, projectId);
  if (!project || project.memorialId !== memorialId) {
    throw new Error(`slideshow project ${projectId} does not belong to memorial ${memorialId}`);
  }

  if (project.edl && !regenerate) {
    return outcome(ctx.db, projectId, { status: 'already-done', warnings: [] });
  }

  const context = buildContext(ctx.db, memorialId, projectId, {
    ...(traditionNotesFor(memorial.traditionSlug)
      ? { traditionNotes: traditionNotesFor(memorial.traditionSlug) as string }
      : {}),
  });

  if (context.assets.length === 0) {
    return {
      status: 'nothing-to-do',
      projectId,
      slideCount: 0,
      serviceSec: 0,
      familySec: 0,
      warnings: [],
      reason: 'no approved photographs yet',
    } satisfies GenerateEdlOutcome;
  }

  const provider = resolveProvider('edl-generation');
  const consent = edlGenerationAllowed(provider, memorial);
  if (!consent.allowed) {
    ctx.log.warn('edl generation fell back to plain order for consent', {
      memorialId,
      providerId: provider.id,
    });
    return savePlain(ctx.db, projectId, context, consent.reason);
  }

  ctx.heartbeat();

  try {
    const result = await generateEdl(context, { provider });
    for (const warning of result.warnings) {
      ctx.log.warn('edl proposal partly discarded', { memorialId, projectId, warning });
    }
    saveEdl(ctx.db, projectId, result.edl, { status: 'ready' });
    return outcome(ctx.db, projectId, {
      status: 'done',
      warnings: result.warnings,
      providerId: result.providerId,
    });
  } catch (error) {
    if (!(error instanceof AiSchemaError)) throw error;
    ctx.log.warn('edl proposal was unusable; falling back to plain order', {
      memorialId,
      projectId,
      attempts: error.attempts,
    });
    return savePlain(ctx.db, projectId, context, friendlyAiMessage(error));
  }
});

function savePlain(
  db: Db,
  projectId: string,
  context: EdlBuildContext,
  reason: string,
): GenerateEdlOutcome {
  const { edl, warnings } = assembleEdl(plainProposal(context), context);
  saveEdl(db, projectId, edl, { status: 'ready' });
  return outcome(db, projectId, { status: 'plain', warnings, reason });
}

/** Read the saved EDL back and report what a family will actually see. */
function outcome(
  db: Db,
  projectId: string,
  parts: Pick<GenerateEdlOutcome, 'status' | 'warnings'> &
    Partial<Pick<GenerateEdlOutcome, 'providerId' | 'reason'>>,
): GenerateEdlOutcome {
  const project = getById(db, slideshowProjects, projectId);
  const edl = project?.edl;
  if (!edl) {
    return { ...parts, projectId, slideCount: 0, serviceSec: 0, familySec: 0 };
  }
  const service = projectCut(edl, 'service');
  const family = projectCut(edl, 'family');
  return {
    ...parts,
    projectId,
    slideCount: family.slides.length,
    serviceSec: Math.round(service.totalSec),
    familySec: Math.round(family.totalSec),
  };
}
