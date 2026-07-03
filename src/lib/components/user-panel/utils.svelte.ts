export class FormState {
  busy = $state(false);
  error = $state<string | null>(null);
  info = $state<string | null>(null);

  reset() {
    this.error = null;
    this.info = null;
  }

  async run<T extends { error?: { message?: string } | null }>(
    fn: () => Promise<T>,
    fallbackError: string,
  ): Promise<T> {
    this.reset();
    this.busy = true;
    try {
      const result = await fn();
      if (result.error) this.error = result.error.message ?? fallbackError;
      return result;
    } finally {
      this.busy = false;
    }
  }

  async wrap<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}

export type OAuthProvider = "google" | "github";
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["google", "github"];
export const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};
export const PROVIDER_ICON: Record<OAuthProvider, string> = {
  google: "icon-[logos--google-icon]",
  github: "icon-[logos--github-icon]",
};

// Known callback error codes → user-facing text; unknown codes pass through.
function oauthErrorText(provider: OAuthProvider, code: string): string {
  const P = PROVIDER_LABEL[provider];
  const map: Record<string, string> = {
    [`${provider}-already-linked`]: `That ${P} account is already linked to another user.`,
    "link-session-mismatch": "Session changed during linking — re-sign in.",
    "resign-user-mismatch": `That ${P} account isn't linked to this account.`,
    "resign-no-uid": `Couldn't start ${P} re-sign-in — please try again.`,
  };
  return map[code] ?? code;
}

export type OAuthResult =
  | { kind: "ok"; newUser: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

// One popup round-trip for any provider × intent, with blocked/error handling
// folded in. Must be called synchronously from a user gesture handler.
export async function runOAuth(
  provider: OAuthProvider,
  intent: "sign-in" | "link" | "re-sign-in",
  uid?: string,
): Promise<OAuthResult> {
  const query =
    `intent=${intent}&callbackURL=/auth/oauth-done` +
    (uid ? `&uid=${encodeURIComponent(uid)}` : "");
  const r = await oauthPopup(`/auth/api/${provider}/start?${query}`, `${provider}-${intent}`);
  if (r.kind === "blocked") {
    return { kind: "error", message: "Popup blocked — please allow popups and try again." };
  }
  if (r.kind === "cancelled") return { kind: "cancelled" };
  if (r.kind === "error") return { kind: "error", message: oauthErrorText(provider, r.error) };
  return { kind: "ok", newUser: r.newUser };
}

export type OAuthPopupResult =
  | { kind: "ok"; newUser: boolean }
  | { kind: "error"; error: string }
  | { kind: "cancelled" }
  | { kind: "blocked" };

// Must be called synchronously from a user gesture handler — otherwise popup blockers fire.
export function oauthPopup(url: string, name: string): Promise<OAuthPopupResult> {
  const popup = window.open(url, name, "width=500,height=650");
  if (!popup) return Promise.resolve({ kind: "blocked" });

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedPoll);
    };
    function onMessage(e: MessageEvent) {
      if (e.origin !== location.origin) return;
      if (!e.data || e.data.type !== "oauth-done") return;
      if (settled) return;
      cleanup();
      if (e.data.ok) resolve({ kind: "ok", newUser: !!e.data.newUser });
      else resolve({ kind: "error", error: e.data.error || "Failed" });
    }
    const closedPoll = setInterval(() => {
      if (popup.closed && !settled) {
        cleanup();
        resolve({ kind: "cancelled" });
      }
    }, 500);
    window.addEventListener("message", onMessage);
  });
}

export class Cooldown {
  #remain = $state(0);
  #active = $state(false);
  get remain() {
    return this.#remain;
  }
  cool = $derived(this.#remain <= 0);

  constructor() {
    $effect(() => {
      if (!this.#active) return;
      const id = setInterval(() => {
        this.#remain -= 1;
        if (this.#remain <= 0) this.#active = false;
      }, 1000);
      return () => clearInterval(id);
    });
  }

  start(seconds: number) {
    this.#remain = seconds;
    this.#active = true;
  }
}
