import { randomBytes, randomInt, timingSafeEqual, createHmac } from "node:crypto";
import type { RequestEvent } from "@sveltejs/kit";
import { eq, and, ne, sql } from "drizzle-orm";
import { db } from "./db";
import { user, credential, session, otpVerification, ctrlVerification } from "./db/auth-schema";
import { env } from "$env/dynamic/private";
import { sendMail, renderEmail } from "./mailer";

// ── Constants ────────────────────────────────────────────────────────────────
export const SESSION_COOKIE = "user-demo.session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
export const OTP_TTL_MS = 1000 * 60 * 10;
export const CONTROLLER_TTL_MS = 1000 * 60 * 30;
export const OTP_MAX_ATTEMPTS = 5;
export const DAILY_SEND_CAP = 20;
export const FRESH_SESSION_MS = 1000 * 60 * 1;

// ── ID & token generation ────────────────────────────────────────────────────
const id = (n = 16) => randomBytes(n).toString("hex");
export const newUserId = () => `u_${id(12)}`;
export const newCredentialId = () => `c_${id(12)}`;
export const newSessionId = () => `s_${id(12)}`;
export const newOtpRowId = () => `ov_${id(12)}`;
export const newCtrlRowId = () => `cv_${id(12)}`;

export const newActorToken = () => `at_${id(20)}`;
export const newVerifierToken = () => `vt_${id(24)}`;
export const newControllerToken = () => `ct_${id(24)}`;
export const newOtp = () => String(randomInt(0, 10000)).padStart(4, "0");

const SECRET = env.AUTH_SECRET || "dev-only-fallback-secret";
function safeEq(a: string, b: string) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function firstRow<T>(q: PromiseLike<T[]>): Promise<T | null> {
  return (await q)[0] ?? null;
}

// ── Password hashing ─────────────────────────────────────────────────────────
// argon2id via Bun.password; the stored string is self-describing.
export async function hashPw(pw: string) {
  return Bun.password.hash(pw.normalize("NFKC"));
}
export async function verifyPw(stored: string | null, pw: string) {
  // Always do one hash so "no credential" and "wrong password" cost the same.
  if (!stored) {
    await Bun.password.hash(pw.normalize("NFKC"));
    return false;
  }
  try {
    return await Bun.password.verify(pw.normalize("NFKC"), stored);
  } catch {
    // Unknown/legacy hash format → treat as wrong password rather than 500.
    return false;
  }
}

