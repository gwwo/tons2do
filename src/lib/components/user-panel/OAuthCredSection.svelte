<script lang="ts">
  // One OAuth provider's row in the account panel — exactly one of three
  // states: a "Link" row (no credential), an unlink form (credential +
  // another way in), or a read-only info row (credential is the only way in).
  import ActionRow from "./ActionRow.svelte";
  import PasswordInput from "./PasswordInput.svelte";
  import CredLabel from "./CredLabel.svelte";
  import SubmitButton from "./SubmitButton.svelte";
  import { FormState, PROVIDER_LABEL, PROVIDER_ICON, type OAuthProvider } from "./utils.svelte";
  import type { Me } from "./types";

  type Props = {
    provider: OAuthProvider;
    me: Me;
    form: FormState;
    hasPasswordCred: boolean;
    expandedLink: boolean;
    expandedDelete: boolean;
    infoExpanded: boolean;
    checking: boolean;
    disabledLink: boolean;
    disabledDelete: boolean;
    confirmPassword: string;
    onLinkClick: () => void;
    onDeleteClick: () => void;
    onSubmitDelete: (e: SubmitEvent) => void;
  };
  let {
    provider,
    me,
    form,
    hasPasswordCred,
    expandedLink,
    expandedDelete,
    infoExpanded = $bindable(false),
    checking,
    disabledLink,
    disabledDelete,
    confirmPassword = $bindable(""),
    onLinkClick,
    onDeleteClick,
    onSubmitDelete,
  }: Props = $props();

  const providerLabel = $derived(PROVIDER_LABEL[provider]);
  const cred = $derived(me.credentials.find((c) => c.providerId === provider) ?? null);
  const credText = $derived(cred?.email ?? cred?.accountId ?? "");
  const remainingAfterUnlink = $derived(me.credentials.filter((c) => c.providerId !== provider));
  const lockoutRisk = $derived(
    me.user?.resetDisabled &&
      remainingAfterUnlink.length === 1 &&
      remainingAfterUnlink[0].providerId === "password",
  );

  // Forwarded so UserView's reveal-scroll effect can treat this section like a
  // bare ActionRow (only one of the branches is ever mounted).
  let row: ActionRow | undefined = $state();
  export const getEl = () => row?.getEl();
  export const getEndHeight = () => row?.getEndHeight() ?? 0;
</script>

{#if !cred}
  <ActionRow bind:this={row} expanded={expandedLink} disabled={disabledLink} onclick={onLinkClick}>
    {#snippet label()}Link {providerLabel}{/snippet}
    {#snippet expandedContent()}
      <p class="text-xs text-neutral-600">Continue at the popup.</p>
    {/snippet}
  </ActionRow>
{:else if me.credentials.length > 1}
  <ActionRow
    bind:this={row}
    expanded={expandedDelete}
    disabled={checking || disabledDelete}
    onclick={onDeleteClick}
  >
    {#snippet label()}
      {#if checking}Checking…{:else}
        <CredLabel icon={PROVIDER_ICON[provider]} text={credText} suffix="unlink" />
      {/if}
    {/snippet}
    {#snippet expandedContent()}
      <form onsubmit={onSubmitDelete} class="space-y-2">
        {#if lockoutRisk}
          <p class="text-xs text-amber-800">
            <strong>Warning:</strong> after unlinking, your password credential will be your only way
            in (reset disabled; forgetting the password will lock you out).
          </p>
        {/if}
        {#if hasPasswordCred}
          <p class={["text-xs", lockoutRisk ? "text-amber-800" : "text-neutral-600"]}>
            Re-enter your password to unlink.
          </p>
          <PasswordInput
            required
            placeholder="Current password"
            bind:value={confirmPassword}
            class={[
              "w-full rounded-md border bg-white py-2 pr-14 pl-3 text-sm",
              lockoutRisk ? "border-amber-300" : "border-neutral-300",
            ]}
          />
        {:else}
          <p class="text-xs text-neutral-600">
            Your session is fresh. Confirm to unlink {providerLabel}.
          </p>
        {/if}
        <SubmitButton variant={lockoutRisk ? "warning" : "default"} busy={form.busy}>
          {lockoutRisk ? "Unlink anyway" : "Unlink"}
        </SubmitButton>
      </form>
    {/snippet}
  </ActionRow>
{:else}
  <ActionRow bind:this={row} expanded={infoExpanded} onclick={() => (infoExpanded = !infoExpanded)}>
    {#snippet label()}
      <CredLabel icon={PROVIDER_ICON[provider]} text={credText} />
    {/snippet}
    {#snippet expandedContent()}
      <p class="text-xs text-neutral-600">
        You have no other sign-in method. Add another credential to unlink {providerLabel}.
      </p>
    {/snippet}
  </ActionRow>
{/if}
