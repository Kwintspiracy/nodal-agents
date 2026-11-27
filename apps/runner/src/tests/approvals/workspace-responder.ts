// workspace-responder.ts — the person who answers a card in these tests.
//
// A request is settled only by a member of its own workspace
// (approvals/resolve.ts), as in the product, where every workspace creation
// writes its owner's membership. This makes the tests' responder that member:
// a precondition of the flow, never the data a test asserts on.

import { entityMembers, users } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

export const RESPONDER_USER_ID = '00000000-0000-4000-8000-00000000a11e';

export async function seedResponder(
  db: unknown,
  entityId: string,
  userId: string = RESPONDER_USER_ID,
): Promise<void> {
  const d = db as AnyDrizzleDb;
  await d
    .insert(users)
    .values({ id: userId, email: `responder-${userId}@example.com` })
    .onConflictDoNothing();
  await d.insert(entityMembers).values({ entityId, userId, role: 'member' }).onConflictDoNothing();
}
