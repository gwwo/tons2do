import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  startOtp,
  rotateOtp,
  cancelOtp,
  loadDestination,
  attemptOtp,
  consumeOtp,
  startResetFlow,
  lookupControllerToken,
  deleteControllerToken,
  hashPw,
  verifyPw,
  createSession,
  clearSession,
  revokeOtherSessions,
  deleteAllSessions,
  deleteSessionById,
  isSessionFresh,
  refreshSession,
  findUserByEmail,
  findUserById,
  findPasswordCred,
  findCred,
  deleteCred,
  listUserCreds,
  createUserWithPasswordCred,
  attachPasswordCred,
  changeUserEmail,
  setPasswordCredHash,
  deletePasswordCred,
  deleteUserCascade,
  setResetDisabled,
  setUserName,
  type CtrlRow,
  type OAuthProvider,
} from "$lib/server/user-auth";
import { buildMe } from "$lib/server/user-auth";
import { revokeOAuthGrant } from "$lib/server/oauth";

const MAX_NAME_LEN = 100;

type Body = Record<string, unknown>;
type UserSession = NonNullable<App.Locals["user"]>;

async function readBody(request: Request): Promise<Body> {
  try {
    return (await request.json()) as Body;
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const staleSessionError = (): never =>
  error(403, { message: "session not fresh; sign in again", code: "stale-session" });

function requireSignedIn(locals: App.Locals, body: Body) {
  const s = locals.user;
  if (!s) error(401, "Not signed in");
  // Signed-in actions carry `expectedUserId` — the user the SPA is anchored to
  // and means to act on. If the ambient cookie has since been swapped to a
  // different user (another tab signed in as someone else; the cookie is
  // shared), refuse rather than silently retarget the operation at whoever
  // holds the cookie now. Mirrors the originUserId binding on OTP proceed
  // (consumeOtp) and state.uid on OAuth re-sign-in.
  const expectedUserId = str(body.expectedUserId);
  if (!expectedUserId) error(400, "expectedUserId required");
  if (s.user.id !== expectedUserId) error(409, "session belongs to a different user");
  return s;
}

/**
 * The sensitive-action gate (auth-flows.md §6/§8): a password-credential user
 * re-enters the password — which also refreshes the session, same as a
 * re-sign-in — while a user without one falls back to session freshness.
 * `refresh: false` for delete-user, whose session is cascade-deleted anyway.
 * Returns the password credential (null ⟹ the freshness path was taken).
 */
async function gateSensitive(s: UserSession, body: Body, opts?: { refresh?: boolean }) {
  const cred = await findPasswordCred(s.user.id);
  if (cred) {
    const password = str(body.password);
    if (!password) error(400, "password required");
    if (!(await verifyPw(cred.passwordHash, password))) error(403, "wrong password");
    if (opts?.refresh !== false) await refreshSession(s.session.id);
  } else if (!isSessionFresh(s.session)) {
    staleSessionError();
  }
  return cred;
}

// A password credential must remain unique per address (user.email is unique)
// — re-checked at commit time because the address can get registered between
// an OTP/controller flow's start and its commit.
async function ensureEmailFree(email: string, exceptUserId?: string) {
  const taken = await findUserByEmail(email);
  if (taken && taken.id !== exceptUserId) {
    error(409, "Email got registered while you were verifying");
  }
}

// ── Controller-token commits (reset + the cap-notice escape hatch) ───────────
// The destination collects the payload and posts { controllerToken, payload };
// the row is consumed only after its commit's own gates pass, so a rejected
// submit (e.g. not signed in yet for a session-bound type) doesn't burn the
// single-use token.
async function ctrlSubmit(event: Parameters<RequestHandler>[0], body: Body) {
  const ct = str(body.controllerToken);
  if (!ct) error(400, "controllerToken required");
  const found = await lookupControllerToken(ct);
  if (!found) error(400, "invalid or expired");
  const row: CtrlRow = found.row;

  const newPassword = row.type === "change-email" ? null : str(body.newPassword);
  if (row.type !== "change-email" && !newPassword) error(400, "newPassword required");

  // Signed-in types are session-bound, like their OTP counterparts: the link
  // may be opened in any browser, but the commit only lands on the session of
  // the user who started the flow.
  if (row.originUserId !== null) {
    const s = event.locals.user;
    if (!s || s.user.id !== row.originUserId) {
      error(403, "sign in as the account that requested this first");
    }
  }

  switch (row.type) {
    case "reset": {
      const u = await findUserByEmail(row.email);
      if (!u) error(400, "no such user");
      await setPasswordCredHash(u.id, await hashPw(newPassword!));
      await deleteControllerToken(row.id);
      await deleteAllSessions(u.id);
      return json({ ok: true });
    }
    case "signup": {
      await ensureEmailFree(row.email);
      const uid = await createUserWithPasswordCred({
        email: row.email,
        passwordHash: await hashPw(newPassword!),
      });
      await deleteControllerToken(row.id);
      await createSession(uid, event);
      return json({ ok: true });
    }
    case "add-password-cred": {
      await ensureEmailFree(row.email);
      if (await findPasswordCred(row.originUserId!)) {
        error(409, "a password credential already exists");
      }
      await attachPasswordCred(row.originUserId!, row.email, await hashPw(newPassword!));
      await deleteControllerToken(row.id);
      return json({ ok: true });
    }
    case "change-email": {
      await ensureEmailFree(row.email, row.originUserId!);
      await changeUserEmail(row.originUserId!, row.email);
      await deleteControllerToken(row.id);
      return json({ ok: true });
    }
  }
}

const GET: RequestHandler = async ({ params, locals, url }) => {
  switch (params.op) {
    case "me": {
      const s = locals.user;
      if (!s) return json({ user: null });
      return json(await buildMe(s));
    }
    case "otp-destination": {
      const vt = url.searchParams.get("vt");
      if (!vt) return json({ status: "invalid" });
      return json(await loadDestination(vt));
    }
    case "reset-destination": {
      const ct = url.searchParams.get("ct");
      const r = ct ? await lookupControllerToken(ct) : null;
      if (!r) return json({ status: "invalid" });
      return json({
        status: "loaded",
        email: r.row.email,
        type: r.row.type,
        // Signed-in types commit only on the originating user's session — tell
        // the destination page whether that gate currently passes.
        needsSession: r.row.originUserId !== null && locals.user?.user.id !== r.row.originUserId,
      });
    }
  }
  error(404, "Unknown op");
};

const POST: RequestHandler = async (event) => {
  const { params, request, locals, url } = event;
  const body = await readBody(request);
  const origin = url.origin;

  switch (params.op) {
    // ── Unified sign-in / signup-shape ──────────────────────────────────────
    case "sign-in": {
      const email = str(body.email)?.toLowerCase();
      const password = str(body.password);
      if (!email || !password) error(400, "email and password required");

      const u = await findUserByEmail(email);
      const cred = u ? await findPasswordCred(u.id) : null;

      if (u && cred && cred.passwordHash) {
        const ok = await verifyPw(cred.passwordHash, password);
        if (ok) {
          await createSession(u.id, event);
          return json({ shape: "session" });
        }
      } else {
        // pad timing on a no-user branch
        await verifyPw(null, password);
      }

      // Sign-in miss → reverse-OTP type=signup (real if unregistered, synthetic if registered)
      const r = await startOtp({ email, type: "signup", realPath: !u, origin });
      return json({ shape: "signup-otp", ...r, email });
    }

    case "otp-rotate": {
      const at = str(body.actorToken);
      if (!at) error(400, "actorToken required");
      return json(await rotateOtp(at));
    }
    case "otp-cancel": {
      const at = str(body.actorToken);
      if (!at) error(400, "actorToken required");
      await cancelOtp(at);
      return json({ ok: true });
    }
    case "otp-attempt": {
      // Used by the destination page: check the entered code against the verifier-token.
      const vt = str(body.verifierToken);
      const code = str(body.otp);
      if (!vt || !code) error(400, "verifierToken and otp required");
      return json(await attemptOtp(vt, code));
    }

    case "otp-proceed": {
      const at = str(body.actorToken);
      if (!at) error(400, "actorToken required");
      // consumeOtp enforces the originUserId↔session binding for signed-in
      // flows; on mismatch it returns "fail" without consuming the row.
      const result = await consumeOtp(at, locals.user?.user.id ?? null);
      if (result.kind === "too_frequent") {
        return json({ shape: "too_frequent", retryAfterMs: result.retryAfterMs });
      }
      if (result.kind !== "ok") return json({ shape: result.kind });

      const row = result.row;
      if (row.type === "signup") {
        const password = str(body.password);
        if (!password) error(400, "password required");
        await ensureEmailFree(row.email);
        const id = await createUserWithPasswordCred({
          email: row.email,
          passwordHash: await hashPw(password),
        });
        await createSession(id, event);
        return json({ shape: "session", newUser: true });
      }
      // change-email / add-password-cred: row.originUserId is guaranteed to
      // match the current session by consumeOtp.
      if (row.type === "change-email") {
        await ensureEmailFree(row.email, row.originUserId!);
        await changeUserEmail(row.originUserId!, row.email);
        const newPassword = str(body.password);
        if (newPassword) {
          await setPasswordCredHash(row.originUserId!, await hashPw(newPassword));
          await revokeOtherSessions(row.originUserId!, locals.user!.session.token);
        }
        return json({ shape: "ok" });
      }
      // add-password-cred
      const password = str(body.password);
      if (!password) error(400, "password required");
      await ensureEmailFree(row.email);
      if (await findPasswordCred(row.originUserId!)) {
        error(409, "a password credential already exists");
      }
      await attachPasswordCred(row.originUserId!, row.email, await hashPw(password));
      return json({ shape: "ok" });
    }

    // ── Reset password / controller-token commits ───────────────────────────
    case "reset-request": {
      const email = str(body.email);
      if (!email) error(400, "email required");
      await startResetFlow(email, origin);
      return json({ ok: true });
    }
    case "reset-submit": {
      return ctrlSubmit(event, body);
    }

    // ── Sign-out ────────────────────────────────────────────────────────────
    case "sign-out": {
      // Anchor-bound, but with *local-only-on-mismatch* semantics (not the 409
      // refuse-pattern of the guarded actions): the user clicked *out*, not
      // *re-enter*, so refusing would be the wrong UX. Instead we never delete
      // a session or clear a cookie that doesn't belong to the anchored user.
      //   - match: real sign-out (delete session row, clear cookie).
      //   - overwritten: cookie holds another user's live session — leave both
      //     the session and the cookie alone; the client just re-anchors
      //     locally. Their tabs keep working.
      //   - invalid: no live session, but the cookie token (if any) is orphan
      //     — clear it defensively. Nothing to delete in the DB.
      const expectedUserId = str(body.expectedUserId);
      if (!expectedUserId) error(400, "expectedUserId required");
      const s = locals.user;
      if (!s || s.user.id === expectedUserId) await clearSession(event);
      return json({ ok: true });
    }

    case "re-sign-in": {
      // Re-sign-in is anchor-bound: the client carries `expectedUserId` (the
      // SPA's anchored user.id), and the server resigns in as *that* user —
      // not as "whoever currently owns some email." Emails can be re-allocated
      // (account deleted, re-registered at the same address with a new
      // user.id); an email-keyed re-sign-in would silently land on the new
      // owner, leaving the SPA's anchored identity unreachable. Mirrors the
      // OAuth `re-sign-in` intent, which keys on `state.uid`. The ambient
      // cookie is still never trusted to pick the user — it may be gone
      // ("invalid"), stale, or hold a different user ("overwritten").
      const password = str(body.password);
      const expectedUserId = str(body.expectedUserId);
      if (!password || !expectedUserId) error(400, "password and expectedUserId required");

      const u = await findUserById(expectedUserId);
      const cred = u ? await findPasswordCred(u.id) : null;
      if (!(await verifyPw(cred?.passwordHash ?? null, password))) {
        // verifyPw pads timing on the no-user / no-credential branches.
        error(403, "wrong password");
      }

      // The cookie's current session (whoever owns it — a stale one of ours,
      // or another user's after a swap) is being replaced; delete it rather
      // than orphan it.
      if (locals.user) await deleteSessionById(locals.user.session.id);
      await createSession(u!.id, event);
      return json({ ok: true });
    }

    // ── Signed-in credential management ─────────────────────────────────────
    case "change-password-cred-start": {
      const s = requireSignedIn(locals, body);
      const currentPassword = str(body.currentPassword);
      const newEmail = str(body.newEmail)?.toLowerCase();
      const newPassword = str(body.newPassword);
      if (!currentPassword || !newEmail) error(400, "currentPassword and newEmail required");
      const cred = await findPasswordCred(s.user.id);
      if (!cred) error(400, "no password credential to change");
      if (!(await verifyPw(cred.passwordHash, currentPassword))) error(403, "wrong password");
      // Password re-confirmed — refresh the session, same as a re-sign-in.
      await refreshSession(s.session.id);

      const emailChanged = newEmail !== s.user.email?.toLowerCase();
      if (!emailChanged && !newPassword) error(400, "no change requested");

      if (!emailChanged) {
        await setPasswordCredHash(s.user.id, await hashPw(newPassword!));
        await revokeOtherSessions(s.user.id, s.session.token);
        return json({ shape: "ok" });
      }

      const r = await startOtp({
        email: newEmail,
        type: "change-email",
        realPath: !(await findUserByEmail(newEmail)),
        origin,
        originUserId: s.user.id,
      });
      return json({ shape: "otp", ...r, email: newEmail });
    }

    case "add-password-cred-start": {
      const s = requireSignedIn(locals, body);
      const email = str(body.email)?.toLowerCase();
      if (!email) error(400, "email required");
      if (await findPasswordCred(s.user.id)) error(400, "user already has a password credential");
      const r = await startOtp({
        email,
        type: "add-password-cred",
        realPath: !(await findUserByEmail(email)),
        origin,
        originUserId: s.user.id,
      });
      return json({ shape: "otp", ...r, email });
    }

    case "delete-password-cred": {
      const s = requireSignedIn(locals, body);
      if (!(await findPasswordCred(s.user.id))) error(400, "no password credential");
      await gateSensitive(s, body);
      const creds = await listUserCreds(s.user.id);
      if (creds.length <= 1) error(400, "must keep at least one credential");
      await deletePasswordCred(s.user.id);
      return json({ ok: true });
    }

    case "delete-google-cred":
    case "delete-github-cred": {
      const provider: OAuthProvider = params.op === "delete-google-cred" ? "google" : "github";
      const s = requireSignedIn(locals, body);
      const g = await findCred(s.user.id, provider);
      if (!g) error(400, `no ${provider} credential`);
      const creds = await listUserCreds(s.user.id);
      if (creds.length <= 1) error(400, "must keep at least one credential");
      await gateSensitive(s, body);
      await revokeOAuthGrant(provider, g.accessToken);
      await deleteCred(s.user.id, provider);
      return json({ ok: true });
    }

    case "disable-reset": {
      const s = requireSignedIn(locals, body);
      if (!(await findPasswordCred(s.user.id))) error(400, "no password credential");
      await gateSensitive(s, body);
      await setResetDisabled(s.user.id, true);
      return json({ ok: true });
    }

    case "enable-reset": {
      // Not password-gated — the recovery chain (OAuth sign-in → re-enable →
      // reset) requires this for users who've lost their password. Freshness
      // stands in for the password check: a fresh session proves a recent auth
      // (either password or OAuth prompt=login), without blocking recovery.
      const s = requireSignedIn(locals, body);
      const cred = await findPasswordCred(s.user.id);
      if (!cred) error(400, "no password credential");
      if (!isSessionFresh(s.session)) staleSessionError();
      await setResetDisabled(s.user.id, false);
      return json({ ok: true });
    }

    case "set-name": {
      // Optional user-chosen label. Not sensitive — no password/freshness gate.
      // An empty or whitespace-only value clears the name back to null.
      const s = requireSignedIn(locals, body);
      const raw = typeof body.name === "string" ? body.name.trim() : "";
      if (raw.length > MAX_NAME_LEN) error(400, `name must be ${MAX_NAME_LEN} characters or fewer`);
      await setUserName(s.user.id, raw.length > 0 ? raw : null);
      return json({ ok: true });
    }

    case "delete-user": {
      const s = requireSignedIn(locals, body);
      await gateSensitive(s, body, { refresh: false });
      const [googleCred, githubCred] = await Promise.all([
        findCred(s.user.id, "google"),
        findCred(s.user.id, "github"),
      ]);
      await Promise.all([
        revokeOAuthGrant("google", googleCred?.accessToken ?? null),
        revokeOAuthGrant("github", githubCred?.accessToken ?? null),
      ]);
      await deleteUserCascade(s.user.id);
      await clearSession(event);
      return json({ ok: true });
    }
  }
  error(404, "Unknown op");
};

export { GET, POST };
