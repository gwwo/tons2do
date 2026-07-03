import type { user as userTable, session as sessionTable } from "$lib/server/db/auth-schema";

type UserSession = {
  user: typeof userTable.$inferSelect;
  session: typeof sessionTable.$inferSelect;
};

declare global {
  namespace App {
    interface Error {
      message: string;
      // Machine-readable discriminator (e.g. "stale-session") so clients don't
      // have to sniff the human-readable message.
      code?: string;
    }
    interface Locals {
      user: UserSession | null;
    }
  }
}

export {};
