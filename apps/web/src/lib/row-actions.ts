'use server';

// row-actions — RENOMMER depuis une ligne de la barre latérale (20/09).
//
// Le propriétaire veut les trois points en bout de ligne sur « tout ce qui
// accepte la suppression et le renommage » (planche 25:1062, cadre 22:1514).
// La suppression existait déjà, une action par sorte de ligne (`actions.ts`) ;
// le renommage, lui, passait par des formulaires entiers (`updateAgentAction`
// exige la personnalité, le modèle, la clé…). Une ligne n'a que son nom : ces
// quatre actions ne changent QUE lui, bornées à l'entité de la session, et
// répondent « not found » plutôt que de se taire quand la ligne n'est pas à
// cette personne.
//
// Le projet n'est pas ici : `renameCodeProjectAction` existe déjà et prend le
// chemin du projet, ce que la ligne porte désormais.

import { z } from 'zod';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { and, eq, agents, agentSchedules, conversations, webhookTriggers } from '@nodal-agents/db';
import { requireAuth } from '@nodal-agents/auth';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import type { ActionResult } from './sidebar-actions.ts';

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

const Rename = z.object({
  id: z.string().guid(),
  name: z.string().trim().min(1, 'A name is required').max(120),
});

export async function renameConversationAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = Rename.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const [row] = await getDb()
      .update(conversations)
      .set({ title: parsed.data.name })
      .where(
        and(eq(conversations.id, parsed.data.id), eq(conversations.entityId, session.entityId)),
      )
      .returning({ id: conversations.id });
    if (!row) return fail('not_found', 'Conversation not found');
    revalidatePath('/chat');
    return ok(undefined);
  } catch (err) {
    console.error('[renameConversationAction]', err);
    return fail('db_error', 'Failed to rename the conversation');
  }
}

export async function renameAgentAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = Rename.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const [row] = await getDb()
      .update(agents)
      .set({ name: parsed.data.name })
      .where(and(eq(agents.id, parsed.data.id), eq(agents.entityId, session.entityId)))
      .returning({ id: agents.id });
    if (!row) return fail('not_found', 'Agent not found');
    revalidatePath('/agents');
    return ok(undefined);
  } catch (err) {
    console.error('[renameAgentAction]', err);
    return fail('db_error', 'Failed to rename the agent');
  }
}

export async function renameScheduleAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = Rename.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const [row] = await getDb()
      .update(agentSchedules)
      .set({ name: parsed.data.name })
      .where(
        and(eq(agentSchedules.id, parsed.data.id), eq(agentSchedules.entityId, session.entityId)),
      )
      .returning({ id: agentSchedules.id });
    if (!row) return fail('not_found', 'Schedule not found');
    revalidatePath('/automations');
    return ok(undefined);
  } catch (err) {
    console.error('[renameScheduleAction]', err);
    return fail('db_error', 'Failed to rename the automation');
  }
}

export async function renameWebhookTriggerAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = Rename.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const [row] = await getDb()
      .update(webhookTriggers)
      .set({ name: parsed.data.name })
      .where(
        and(eq(webhookTriggers.id, parsed.data.id), eq(webhookTriggers.entityId, session.entityId)),
      )
      .returning({ id: webhookTriggers.id });
    if (!row) return fail('not_found', 'Webhook not found');
    revalidatePath('/automations');
    return ok(undefined);
  } catch (err) {
    console.error('[renameWebhookTriggerAction]', err);
    return fail('db_error', 'Failed to rename the webhook');
  }
}
