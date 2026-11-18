/**
 * Host half of dsh-inline-attachments.
 *
 * `agent/pre-step` is a waterfall: awaiting `next()` gives the complete batch
 * that the loop is about to enter and append. Rewriting it there keeps the
 * model input and the session log identical.
 *
 * @module dsh-inline-attachments
 */

import { rewriteMessage } from './host.js'

/**
 * Rewrite every ordinary user message whose text still carries inline markers.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages.map(rewriteMessage) : decision.messages
    return { ...decision, messages }
  })
}
