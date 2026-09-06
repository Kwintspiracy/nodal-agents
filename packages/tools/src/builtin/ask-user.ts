// Built-in: ask_user — l'agent pose une question à boutons, et le travail
// s'arrête là jusqu'à ce qu'un humain choisisse (P10a, plan « De la maquette au
// produit »).
//
// LE MÉCANISME, en un paragraphe. `ask_user` ne « demande » rien lui-même : il
// déclare `asksUser`, et la porte d'approbation (execute.ts) en fait une ligne
// `approval_requests` de kind `question`, exactement comme elle fait une ligne
// d'approbation pour `run_command`. Le job se suspend sur le marqueur
// `[AWAITING_APPROVAL]` habituel, la question part dans le canal d'origine et
// s'affiche au dashboard, et un clic la résout. La reprise rejoue CET appel
// avec son `toolCallId` d'origine ; `execute()` ci-dessous retrouve alors la
// ligne répondue et rend la réponse comme résultat de l'outil. Aucune
// plomberie neuve dans le runner : c'est la même que les approbations.

import { z } from 'zod';
import { and, eq, desc, approvalRequests } from '@nodal-agents/db';
import type { ToolDefinition, ToolContext } from '../types';

/** Bornes de la question et de ses options — une carte se lit, elle n'archive pas. */
export const ASK_USER_QUESTION_MAX = 600;
export const ASK_USER_CONTEXT_MAX = 1200;
export const ASK_USER_OPTION_MAX = 60;
export const ASK_USER_OPTIONS_MIN = 2;
export const ASK_USER_OPTIONS_MAX = 6;

const trimmed = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(max));

export const AskUserInputSchema = z.object({
  question: trimmed(ASK_USER_QUESTION_MAX),
  options: z
    .array(trimmed(ASK_USER_OPTION_MAX))
    .min(ASK_USER_OPTIONS_MIN)
    .max(ASK_USER_OPTIONS_MAX)
    // Deux options identiques rendraient la réponse ambiguë : la résolution
    // stocke le LIBELLÉ choisi, donc deux libellés égaux ne se distinguent
    // plus une fois la ligne écrite. Refusé à l'entrée plutôt que résolu au
    // hasard plus tard (invariant #4).
    .refine((opts) => new Set(opts).size === opts.length, {
      message: 'options must be distinct',
    }),
  context: trimmed(ASK_USER_CONTEXT_MAX).optional(),
});

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

export type AskUserOutput = {
  /** L'option choisie, telle qu'elle a été proposée. */
  answer: string;
  /** Son rang dans `options` — pratique pour l'agent, jamais la source de vérité. */
  option_index: number;
};

/**
 * La ligne `approval_requests` de CET appel, si elle a été répondue.
 * La plus récente : un même `tool_call_id` peut porter plusieurs lignes si un
 * appel a été rejoué, et c'est la dernière décision qui vaut.
 */
async function findAnsweredQuestionRow(
  ctx: ToolContext,
  toolName: string,
): Promise<{ answer: string | null } | null> {
  if (!ctx.toolCallId) return null;
  const [row] = await ctx.db
    .select({ answer: approvalRequests.answer })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.jobId, ctx.jobId),
        eq(approvalRequests.toolCallId, ctx.toolCallId),
        eq(approvalRequests.toolName, toolName),
        eq(approvalRequests.kind, 'question'),
        eq(approvalRequests.status, 'approved'),
      ),
    )
    .orderBy(desc(approvalRequests.resolvedAt))
    .limit(1);
  return row ?? null;
}

export const askUserTool: ToolDefinition<typeof AskUserInputSchema, AskUserOutput> = {
  name: 'ask_user',
  description:
    'Ask the person a question with 2 to 6 answer options, and WAIT for their answer. ' +
    'The job pauses here: it resumes only once they pick an option, and their choice comes ' +
    "back as this tool's result. " +
    'Use it for a decision you genuinely cannot make alone — where to write something, which ' +
    'of several approaches to take, confirming a choice that costs time or money. ' +
    'Do NOT use it when the answer is already in your context or in the request (read again ' +
    'before asking), when you would need more than six options, or as a way to avoid deciding ' +
    'something that is plainly yours to decide. ' +
    'For an open question, offer the options you consider most likely AND one such as ' +
    '"Something else, let me explain" so the person is never boxed in. ' +
    "Write the question in the person's own language, keep it to one sentence, and make each " +
    'option a short label they can recognise at a glance. Put anything they need in order to ' +
    'choose — what you found, what each option implies — in `context`.',
  inputSchema: AskUserInputSchema,
  // Poser une question ne change rien : ni fichier, ni état, ni envoi. Le poids
  // de l'appel est l'ATTENTE, pas le risque — et l'attente est portée par
  // `asksUser`, pas par le niveau de risque.
  riskLevel: 'read',
  card: 'question',
  asksUser: true,
  present: ({ input, output }) => ({
    card: 'question' as const,
    prompt: input.question,
    options: input.options,
    // Sur l'appel qui a suspendu le job, il n'y a pas encore de sortie : la
    // carte porte alors la question seule. `present()` n'est appelé que sur un
    // succès, donc `output` est ici toujours la réponse — le `?? null` est la
    // ceinture d'un outil dont un jour la sortie changerait de forme.
    answer: typeof output?.answer === 'string' ? output.answer : null,
  }),
  execute: async (input, ctx): Promise<AskUserOutput> => {
    const row = await findAnsweredQuestionRow(ctx, 'ask_user');
    if (!row || row.answer === null) {
      // Fail loud (invariant #4) : la porte aurait dû suspendre cet appel et ne
      // le laisser passer qu'une fois répondu. Y arriver signifie que le floor
      // a été contourné — jamais un chemin normal, donc jamais un repli malin
      // du genre « prends la première option ».
      throw new Error('question_unanswered');
    }
    const index = input.options.indexOf(row.answer);
    if (index === -1) {
      // La résolution refuse déjà toute réponse hors options. Une ligne faite
      // ainsi est une incohérence de données, pas un cas d'usage : on la dit
      // plutôt que de rendre un `option_index: -1` que l'agent croirait valide.
      throw new Error('question_answer_invalid');
    }
    return { answer: row.answer, option_index: index };
  },
};
