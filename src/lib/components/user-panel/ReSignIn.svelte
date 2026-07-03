<script lang="ts">
  import {
    FormState,
    runOAuth,
    OAUTH_PROVIDERS,
    PROVIDER_LABEL,
    type OAuthProvider,
  } from "./utils.svelte";
  import { api, type Me, type Banner } from "./types";
  import PasswordInput from "./PasswordInput.svelte";
  import Divider from "./Divider.svelte";
  import SubmitButton from "./SubmitButton.svelte";

  type Props = {
    me: Me;
    form: FormState;
    banner: Banner;
    loadMe: (opts?: { newUser?: boolean }) => Promise<boolean>;
    onResolved: () => void;
  };
  let { me, form, banner = $bindable(), loadMe, onResolved }: Props = $props();

  let password = $state("");

  function flash(kind: "info" | "error", text: string) {
    banner = { kind, text };
  }

  const hasPasswordCred = $derived(me.credentials.some((c) => c.providerId === "password"));
  const oauthProviders = $derived(
    OAUTH_PROVIDERS.filter((p) => me.credentials.some((c) => c.providerId === p)),
  );

  async function doPassword(e: SubmitEvent) {
    e.preventDefault();
    const r = await form.wrap(() => api("re-sign-in", { password, expectedUserId: me.user?.id }));
    if (!r.ok) return flash("error", r.data?.message ?? "Failed");
    password = "";
    await loadMe();
    onResolved();
  }

  async function doOAuth(provider: OAuthProvider) {
    const uid = me.user?.id;
    if (!uid) return;
    const r = await runOAuth(provider, "re-sign-in", uid);
    if (r.kind === "cancelled") return;
    if (r.kind === "error") return flash("error", r.message);
    await loadMe();
    onResolved();
  }
</script>

<div class="space-y-3">
  {#if hasPasswordCred}
    <form onsubmit={doPassword} class="space-y-2">
      <p class="text-xs break-all text-neutral-500">{me.user?.email}</p>
      <PasswordInput required placeholder="Password" bind:value={password} />
      <SubmitButton busy={form.busy}>Re-sign in with password</SubmitButton>
    </form>
  {/if}

  {#if hasPasswordCred && oauthProviders.length > 0}
    <Divider label="or" />
  {/if}

  {#each oauthProviders as provider (provider)}
    <button
      type="button"
      class="w-full rounded-md border border-neutral-300 py-2 text-sm disabled:opacity-50"
      disabled={form.busy}
      onclick={() => doOAuth(provider)}
    >
      Continue with {PROVIDER_LABEL[provider]}
    </button>
  {/each}
</div>
