// queries/install.ts — who administers THIS install, as Nodal models it today (#946).
//
// Nodal records no "instance administrator". `entity_members.role` is per
// workspace, and every account is `owner` of the workspace its sign-up
// created, so an owner role cannot tell "owns this workspace" from "owns this
// install". What the code applies to host-wide actions (the network bind, the
// auth mode, and since #946 the pairing requests, which belong to no
// workspace) is this: they are allowed on a SINGLE-USER install — the person
// who ran `nodal-agents init`, or the local-trust user — and refused as soon
// as the install has a second account (a deliberate multi-user install,
// `NODALAI_ALLOW_OPEN_SIGNUP=1`).
//
// One query, read by the web's guard and by the runner, so the two can never
// disagree on what "single-user" means.

import { users } from '../schema/users.ts';
import type { AnyDrizzleDb } from '../client.ts';

/** True when the install has at most one account. */
export async function isSingleUserInstall(db: AnyDrizzleDb): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(2);
  return rows.length <= 1;
}
