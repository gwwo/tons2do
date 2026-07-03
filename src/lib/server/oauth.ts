import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import {
  attachOAuthCred,
  createSession,
  createUserWithOAuthCred,
  deleteSessionById,
  findCredByAccount,
  signState,
  verifyState,
  type OAuthCredInput,
  type OAuthProvider,
} from "./user-auth";

// The OAuth machinery is shared by three intents — `sign-in`, `link`, and
// `re-sign-in` (recovery) — and by both providers. The intent rides in the
// HMAC-signed `state` blob, so one start/callback pair serves all three, and
// the intent dispatch below is provider-independent once the callback has
// normalized the provider's user info to OAuthCredInput.
type Intent = "sign-in" | "link" | "re-sign-in";
type State = { n: string; cb: string; intent: Intent; uid: string | null };

type ProviderDef = {
  envPrefix: string;
  authorize: (p: { clientId: string; redirectUri: string; state: string }) => string;
  // Exchange the callback `code` and fetch the provider's user info,
  // normalized to OAuthCredInput. Throws SvelteKit errors on failure.
  exchange: (p: { clientId: string; clientSecret: string; redirectUri: string; code: string }) => Promise<OAuthCredInput>;
  // Best-effort — never throws; called before credential/user deletion so the
  // provider drops the app authorization and the next link shows a fresh
  // consent screen instead of silently re-authorizing.
  revoke: (accessToken: string | null) => Promise<void>;
};

type GoogleTokenResp = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
};
type GithubTokenResp = {
  access_token?: string;
  error?: string;
  error_description?: string;
};
type GithubEmail = { email: string; primary: boolean; verified: boolean };

const PROVIDERS: Record<OAuthProvider, ProviderDef> = {
  google: {
    envPrefix: "GOOGLE",
    authorize: ({ clientId, redirectUri, state }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        access_type: "offline",
        prompt: "login", // force re-auth on Google's side every time
        state,
      })}`,
    async exchange({ clientId, clientSecret, redirectUri, code }) {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) error(502, `google token exchange failed: ${tokenRes.status}`);
      const tokens = (await tokenRes.json()) as GoogleTokenResp;

      // We don't verify the id_token JWS — userinfo over TLS stands in for it.
      const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (!userRes.ok) error(502, "google userinfo failed");
      const info = (await userRes.json()) as { sub?: string; email?: string };
      if (!info.sub) error(502, "no Google subject");
      return {
        accountId: info.sub,
        email: info.email ?? null,
        accessToken: tokens.access_token ?? null,
        refreshToken: tokens.refresh_token ?? null,
        idToken: tokens.id_token ?? null,
      };
    },
    async revoke(accessToken) {
      if (!accessToken) return;
      try {
        await fetch(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
          { method: "POST" },
        );
      } catch {
        // best-effort
      }
    },
  },
  github: {
    envPrefix: "GITHUB",
    authorize: ({ clientId, redirectUri, state }) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "read:user user:email",
        state,
        allow_signup: "true",
      })}`,
    async exchange({ clientId, clientSecret, redirectUri, code }) {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
      });
      if (!tokenRes.ok) error(502, `github token exchange failed: ${tokenRes.status}`);
      const tokens = (await tokenRes.json()) as GithubTokenResp;
      if (tokens.error || !tokens.access_token) {
        error(502, `github token error: ${tokens.error_description ?? tokens.error ?? "unknown"}`);
      }

      const gh = { authorization: `Bearer ${tokens.access_token}`, accept: "application/vnd.github+json" };
      const userRes = await fetch("https://api.github.com/user", { headers: gh });
      if (!userRes.ok) error(502, "github user fetch failed");
      const ghUser = (await userRes.json()) as { id?: number; email: string | null };
      if (!ghUser.id) error(502, "no GitHub user id");

      // GitHub may not expose email on the user endpoint if it's private — fall
      // back to the emails endpoint to get the primary verified address.
      let email = ghUser.email;
      if (!email) {
        const emailsRes = await fetch("https://api.github.com/user/emails", { headers: gh });
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as GithubEmail[];
          email = emails.find((e) => e.primary && e.verified)?.email ?? null;
        }
      }
      return { accountId: String(ghUser.id), email, accessToken: tokens.access_token };
    },
    async revoke(accessToken) {
      if (!accessToken) return;
      const clientId = env.GITHUB_CLIENT_ID;
      const clientSecret = env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) return;
      try {
        await fetch(`https://api.github.com/applications/${clientId}/grant`, {
          method: "DELETE",
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_token: accessToken }),
        });
      } catch {
        // best-effort
      }
    },
  },
};

