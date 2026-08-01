/**
 * Sending the message that was queued.
 *
 * The words are composed here, from the template name and its data, so a
 * message about a bereaved family never sits in the jobs table as prose. The
 * handler's only real job beyond that is to fail honestly: a refused send
 * throws, the queue backs off and tries again, and an organiser waiting for
 * their link gets it a minute late instead of never.
 *
 * The address is logged; the body never is.
 */
import { getMailTransport, renderMailTemplate } from '@col/core';
import { defineHandler } from './types';

export const sendEmailHandler = defineHandler('send-email', async (ctx) => {
  const message = renderMailTemplate(ctx.payload);
  const transport = getMailTransport();

  ctx.log.info('sending email', {
    jobId: ctx.job.id,
    template: ctx.payload.template,
    transport: transport.name,
  });

  const result = await transport.send(message);
  return {
    transport: result.transport,
    delivered: result.delivered,
    template: ctx.payload.template,
  };
});
