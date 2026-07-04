// Data-side user bootstrap. The sync tables hang off user_table (the per-user
// seq counters live there), and the row is created lazily on first touch of
// the data API rather than at auth-account creation.

import { db } from "../db";
import { userTable } from "../db/schema";

export async function ensureDataUser(authUserId: string): Promise<void> {
  await db
    .insert(userTable)
    .values({ id: authUserId })
    .onConflictDoNothing({ target: userTable.id });
}
