# Auth / Account-Management Refactor Plan

Scope: everything implementing `design/auth-flows.md` — server logic, API router,
OAuth routes, destination pages, and the user-panel SPA (tab-wise user state).

## Inventory (before)

| Area | Files | LOC |
|---|---|---|
| Server core | `src/lib/server/user-auth.ts` | 876 |
| API router | `src/routes/auth/api/[op]/+server.ts` | 462 |
| OAuth routes | `google/{start,callback}`, `github/{start,callback}` | 353 |
| Destination pages | `auth/otp/*`, `auth/reset/*`, `auth/oauth-done` | 296 |
| User panel | `src/lib/components/user-panel/*` | 1,875 |
| Schema / mailer / hooks | `auth-schema.ts`, `mailer.ts`, `hooks.server.ts` | 251 |
| **Total** | | **~4,100** |

Target: same behavior (modulo bug fixes below), ~600–700 fewer lines, no new
dependencies, no API-shape changes visible to the browser except where a bug fix
requires one (B1).

---

## Bugs found

### B1 — Daily-cap escape hatch is a dead end (broken feature)
`sendCapNoticeSignup` links to `/auth/otp/final?ct=…` — **that route does not
exist** (404). Even if it did, a `type=signup` controller token is
unconsumable: `reset-submit` rejects `row.type !== "reset"` and the reset
destination loader only accepts `type === "reset"`. So the (N+1)th daily email —
the only path the design leaves open after the cap — leads nowhere.
Additionally `startResetFlow` sends the *sign-up-worded* cap notice
("complete your sign-up") for the reset flow.

**Fix** (per design §Controller-token use 2: the ctrl row carries the same
`type` as the verification it replaces, and the destination dispatches on it):
- Extend `ctrl_verification_type` enum to `reset | signup | change-email |
  add-password-cred` (additive; applied via `drizzle-kit push`).
- `startOtp`'s cap branch mints the OTP row's actual `type` (and keeps
  `originUserId` for signed-in types). `startResetFlow` keeps `type=reset`.
- One generic controller destination: `/auth/reset?ct=…` for all types
  (the page copy + payload form vary by type; change-email needs no password
  field). Cap-notice email wording becomes type-appropriate and links there.
- `reset-submit` (renamed internally to a dispatch) commits per type:
  - `reset` — swap hash, delete row, revoke all sessions (unchanged).
  - `signup` — create user + password credential + session; refuse if the email
    got registered meanwhile.
  - `add-password-cred` / `change-email` — require a live session matching
    `row.originUserId` (design §Controller-token: signed-in ctrl rows are
    session-bound), then attach credential / change email.

### B2 — OTP `proceed` commits don't re-check invariants (race → 500 / data corruption)
The `signup` branch of `otp-proceed` re-checks "email got registered while you
were verifying"; the `change-email` and `add-password-cred` branches don't.
Between start and proceed the address can become registered → the commit hits
the `user.email` unique constraint → raw 500. Worse: `credential` has **no
unique `(userId, providerId)` constraint**, so two concurrent
`add-password-cred` flows for the same user (both started while no password
credential existed) would each attach a password credential row — corrupting
the "at most one password credential" invariant.

**Fix**: at proceed, re-check `findUserByEmail(row.email)` (and for
`add-password-cred`, that the user still has no password credential) and return
a clean 409, mirroring the signup branch.

### B3 — `revokeOtherSessions` is an N+1 loop
Selects all sessions then deletes one-by-one. **Fix**: single
`DELETE WHERE userId = ? AND token != ?` — fewer lines, atomic.

### B4 — `loadMe()` network failure is an unhandled rejection
`UserPanel.onMount` awaits `loadMe()` bare; a fetch failure (offline) throws
uncaught. **Fix (as implemented)**: catch at the onMount call site — the cached
view stays up and there's nothing actionable. `loadMe` keeps its throwing
contract, because callers that *do* care (`refresh()` in `+page.svelte`, the
freshness pre-checks in UserView) already handle the rejection and must be able
to distinguish "network failed" from "session invalid".

### B5 — Stale-session detection sniffs the error prose
`interceptStale` matches `/fresh/` against `r.data.message`. Rewording the
server message would silently break re-sign-in recovery. **Fix**: the three
freshness-gated ops return a structured `code: "stale-session"` on the error
body (App.Error extended); the client checks the code.