export const revokeOAuthGrant = (provider: OAuthProvider, accessToken: string | null) =>
  PROVIDERS[provider].revoke(accessToken);

function credentials(provider: OAuthProvider) {
  const def = PROVIDERS[provider];
  const clientId = env[`${def.envPrefix}_CLIENT_ID`];
  const clientSecret = env[`${def.envPrefix}_CLIENT_SECRET`];
  return { def, clientId, clientSecret };
}

const redirectUriFor = (origin: string, provider: OAuthProvider) =>
  `${origin}/auth/api/${provider}/callback`;

export function oauthStart(provider: OAuthProvider): RequestHandler {
  return async ({ url, locals }) => {
    const { def, clientId } = credentials(provider);
    if (!clientId) error(500, `${def.envPrefix}_CLIENT_ID not configured`);
    const rawIntent = url.searchParams.get("intent");
    const intent: Intent =
      rawIntent === "link" ? "link" : rawIntent === "re-sign-in" ? "re-sign-in" : "sign-in";

    const state = signState({
      n: Math.random().toString(36).slice(2),
      cb: url.searchParams.get("callbackURL") ?? "/auth/oauth-done",
      intent,
      // link: the linking user must be signed in, so take uid from the session.
      // re-sign-in: the cookie may be gone or hold a different user, so the
      //   client carries the user it wants to re-sign-in as; the callback proves
      //   it by checking the authenticated account is linked to that uid.
      // sign-in: no uid.
      uid:
        intent === "link"
          ? (locals.user?.user.id ?? null)
          : intent === "re-sign-in"
            ? url.searchParams.get("uid")
            : null,
    } satisfies State);

    const authUrl = def.authorize({
      clientId,
      redirectUri: redirectUriFor(url.origin, provider),
      state,
    });
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting</title></head><body><script>location.replace(${JSON.stringify(authUrl)})</script></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
}

export function oauthCallback(provider: OAuthProvider): RequestHandler {
  return async (event) => {
    const { url, locals } = event;
    const code = url.searchParams.get("code");
    const stateRaw = url.searchParams.get("state");
    if (!code || !stateRaw) error(400, "missing code or state");
    const state = verifyState<State>(stateRaw);
    if (!state) error(400, "invalid state");

    const { def, clientId, clientSecret } = credentials(provider);
    if (!clientId || !clientSecret) error(500, `${def.envPrefix} OAuth not configured`);

    const info = await def.exchange({
      clientId,
      clientSecret,
      redirectUri: redirectUriFor(url.origin, provider),
      code,
    });

    if (state.intent === "re-sign-in") {
      // The client carried the user it wants to re-sign-in as (state.uid). The
      // ambient cookie is not trusted to pick the user — it may be gone, or hold
      // a different user (a swap). The proof is a fresh provider auth whose
      // account is actually linked to that user.
      if (!state.uid) redirect(302, `${state.cb}?error=resign-no-uid`);
      const matched = await findCredByAccount(provider, info.accountId);
      if (!matched || matched.userId !== state.uid) {
        redirect(302, `${state.cb}?error=resign-user-mismatch`);
      }
      // The cookie's current session (a stale one of ours, or another user's
      // after a swap) is being replaced — delete it rather than orphan it.
      if (locals.user) await deleteSessionById(locals.user.session.id);
      await createSession(matched.userId, event);
      redirect(302, state.cb);
    }

    if (state.intent === "link") {
      if (!locals.user || locals.user.user.id !== state.uid) {
        // signed-in user mismatch — bounce home with an error
        redirect(302, `${state.cb}?error=link-session-mismatch`);
      }
      // Refuse to attach if this account is already attached to another user.
      const existing = await findCredByAccount(provider, info.accountId);
      if (existing && existing.userId !== locals.user.user.id) {
        redirect(302, `${state.cb}?error=${provider}-already-linked`);
      }
      if (!existing) await attachOAuthCred(provider, locals.user.user.id, info);
      redirect(302, state.cb);
    }

    // intent = sign-in: match on (provider, accountId); no implicit email-link —
    // the OAuth email claim stays on the credential row, never on user.email.
    const existing = await findCredByAccount(provider, info.accountId);
    // (could refresh the stored OAuth tokens here on a match; skipped for the demo)
    const userId = existing ? existing.userId : await createUserWithOAuthCred(provider, info);
    await createSession(userId, event);
    redirect(302, existing ? state.cb : `${state.cb}?new=1`);
  };
}