// ── Session management ───────────────────────────────────────────────────────
export async function createSession(userId: string, event: RequestEvent) {
  const token = `s_${randomBytes(24).toString("hex")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(session).values({
    id: newSessionId(),
    token,
    userId,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    ipAddress: event.getClientAddress(),
    userAgent: event.request.headers.get("user-agent") ?? null,
  });
  event.cookies.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
  });
  return { token, expiresAt };
}

export async function getSession(event: RequestEvent) {
  const token = event.cookies.get(SESSION_COOKIE);
  if (!token) return null;
  const s = await firstRow(db.select().from(session).where(eq(session.token, token)).limit(1));
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    await db.delete(session).where(eq(session.id, s.id));
    return null;
  }
  const u = await firstRow(db.select().from(user).where(eq(user.id, s.userId)).limit(1));
  if (!u) return null;
  return { user: u, session: s };
}

export async function clearSession(event: RequestEvent) {
  const token = event.cookies.get(SESSION_COOKIE);
  if (token) await db.delete(session).where(eq(session.token, token));
  event.cookies.delete(SESSION_COOKIE, { path: "/" });
}

export async function revokeOtherSessions(userId: string, keepToken: string) {
  await db.delete(session).where(and(eq(session.userId, userId), ne(session.token, keepToken)));
}

export async function deleteAllSessions(userId: string) {
  await db.delete(session).where(eq(session.userId, userId));
}

// Delete one session row by id — used when re-sign-in replaces the cookie's
// current session (the same user's old row, or another user's in a swap).
export async function deleteSessionById(sessionId: string) {
  await db.delete(session).where(eq(session.id, sessionId));
}

export function isSessionFresh(s: { createdAt: Date }) {
  return Date.now() - s.createdAt.getTime() < FRESH_SESSION_MS;
}

// Resets a session's freshness clock. Called after an in-session password
// re-confirmation: re-entering the password is itself a fresh authentication,
// so the session should become fresh again — same effect as a re-sign-in,
// without rotating the token or touching the cookie.
export async function refreshSession(sessionId: string) {
  const now = new Date();
  await db.update(session).set({ createdAt: now, updatedAt: now }).where(eq(session.id, sessionId));
}

// ── Daily-send counter (in-memory; not durable — see auth-flows.md §rate-limit) ─
type DailyEntry = { day: string; count: number; capNoticeSent: boolean };
const daily = new Map<string, DailyEntry>();
function getDaily(email: string): DailyEntry {
  const k = email.toLowerCase();
  const d = new Date().toISOString().slice(0, 10);
  let e = daily.get(k);
  if (!e || e.day !== d) {
    e = { day: d, count: 0, capNoticeSent: false };
    daily.set(k, e);
  }
  return e;
}

/**
 * Runs `send` (which should insert whatever rows it needs and send exactly one
 * email) if the per-email daily cap allows, bumping the counter first and
 * refunding it if `send` throws — bump-then-refund keeps the cap check tight
 * under concurrent requests. At the cap, the day's final email is a
 * controller-token link carrying the flow's `type` (the §Controller-token
 * escape hatch); after that, nothing is sent at all. Returns whether `send` ran.
 */
async function sendUnderDailyCap(
  opts: { email: string; type: CtrlType; origin: string; originUserId?: string },
  send: () => Promise<void>,
): Promise<boolean> {
  const e = getDaily(opts.email);
  if (e.count >= DAILY_SEND_CAP) {
    if (!e.capNoticeSent) {
      const ctrl = await mintControllerToken(opts);
      await sendCapNotice(opts.email, opts.type, ctrl.token, opts.origin);
      e.capNoticeSent = true;
    }
    return false;
  }
  e.count += 1;
  try {
    await send();
  } catch (err) {
    if (e.count > 0) e.count -= 1;
    throw err;
  }
  return true;
}

// ── Reverse-OTP types ────────────────────────────────────────────────────────
export type OtpType = "signup" | "change-email" | "add-password-cred";
export type OtpRow = typeof otpVerification.$inferSelect;

export type OtpAction = "proceed" | "rotate";
export const ACTION_COOLDOWN_MS: Record<OtpAction, number> = {
  proceed: 5_000,
  rotate: 30_000,
};

// Universal action rate-limit, keyed by `${action}:${actorToken}` (real OR synthetic).
const actionCooldown = new Map<string, number>();

function checkActionCooldown(
  action: OtpAction,
  actorToken: string,
): { ok: true } | { ok: false; retryAfterMs: number } {
  const key = `${action}:${actorToken}`;
  const now = Date.now();
  const next = actionCooldown.get(key);
  if (next === undefined) return { ok: true };
  if (next > now) return { ok: false, retryAfterMs: next - now };
  actionCooldown.delete(key);
  return { ok: true };
}

function setActionCooldown(action: OtpAction, actorToken: string) {
  actionCooldown.set(`${action}:${actorToken}`, Date.now() + ACTION_COOLDOWN_MS[action]);
}

// ── Email senders ────────────────────────────────────────────────────────────
const IGNORE_FOOTER = "If you didn't request this, you can ignore this email.";

const OTP_EMAILS: Record<OtpType, { subject: string; body: string }> = {
  signup: {
    subject: "Confirm your sign-up",
    body: "Tap the button below, then enter the 4-digit code shown in your browser.",
  },
  "change-email": {
    subject: "Confirm your new email",
    body: "Tap the button below to confirm this is your new email address, then enter the 4-digit code shown in your browser.",
  },
  "add-password-cred": {
    subject: "Confirm linking this email",
    body: "Tap the button below to link this email to your account, then enter the 4-digit code shown in your browser.",
  },
};

// Human phrasing of each controller-token commit, used in the cap-notice email.
const CTRL_ACTION_LABEL: Record<CtrlType, string> = {
  signup: "complete your sign-up",
  "change-email": "confirm your new email",
  "add-password-cred": "link this email to your account",
  reset: "reset your password",
};

async function sendOtpEmail(email: string, type: OtpType, verifierToken: string, origin: string) {
  const { subject, body } = OTP_EMAILS[type];
  const { html, text } = renderEmail({
    heading: subject,
    body,
    ctaText: "Confirm",
    url: `${origin}/auth/otp?vt=${verifierToken}`,
    footer: IGNORE_FOOTER,
  });
  await sendMail({ to: email, subject, html, text });
}

// The (N+1)th daily email — announces itself as final and carries a
// controller-token link so the legitimate inbox owner can still finish the
// action today (auth-flows.md §Controller-token, use 2).
async function sendCapNotice(email: string, type: CtrlType, ctrl: string, origin: string) {
  const action = CTRL_ACTION_LABEL[type];
  const subject = `Final email today — ${action}`;
  const { html, text } = renderEmail({
    heading: subject,
    body: `Too many attempts have been made for this address today. This link is the only way to ${action} today; further requests today will be ignored.`,
    ctaText: "Continue",
    url: `${origin}/auth/reset?ct=${ctrl}`,
    footer: IGNORE_FOOTER,
  });
  await sendMail({ to: email, subject, html, text });
}

async function sendResetEmail(email: string, ctrl: string, origin: string) {
  const subject = "Reset your password";
  const { html, text } = renderEmail({
    heading: subject,
    body: "Tap the button below to reset your password. The link is valid for 30 minutes.",
    ctaText: "Reset password",
    url: `${origin}/auth/reset?ct=${ctrl}`,
    footer: IGNORE_FOOTER,
  });
  await sendMail({ to: email, subject, html, text });
}

// ── Reverse-OTP API ──────────────────────────────────────────────────────────
export type OtpStartResult = { actorToken: string; otp: string };

/**
 * Either creates a real otpVerification row or returns a synthetic actor-token + otp.
 * `realPath` decides which. For ignored cases (e.g. signup against an existing email)
 * pass realPath=false.
 */
export async function startOtp(opts: {
  email: string;
  type: OtpType;
  realPath: boolean;
  origin: string;
  originUserId?: string;
}): Promise<OtpStartResult> {
  const actorToken = newActorToken();
  const otp = newOtp();
  // Synthetic (ignored case) or over the daily cap: no row, no OTP email.
  if (!opts.realPath) return { actorToken, otp };

  await sendUnderDailyCap(opts, async () => {
    const verifierToken = newVerifierToken();
    const now = new Date();
    await db.insert(otpVerification).values({
      id: newOtpRowId(),
      actorToken,
      verifierToken,
      otp,
      attempts: 0,
      verified: false,
      type: opts.type,
      email: opts.email.toLowerCase(),
      originUserId: opts.originUserId ?? null,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      createdAt: now,
      updatedAt: now,
    });
    await sendOtpEmail(opts.email, opts.type, verifierToken, opts.origin);
  });
  return { actorToken, otp };
}

async function readVerif(by: "actorToken" | "verifierToken", token: string) {
  const r = await firstRow(
    db.select().from(otpVerification).where(eq(otpVerification[by], token)).limit(1),
  );
  if (!r) return null;
  return { row: r, expired: r.expiresAt.getTime() < Date.now() };
}

export type RotateResult =
  | { kind: "ok"; otp: string }
  | { kind: "verified" }
  | { kind: "expired" }
  | { kind: "too_frequent"; retryAfterMs: number };

/**
 * Rotate the OTP. State matrix per auth-flows.md §reverse-OTP-vs-classic:
 *   no row | unverified+expired → ok with fresh UI-only OTP, no server change
 *   verified+fresh              → "verified" — already done, originator should Proceed
 *   verified+expired            → "expired" terminal, delete row
 *   unverified+fresh (real)     → rotate code, reset attempts; link stable
 */
export async function rotateOtp(actorToken: string): Promise<RotateResult> {
  const cd = checkActionCooldown("rotate", actorToken);
  if (!cd.ok) return { kind: "too_frequent", retryAfterMs: cd.retryAfterMs };
  setActionCooldown("rotate", actorToken);

  const otp = newOtp();
  const found = await readVerif("actorToken", actorToken);
  if (!found || (found.expired && !found.row.verified)) return { kind: "ok", otp };
  if (found.row.verified && found.expired) {
    await db.delete(otpVerification).where(eq(otpVerification.id, found.row.id));
    return { kind: "expired" };
  }
  if (found.row.verified) return { kind: "verified" };
  await db
    .update(otpVerification)
    .set({ otp, attempts: 0, updatedAt: new Date() })
    .where(eq(otpVerification.id, found.row.id));
  return { kind: "ok", otp };
}

export async function cancelOtp(actorToken: string) {
  await db.delete(otpVerification).where(eq(otpVerification.actorToken, actorToken));
}

export type OtpDestState =
  | { status: "loaded"; email: string; attemptsLeft: number }
  | { status: "invalid" }
  | { status: "verified"; email: string };

export async function loadDestination(verifierToken: string): Promise<OtpDestState> {
  const found = await readVerif("verifierToken", verifierToken);
  if (!found || found.expired) return { status: "invalid" };
  if (found.row.verified) return { status: "verified", email: found.row.email };
  return {
    status: "loaded",
    email: found.row.email,
    attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - found.row.attempts),
  };
}

export type OtpAttemptResult =
  | { ok: true }
  | { ok: false; error: "WRONG_CODE"; attemptsLeft: number }
  | { ok: false; error: "INVALID_OR_EXPIRED" }
  | { ok: false; error: "TOO_MANY_ATTEMPTS" };

export async function attemptOtp(verifierToken: string, code: string): Promise<OtpAttemptResult> {
  const found = await readVerif("verifierToken", verifierToken);
  if (!found || found.expired) return { ok: false, error: "INVALID_OR_EXPIRED" };
  const r = found.row;
  if (r.verified) return { ok: true };
  if (r.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: "TOO_MANY_ATTEMPTS" };

  if (!safeEq(r.otp, code)) {
    // Atomic increment — RETURNING the post-image keeps the brute-force bound
    // tight under concurrent attempts.
    const [updated] = await db
      .update(otpVerification)
      .set({ attempts: sql`${otpVerification.attempts} + 1`, updatedAt: new Date() })
      .where(eq(otpVerification.id, r.id))
      .returning({ attempts: otpVerification.attempts });
    if (updated.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: "TOO_MANY_ATTEMPTS" };
    return { ok: false, error: "WRONG_CODE", attemptsLeft: OTP_MAX_ATTEMPTS - updated.attempts };
  }

  await db
    .update(otpVerification)
    .set({ verified: true, updatedAt: new Date() })
    .where(eq(otpVerification.id, r.id));
  return { ok: true };
}

export type ConsumeResult =
  | { kind: "ok"; row: OtpRow }
  | { kind: "expired" }
  | { kind: "fail" }
  | { kind: "too_frequent"; retryAfterMs: number };

/**
 * Any failed proceed leaves the row alive — it ages out via TTL like any
 * unvisited verification. The row is consumed only on success or on the
 * verified-but-expired terminal.
 *
 * `sessionUserId` is the currently signed-in user's id (or null). When the
 * row carries `originUserId` (signed-in flows: change-email, add-credential),
 * a session mismatch returns fail without consuming.
 */
export async function consumeOtp(
  actorToken: string,
  sessionUserId: string | null,
): Promise<ConsumeResult> {
  const cd = checkActionCooldown("proceed", actorToken);
  if (!cd.ok) return { kind: "too_frequent", retryAfterMs: cd.retryAfterMs };
  setActionCooldown("proceed", actorToken);

  const found = await readVerif("actorToken", actorToken);
  if (!found) return { kind: "fail" };

  if (found.row.verified && found.expired) {
    await db.delete(otpVerification).where(eq(otpVerification.id, found.row.id));
    return { kind: "expired" };
  }

  if (!found.row.verified || found.expired) return { kind: "fail" };

  if (found.row.originUserId !== null && found.row.originUserId !== sessionUserId) {
    return { kind: "fail" };
  }

  await db.delete(otpVerification).where(eq(otpVerification.id, found.row.id));
  return { kind: "ok", row: found.row };
}

// ── Controller-token store ───────────────────────────────────────────────────
// `reset` plus the three sign-up-shape types — a cap-notice controller token
// carries the same type as the verification it replaces, so the destination
// can dispatch the correct commit (auth-flows.md §Controller-token, use 2).
export type CtrlType = "reset" | OtpType;
export type CtrlRow = typeof ctrlVerification.$inferSelect;

export async function mintControllerToken(opts: {
  email: string;
  type: CtrlType;
  originUserId?: string;
}) {
  const token = newControllerToken();
  const now = new Date();
  await db.insert(ctrlVerification).values({
    id: newCtrlRowId(),
    token,
    type: opts.type,
    email: opts.email.toLowerCase(),
    originUserId: opts.originUserId ?? null,
    expiresAt: new Date(now.getTime() + CONTROLLER_TTL_MS),
    createdAt: now,
    updatedAt: now,
  });
  return { token };
}

export async function lookupControllerToken(token: string) {
  const r = await firstRow(
    db.select().from(ctrlVerification).where(eq(ctrlVerification.token, token)).limit(1),
  );
  if (!r) return null;
  if (r.expiresAt.getTime() < Date.now()) {
    await db.delete(ctrlVerification).where(eq(ctrlVerification.id, r.id));
    return null;
  }
  return { row: r };
}

// Single-use consumption, split from lookup so a commit can run its own gates
// (session binding, email still free) before burning the token.
export async function deleteControllerToken(rowId: string) {
  await db.delete(ctrlVerification).where(eq(ctrlVerification.id, rowId));
}

export async function startResetFlow(email: string, origin: string): Promise<void> {
  // Synthetic conditions (uniform "you'll get an email" reply, nothing sent):
  // - email unregistered (no password credential — Google-only users have no
  //   password to reset; their claim email isn't a registration)
  // - resetDisabled on the user
  // - daily cap reached (a final cap-notice email is sent if not already today)
  const eml = email.toLowerCase();
  const u = await findUserByEmail(eml);
  if (!u || u.resetDisabled) return;
  if (!(await findPasswordCred(u.id))) return;

  await sendUnderDailyCap({ email: eml, type: "reset", origin }, async () => {
    const ctrl = await mintControllerToken({ email: eml, type: "reset" });
    await sendResetEmail(eml, ctrl.token, origin);
  });
}

// ── User & credential helpers ────────────────────────────────────────────────
export type CredProvider = "password" | "google" | "github";
export type OAuthProvider = Exclude<CredProvider, "password">;

export async function findUserByEmail(email: string) {
  return firstRow(db.select().from(user).where(eq(user.email, email.toLowerCase())).limit(1));
}

export async function findUserById(userId: string) {
  return firstRow(db.select().from(user).where(eq(user.id, userId)).limit(1));
}

export async function findCred(userId: string, provider: CredProvider) {
  return firstRow(
    db
      .select()
      .from(credential)
      .where(and(eq(credential.userId, userId), eq(credential.providerId, provider)))
      .limit(1),
  );
}

export const findPasswordCred = (userId: string) => findCred(userId, "password");

export async function findCredByAccount(provider: OAuthProvider, accountId: string) {
  return firstRow(
    db
      .select()
      .from(credential)
      .where(and(eq(credential.providerId, provider), eq(credential.accountId, accountId)))
      .limit(1),
  );
}

export async function deleteCred(userId: string, provider: OAuthProvider) {
  await db
    .delete(credential)
    .where(and(eq(credential.userId, userId), eq(credential.providerId, provider)));
}

export async function listUserCreds(userId: string) {
  return await db.select().from(credential).where(eq(credential.userId, userId));
}

// The `me` shape the SPA anchors on — shared by GET /auth/api/me and the
// page's server load so the two can't drift.
export async function buildMe(s: { user: typeof user.$inferSelect; session: { createdAt: Date } }) {
  const creds = await listUserCreds(s.user.id);
  return {
    user: {
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      resetDisabled: s.user.resetDisabled,
    },
    credentials: creds.map((c) => ({
      providerId: c.providerId as string,
      accountId: c.accountId,
      // Password credentials have null credential.email — the email lives
      // on user.email. Surface it here so the client doesn't reach across rows.
      email: c.providerId === "password" ? s.user.email : c.email,
    })),
    sessionFresh: isSessionFresh(s.session),
  };
}

async function insertUser() {
  const uid = newUserId();
  const now = new Date();
  await db.insert(user).values({
    id: uid,
    // OAuth name/email claims are deliberately NOT promoted to user.name/email.
    name: null,
    email: null,
    resetDisabled: false,
    createdAt: now,
    updatedAt: now,
  });
  return uid;
}

export async function createUserWithPasswordCred(opts: { email: string; passwordHash: string }) {
  const uid = await insertUser();
  await attachPasswordCred(uid, opts.email, opts.passwordHash);
  return uid;
}

export async function attachPasswordCred(userId: string, email: string, passwordHash: string) {
  const now = new Date();
  await db.insert(credential).values({
    id: newCredentialId(),
    providerId: "password",
    userId,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  });
  await changeUserEmail(userId, email);
}

export async function changeUserEmail(userId: string, newEmail: string) {
  const eml = newEmail.toLowerCase();
  await db.update(user).set({ email: eml, updatedAt: new Date() }).where(eq(user.id, userId));
}

export async function setPasswordCredHash(userId: string, passwordHash: string) {
  await db
    .update(credential)
    .set({ passwordHash, updatedAt: new Date() })
    .where(and(eq(credential.userId, userId), eq(credential.providerId, "password")));
}

export async function deletePasswordCred(userId: string) {
  await db
    .delete(credential)
    .where(and(eq(credential.userId, userId), eq(credential.providerId, "password")));
  // Clear correspondent email and reset the resetDisabled flag — it's only
  // meaningful while a password credential exists.
  await db
    .update(user)
    .set({ email: null, resetDisabled: false, updatedAt: new Date() })
    .where(eq(user.id, userId));
}

export type OAuthCredInput = {
  accountId: string;
  email: string | null; // OAuth claim — stored on credential.email; NOT copied to user.email
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
};

export async function attachOAuthCred(
  provider: OAuthProvider,
  userId: string,
  opts: OAuthCredInput,
) {
  const now = new Date();
  await db.insert(credential).values({
    id: newCredentialId(),
    accountId: opts.accountId,
    providerId: provider,
    userId,
    email: opts.email?.toLowerCase() ?? null,
    accessToken: opts.accessToken ?? null,
    refreshToken: opts.refreshToken ?? null,
    idToken: opts.idToken ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function createUserWithOAuthCred(provider: OAuthProvider, opts: OAuthCredInput) {
  const uid = await insertUser();
  await attachOAuthCred(provider, uid, opts);
  return uid;
}

export async function setUserName(userId: string, name: string | null) {
  await db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, userId));
}

export async function setResetDisabled(userId: string, disabled: boolean) {
  await db
    .update(user)
    .set({ resetDisabled: disabled, updatedAt: new Date() })
    .where(eq(user.id, userId));
}

export async function deleteUserCascade(userId: string) {
  // session/credential/otpVerification/ctrlVerification all cascade via FK on user.id
  await db.delete(user).where(eq(user.id, userId));
}

// ── OAuth state helpers (HMAC-signed, no DB) ─────────────────────────────────
export function signState(payload: object) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifyState<T = unknown>(s: string): T | null {
  const [body, sig] = s.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  if (!safeEq(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