### Noted, deliberately not fixed (out of scope, documented gaps)
- **Enumeration timing side-channel**: the real OTP path awaits a DB insert +
  email send; the synthetic path returns immediately. The design only pads the
  bcrypt. Fixing well needs queued sends; noting only.
- **Daily-send cap is in-memory** — design requires durable backing; the code
  already comments this. Needs a small DB table or Redis; separate change.
- **Rate-limit stack** (per-IP / per-email / per-user) from the design's draft
  section is unimplemented apart from the OTP action cooldown. Separate change.
- `id_token` is stored unverified (design accepts this for the demo).

---

## Refactors

### R1 — `user-auth.ts`: collapse per-provider duplication (~-230 LOC)
- **Generic credential helpers**: `findCred(userId, provider)`,
  `findCredByAccount(provider, accountId)`, `deleteCred(userId, provider)`,
  `attachOAuthCred(provider, opts)`, `createUserWithOAuthCred(provider, opts)`
  replace the 10 google/github/password copies (`findGoogleCred`,
  `findGithubCred`, `findGoogleCredByAccountId`, …). `findPasswordCred(uid)`
  stays as a one-line alias since it's semantically distinct (the invariant
  credential).
- **`firstRow` helper** for the `(await db.select()…limit(1))[0] ?? null`
  pattern (~10 sites).
- **Merge `readVerifByActor`/`readVerifByVerifier`** into one lookup
  parameterized by column.
- **`sendUnderDailyCap(email, type, originUserId, send)`**: the cap-check →
  cap-notice → bump → send → refund-on-error dance is duplicated between
  `startOtp` and `startResetFlow`; extract once.
- **Email templates as data**: one `AUTH_EMAILS[type]` table (subject, body,
  cta, path) replacing three near-identical sender functions; cap-notice
  wording keyed by type (B1).
