import type { PageServerLoad } from "./$types";
import { lookupControllerToken, type CtrlType } from "$lib/server/user-auth";

// Generic controller-token destination (auth-flows.md §Controller-token):
// password reset plus the daily-cap escape hatch for the sign-up-shape flows.
// Resolved on the server so the page is server-rendered in its final state
// (the payload form, or the invalid notice) instead of shipping a "Loading…"
// placeholder. Mirrors the GET `reset-destination` API, which the client can
// still use to re-validate.
export type ResetDest =
  | { status: "invalid" }
  | { status: "loaded"; email: string; type: CtrlType; needsSession: boolean };

export const load: PageServerLoad = async ({ url, locals }) => {
  const ct = url.searchParams.get("ct") ?? "";
  let dest: ResetDest = { status: "invalid" };
  const r = ct ? await lookupControllerToken(ct) : null;
  if (r) {
    dest = {
      status: "loaded",
      email: r.row.email,
      type: r.row.type,
      // Signed-in types commit only on the originating user's session.
      needsSession: r.row.originUserId !== null && locals.user?.user.id !== r.row.originUserId,
    };
  }
  return { dest };
};