- Rename `newCtrlRowId` prefix `ct_` → `cv_` (collided with
  `newControllerToken`'s prefix; cosmetic but confusing in logs).
- Provider token revocation (`revokeGoogleToken` / `revokeGithubGrant`) moves
  into the shared provider config (R2) as `revoke(accessToken)`.

### R2 — Shared OAuth provider module (~-150 LOC)
New `src/lib/server/oauth.ts`:
- `PROVIDERS: Record<"google" | "github", {...}>` — auth URL builder, token
  exchange, user-info fetch normalized to `{ accountId, email, tokens }`,
  token revocation.
- `oauthStart(provider, event)` — the two `start/+server.ts` files are
  line-identical except for URL/scope/env; both become ~6-line wrappers.
- `oauthCallback(provider, event)` — the `re-sign-in` / `link` / `sign-in`
  intent dispatch is provider-independent once user info is normalized; both
  callbacks become ~6-line wrappers. Error redirect codes
  (`google-already-linked` / `github-already-linked`, `resign-user-mismatch`,
  `link-session-mismatch`) preserved verbatim.

### R3 — API router `[op]/+server.ts` (~-80 LOC)
- **`passwordOrFreshnessGate(s, body, { requirePassword })`**: the
  verify-password → `refreshSession` (or freshness fallback) block appears 6×
  (`delete-password-cred`, `delete-google-cred`, `delete-github-cred`,
  `disable-reset`, `delete-user`, `change-password-cred-start`); extract once.
  The `delete-user` no-refresh special case is a flag.
- **Merge `delete-google-cred` / `delete-github-cred`** into one handler
  parameterized by provider (op names unchanged on the wire).
- **`buildMe(s)`** shared between the `me` GET and `+page.server.ts` (the
  credential-email projection is currently duplicated).
- B1's type dispatch lands in `reset-submit`; B2's re-checks land in
  `otp-proceed`.

### R4 — `UserView.svelte` (~-280 LOC, biggest win)
- **`OAuthCredSection.svelte`** (new, ~130 LOC): the Google and GitHub blocks —
  link row, unlink form with lockout warning, sole-credential info row, icon,
  `checking` state — are ~100 lines each and differ only in provider
  name/icon/handler. One component, two instantiations.
- **`guarded(op, body, { onOk })` runner**: every action repeats
  `form.wrap(meApi) → intercept401 → interceptUserMismatch → [interceptStale]
  → flash(error) → clearInputs/loadMe/flash(info)`. One helper collapses the
  10 handler functions to ~3 lines each.
- **Merge `startDeleteGoogleCred` / `startDeleteGithubCred` /
  `startDeleteUser`** into `startGuardedAction(action)` — they're identical
  modulo the action key and checking flag.
- **Merge `linkGoogle` / `linkGithub`** into `linkProvider(provider)`.

### R5 — OAuth popup flows in `Welcome` / `ReSignIn` (~-60 LOC)
`utils.svelte.ts` gains `runOAuth(provider, intent, opts)` wrapping
`oauthPopup` + the blocked/cancelled/error handling + error-code→message
mapping (the `GOOGLE_RESIGN_ERRORS` / `GITHUB_RESIGN_ERRORS` tables merge into
one keyed on provider label). `Welcome.googleSignIn/githubSignIn`,
`ReSignIn.doGoogle/doGithub`, and `UserView.linkProvider` all call it.

### R6 — Destination pages (~-40 LOC net, includes B1's new form states)
- **`SpinnerButton.svelte`** (user-panel): the hydration-gated submit button
  with the inline SVG spinner is duplicated in `auth/otp` and `auth/reset`;
  extract.
- `/auth/reset` becomes the generic controller destination (B1): loader
  returns `{ email, type }` for any live token; the page varies heading/copy
  and posts the type-appropriate payload.

### Not worth touching
`ActionRow`, `PasswordInput`, `SectionHeader`, `OtpProceed`, `UserPanel`
module-scope anchoring, `hooks.server.ts`, `mailer.ts`, the margin/scroll
choreography in `UserView`, and the `+page.svelte` `onAuthChange` wiring are
already tight, single-purpose, or deliberately subtle (documented invariants);
rewriting them risks behavior for little LOC gain.

---

## Execution order

1. `user-auth.ts` core refactor (R1) + B3.
2. Controller-token dispatch + enum extension (B1) — server side.
3. `src/lib/server/oauth.ts` + thin route wrappers (R2).
4. API router (R3) + B2 + B5 server side.
5. Destination pages (R6) + B1 client side.
6. User panel (R4, R5) + B4 + B5 client side.
7. Verify: `bun run check` (svelte-check) + `bun run lint`; grep for dangling
   imports of removed helpers.

## Verification

- `svelte-check` clean (same error count as baseline or better).
- Every op name, request body field, response `shape`/`kind` value, redirect
  error code, and cookie behavior preserved — except `reset-submit`, which
  additionally accepts the three new token types (strictly more accepted
  inputs, no changed outputs for existing ones).
- Grep-audit: no remaining references to removed helpers
  (`findGoogleCred`, `sendCapNoticeSignup`, `GOOGLE_RESIGN_ERRORS`, …).

## Outcome (2026-07-02)

Implemented as planned; verified with `svelte-check` (0 errors, 32 warnings vs
34 at baseline), eslint on the touched files (only the 3 pre-existing errors in
untouched files remain), and a clean `vite build`. No live smoke test — no
database available in this environment.

**Net diff: +762 / −1,539 in modified files, plus 3 new files (440 lines:
`oauth.ts` 276, `OAuthCredSection.svelte` 139, `HydratedSubmit.svelte` 25) —
~340 lines net smaller while adding the whole controller-destination dispatch
(B1) that previously didn't exist.**

Deliberate small deviations, all cosmetic:
- The sole-credential info rows now use the same iconify provider icons as the
  unlink rows (previously hand-inlined SVGs — the GitHub one renders in
  `currentColor` either way; the Google one is the same colored logo).
- Unknown OAuth-callback error codes now surface raw (previously "Failed to
  link Google.") — known codes are still mapped to friendly text.
- OAuth popup window names are now `${provider}-${intent}` (was `googleLink`
  etc.); the name only dedupes concurrently open popups.

**Deploy note**: the `ctrl_verification_type` pg enum gained two values
(`change-email`, `add-password-cred`) — run `drizzle-kit push` (the compose
`migrate` service) before or with the deploy. Enum value additions are
non-destructive.
