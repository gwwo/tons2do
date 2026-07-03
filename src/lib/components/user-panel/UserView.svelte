<script lang="ts">
  import {
    FormState,
    runOAuth,
    OAUTH_PROVIDERS,
    PROVIDER_LABEL,
    type OAuthProvider,
  } from "./utils.svelte";
  import { api, type Me, type Banner, type OtpOriginator, type SessionStatus } from "./types";
  import { revealRow, type RowHandle } from "./reveal";
  import {
    EXPAND_DURATION as expandDuration,
    EXPANDED_SPACING as expandedSpacing,
  } from "$lib/components/list-kit/reveal";
  import ReSignIn from "./ReSignIn.svelte";
  import OtpProceed from "./OtpProceed.svelte";
  import PasswordInput from "./PasswordInput.svelte";
  import ActionRow from "./ActionRow.svelte";
  import OAuthCredSection from "./OAuthCredSection.svelte";
  import SectionHeader from "./SectionHeader.svelte";
  import SubmitButton from "./SubmitButton.svelte";
  import CredLabel from "./CredLabel.svelte";
  import Divider from "./Divider.svelte";
  import PanelBanner from "./PanelBanner.svelte";
  import { Input } from "$lib";

  type Props = {
    me: Me;
    form: FormState;
    banner: Banner;
    otp: OtpOriginator | null;
    loadMe: (opts?: { newUser?: boolean }) => Promise<boolean>;
    setOtp: (otp: OtpOriginator | null) => void;
    setMe: (me: Me) => void;
    sessionStatus: SessionStatus;
    markSessionInvalid: () => void;
    anyExpanded?: boolean;
    scrollContainer?: HTMLDivElement | null;
  };
  let {
    me,
    form,
    banner = $bindable(),
    otp,
    loadMe,
    setOtp,
    setMe,
    sessionStatus,
    markSessionInvalid,
    anyExpanded = $bindable(false),
    scrollContainer = null,
  }: Props = $props();

  // ─── Expandable action rows ────────────────────────────────────────────────
  // At most one action row is open at a time; `action` names it.

  type Action =
    | null
    | "change-password-cred"
    | "add-password-cred"
    | "delete-password-cred"
    | "delete-google-cred"
    | "delete-github-cred"
    | "delete-user"
    | "disable-reset"
    | "enable-reset"
    | "link-google"
    | "link-github"
    | "sign-out";
  type OpenAction = Exclude<Action, null>;
  let action: Action = $state(null);

  const LINK_KEY = { google: "link-google", github: "link-github" } as const;
  const DELETE_KEY = { google: "delete-google-cred", github: "delete-github-cred" } as const;

  // Inputs shared by the expanded forms — safe because only one row is open.
  let curPassword = $state("");
  let newPassword = $state("");
  let newEmail = $state("");
  let confirmPassword = $state("");
  // Which guarded action is running its freshness pre-check (OAuth-only path).
  let checking: Action = $state(null);
  // Read-only OAuth info rows (credential is the only way in) expand too, but
  // don't participate in `action`.
  const infoExpanded = $state({ google: false, github: false });

  let reSignInOpen = $state(false);
  let reSignInBlockedByStale = $state(false);

  function flash(kind: "info" | "error", text: string) {
    banner = { kind, text };
  }

  function clearInputs() {
    curPassword = "";
    newPassword = "";
    newEmail = "";
    confirmPassword = "";
  }

  function closeAction() {
    action = null;
    clearInputs();
  }

  function openAction(a: Action) {
    action = a;
    clearInputs();
    if (a === "change-password-cred") newEmail = me.user?.email ?? "";
    banner = null;
    if (a !== null) rowToReveal = a;
  }

  const toggleAction = (a: OpenAction) => () => openAction(action === a ? null : a);

  // ─── Derived account facts ─────────────────────────────────────────────────

  const hasPasswordCred = $derived(
    me.user ? me.credentials.some((c) => c.providerId === "password") : false,
  );
  const credentialCount = $derived(me.user ? me.credentials.length : 0);
  // Sign-in methods that could re-enable reset if the password is forgotten.
  const reEnableProviderLabel = $derived(
    OAUTH_PROVIDERS.filter((p) => me.credentials.some((c) => c.providerId === p))
      .map((p) => PROVIDER_LABEL[p])
      .join(" or "),
  );

  const emailChanged = $derived(
    newEmail.trim().toLowerCase() !== (me.user?.email ?? "").toLowerCase(),
  );
  const credentialChange = $derived(emailChanged || newPassword.length > 0);

  // The reset toggle is one row that flips between enable and disable.
  const resetAction = $derived<OpenAction>(
    me.user?.resetDisabled ? "enable-reset" : "disable-reset",
  );
  const resetOpen = $derived(action === "enable-reset" || action === "disable-reset");

  // ─── Session status ────────────────────────────────────────────────────────

  const sessionBlocked = $derived(sessionStatus === "invalid" || sessionStatus === "overwritten");
  // Re-sign-in: always shown for invalid/overwritten sessions; shown for stale
  // only after an action was blocked by staleness.
  const showReSignIn = $derived(
    reSignInOpen || sessionBlocked || (sessionStatus === "stale" && reSignInBlockedByStale),
  );

  // A blocked/stale session disables every row except the one already open, so
  // the user can still collapse it.
  const disabledByBlocked = (a: OpenAction) => sessionBlocked && action !== a;
  const disabledByStale = (a: OpenAction) =>
    sessionStatus === "stale" && reSignInBlockedByStale && action !== a;

  function onReSignInResolved() {
    reSignInOpen = false;
    reSignInBlockedByStale = false;
    flash("info", action !== null ? "Session refreshed — please retry." : "Session refreshed.");
  }

  $effect(() => {
    if (sessionStatus === "overwritten") {
      banner = { kind: "error", text: "Account overwritten — please re-sign in." };
    } else if (sessionStatus === "invalid") {
      banner = { kind: "error", text: "Session ended — please re-sign in." };
    } else if (sessionStatus === "stale" && reSignInBlockedByStale) {
      banner = { kind: "error", text: "Session stale — please re-sign in." };
    }
  });

  $effect(() => {
    anyExpanded =
      action !== null || reSignInOpen || otp !== null || infoExpanded.google || infoExpanded.github;
  });

  // ─── Server ops ────────────────────────────────────────────────────────────

  function meApi(op: string, body?: Record<string, unknown>) {
    return api(op, { ...body, expectedUserId: me.user?.id });
  }

  // Runs a signed-in op with the standard failure handling: 401 → session
  // invalid, 409 → overwritten (re-pull surfaces it), optionally 403
  // stale-session → re-sign-in row. Returns the response data, or null when
  // the request failed — the handler/flash has already surfaced it, so
  // callers just bail.
  async function guarded(
    op: string,
    body?: Record<string, unknown>,
    opts?: { stale?: boolean },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any | null> {
    const r = await form.wrap(() => meApi(op, body));
    if (r.ok) return r.data;
    if (r.status === 401) {
      markSessionInvalid();
    } else if (r.status === 409) {
      await loadMe();
    } else if (opts?.stale && r.status === 403 && r.data?.code === "stale-session") {
      closeAction();
      reSignInBlockedByStale = true;
      await loadMe();
    } else {
      flash("error", r.data?.message ?? "Failed");
    }
    return null;
  }

  // Standard success epilogue for form actions: close the row, drop typed
  // inputs, re-pull `me`, confirm.
  async function finishAction(msg: string) {
    closeAction();
    await loadMe();
    flash("info", msg);
  }

  async function setName(name: string) {
    if (!(await guarded("set-name", { name }))) return;
    await loadMe();
    flash("info", "Account Label updated.");
  }

  async function doChangePasswordCred(e: SubmitEvent) {
    e.preventDefault();
    const d = await guarded("change-password-cred-start", {
      currentPassword: curPassword,
      newEmail,
      newPassword: emailChanged ? undefined : newPassword,
    });
    if (!d) return;
    if (d.shape !== "otp") {
      await finishAction("Password changed; other sessions revoked.");
      return;
    }
    setOtp({
      actorToken: d.actorToken,
      otp: d.otp,
      email: d.email,
      type: "change-email",
      payload: newPassword ? { password: newPassword } : undefined,
      headline: newPassword
        ? `Verifying ${d.email} as your new correspondent email; password will also be updated.`
        : `Verifying ${d.email} as your new correspondent email.`,
    });
    closeAction();
    await loadMe();
  }

  async function doAddPasswordCredStart(e: SubmitEvent) {
    e.preventDefault();
    const d = await guarded("add-password-cred-start", { email: newEmail });
    if (!d || d.shape !== "otp") return;
    setOtp({
      actorToken: d.actorToken,
      otp: d.otp,
      email: d.email,
      type: "add-password-cred",
      payload: { password: newPassword },
      headline: `Linking ${d.email} as your password credential.`,
    });
    closeAction();
  }

  async function doDeletePasswordCred(e: SubmitEvent) {
    e.preventDefault();
    if (!(await guarded("delete-password-cred", { password: confirmPassword }))) return;
    await finishAction("Password credential removed.");
  }

  async function doDeleteOAuthCred(e: SubmitEvent, provider: OAuthProvider) {
    e.preventDefault();
    const d = await guarded(
      `delete-${provider}-cred`,
      hasPasswordCred ? { password: confirmPassword } : {},
      { stale: true },
    );
    if (!d) return;
    await finishAction(`${PROVIDER_LABEL[provider]} credential removed.`);
  }

  async function doDisableReset(e: SubmitEvent) {
    e.preventDefault();
    if (!(await guarded("disable-reset", { password: confirmPassword }))) return;
    await finishAction("Reset-password-via-email disabled.");
  }

  async function doEnableReset() {
    if (!(await guarded("enable-reset", undefined, { stale: true }))) return;
    await finishAction("Reset-password-via-email re-enabled.");
  }

  async function doDeleteUser(e: SubmitEvent) {
    e.preventDefault();
    const d = await guarded("delete-user", hasPasswordCred ? { password: confirmPassword } : {}, {
      stale: true,
    });
    if (!d) return;
    closeAction();
    setMe({ user: null, credentials: [], sessionFresh: false });
    setOtp(null);
    flash("info", "Account deleted.");
  }

  async function signOut() {
    await form.wrap(() => api("sign-out", { expectedUserId: me.user?.id }));
    setMe({ user: null, credentials: [], sessionFresh: false });
    setOtp(null);
    flash("info", "Signed out.");
  }

  // Freshness-gated openers (delete credential / delete user for users without
  // a password credential): re-pull `me` first so a stale session surfaces the
  // re-sign-in row instead of a doomed confirm form.
  async function startGuardedAction(
    a: "delete-google-cred" | "delete-github-cred" | "delete-user",
  ) {
    if (hasPasswordCred) {
      openAction(a);
      return;
    }
    checking = a;
    try {
      await loadMe();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : "Failed to check session");
      return;
    } finally {
      checking = null;
    }
    if (sessionStatus === "fresh") {
      openAction(a);
    } else if (sessionStatus === "stale") {
      reSignInBlockedByStale = true;
    }
  }

  async function linkProvider(provider: OAuthProvider) {
    if (!me.user?.id) return;
    const r = await runOAuth(provider, "link");
    if (r.kind === "cancelled") return;
    if (r.kind === "error") return flash("error", r.message);
    await loadMe();
    if (sessionBlocked) {
      return flash("error", "Session changed during linking — re-sign in.");
    }
    flash("info", `${PROVIDER_LABEL[provider]} linked.`);
  }

  function onLinkClick(provider: OAuthProvider) {
    const key = LINK_KEY[provider];
    if (action === key) {
      openAction(null);
      return;
    }
    openAction(key);
    void linkProvider(provider).finally(() => {
      if (action === key) action = null;
    });
  }

  function onDeleteClick(provider: OAuthProvider) {
    const key = DELETE_KEY[provider];
    if (action === key) openAction(null);
    else startGuardedAction(key);
  }

  // ─── Row layout: margins ───────────────────────────────────────────────────
  // Margins follow TodoList's getMarginTop rules:
  //   head → any:        20px base, 30 if cur expanded
  //   section → action:  10px base, 30 if cur expanded
  //   action → action:    0px base, 30 if either expanded
  //   any → section:     30px always

  type RowKind = "section" | "action";
  type RowId =
    | "reSignIn"
    | "emailPasswordSection"
    | "otp"
    | "resetToggle"
    | "changePasswordCred"
    | "deletePasswordCred"
    | "addPasswordCred"
    | "googleSection"
    | "googleAction"
    | "githubSection"
    | "githubAction"
    | "accountSection"
    | "deleteUser"
    | "signOut";

  function getMarginTop(
    pre: { kind: RowKind; expanded: boolean } | null,
    cur: { kind: RowKind; expanded: boolean },
  ): number {
    const base = pre === null ? 20 : cur.kind === "section" ? 30 : pre.kind === "section" ? 10 : 0;
    const anyExpanded = (pre !== null && pre.expanded) || cur.expanded;
    return anyExpanded ? Math.max(30, base) : base;
  }

  const visibleRows = $derived.by(() => {
    type Entry = { id: RowId; kind: RowKind; expanded: boolean };
    const list: Entry[] = [];
    const add = (id: RowId, kind: RowKind, expanded = false) => list.push({ id, kind, expanded });

    if (showReSignIn) add("reSignIn", "action", reSignInOpen);

    add("emailPasswordSection", "section");
    if (otp) {
      add("otp", "action");
    } else if (hasPasswordCred) {
      add("resetToggle", "action", resetOpen);
      add("changePasswordCred", "action", action === "change-password-cred");
      if (credentialCount > 1)
        add("deletePasswordCred", "action", action === "delete-password-cred");
    } else {
      add("addPasswordCred", "action", action === "add-password-cred");
    }

    for (const p of OAUTH_PROVIDERS) {
      add(`${p}Section`, "section");
      add(
        `${p}Action`,
        "action",
        action === DELETE_KEY[p] || action === LINK_KEY[p] || infoExpanded[p],
      );
    }

    add("accountSection", "section");
    add("deleteUser", "action", action === "delete-user");
    add("signOut", "action", action === "sign-out");

    return list;
  });

  const margins = $derived.by(() => {
    const result = {} as Record<RowId, number>;
    visibleRows.forEach((cur, i) => {
      result[cur.id] = getMarginTop(i === 0 ? null : visibleRows[i - 1], cur);
    });
    return result;
  });

  // ─── Reveal scroll ─────────────────────────────────────────────────────────
  // When a row opens, scroll it (and its final expanded height) into view.

  // Spacing/timing shared with the todo lists (list-kit) so the user panel
  // reveals rows the same way.

  type RowKey = OpenAction | "reSignIn";
  let rowToReveal: RowKey | null = $state(null);
  let rowRefs: Partial<Record<RowKey, RowHandle | null>> = $state({});
  let oauthSections: Partial<Record<OAuthProvider, OAuthCredSection>> = $state({});

  // OAuth rows live inside their OAuthCredSection, which forwards the handle.
  function getRowRef(key: RowKey): RowHandle | null | undefined {
    const p = OAUTH_PROVIDERS.find((p) => key === LINK_KEY[p] || key === DELETE_KEY[p]);
    return p ? oauthSections[p] : rowRefs[key];
  }

  $effect(() => {
    const container = scrollContainer;
    const key = rowToReveal;
    if (!container || key == null) return;
    // Defer a tick so the expanded content has mounted and can be measured.
    setTimeout(() => {
      const row = getRowRef(key);
      if (!row) {
        rowToReveal = null;
        return;
      }
      revealRow(
        container,
        row,
        { spacing: expandedSpacing, duration: expandDuration },
        () => (rowToReveal = null),
      );
    });
  });
</script>

<!-- Head: editable name + status banner -->
<div class="mx-4 pt-7.5">
  <Input
    class="min-h-lh text-2xl font-semibold wrap-break-word"
    bind:value={() => me.user?.name ?? "", (v) => (v !== (me.user?.name ?? "") ? setName(v) : null)}
    updateOnBlur
    placeholder="Account Label"
    onkeydown={(e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      }
    }}
  ></Input>
</div>

<PanelBanner {banner} placeholder="Manage your account here." />

{#if showReSignIn}
  <div style:margin-top="{margins.reSignIn}px" class="trans-margin">
    <ActionRow
      bind:this={rowRefs["reSignIn"]}
      expanded={reSignInOpen}
      onclick={() => {
        reSignInOpen = !reSignInOpen;
        if (reSignInOpen) rowToReveal = "reSignIn";
      }}
    >
      {#snippet label()}Re-sign in{/snippet}
      {#snippet expandedContent()}
        <ReSignIn {me} {form} bind:banner {loadMe} onResolved={onReSignInResolved} />
      {/snippet}
    </ActionRow>
  </div>
{/if}

<!-- Email / Password -->
<div style:margin-top="{margins.emailPasswordSection}px" class="trans-margin">
  <SectionHeader label="Email / Password" />
</div>
{#if otp}
  <div style:margin-top="{margins.otp}px" class="trans-margin">
    <div class="rounded-md bg-white px-2 py-2 shadow-lg">
      <OtpProceed {otp} {form} bind:banner {loadMe} {setOtp} />
    </div>
  </div>
{:else if hasPasswordCred}
  <div style:margin-top="{margins.resetToggle}px" class="trans-margin">
    <ActionRow
      bind:this={rowRefs[resetAction]}
      expanded={resetOpen}
      disabled={disabledByBlocked(resetAction) ||
        (resetAction === "enable-reset" && disabledByStale(resetAction))}
      onclick={() => openAction(resetOpen ? null : resetAction)}
    >
      {#snippet label()}
        <CredLabel
          icon="icon-[mdi--email] scale-110 text-amber-400"
          text={me.user?.email ?? ""}
          suffix="{me.user?.resetDisabled ? 'cannot' : 'can'} reset password"
        />
      {/snippet}
      {#snippet expandedContent()}
        {#if me.user?.resetDisabled}
          <div class="space-y-2">
            <p class="text-xs text-neutral-600">Re-enable email-based password reset.</p>
            <SubmitButton type="button" busy={form.busy} onclick={doEnableReset}>
              Enable
            </SubmitButton>
          </div>
        {:else}
          <form onsubmit={doDisableReset} class="space-y-2">
            <p class="text-xs text-neutral-600">
              Disable email-based password reset. You'll no longer be able to reset a forgotten
              password by email.
            </p>
            {#if reEnableProviderLabel}
              <p class="text-xs text-amber-800">
                If you forget your password, you'll need to sign in with {reEnableProviderLabel} to re-enable
                reset.
              </p>
            {:else}
              <p class="text-xs text-amber-800">
                <strong>Warning:</strong> you have no other way to sign in. If you forget your password
                after disabling this, you'll be locked out permanently.
              </p>
            {/if}
            <PasswordInput
              required
              placeholder="Current password"
              bind:value={confirmPassword}
              class="w-full rounded-md border border-amber-300 bg-white py-2 pr-14 pl-3 text-sm"
            />
            <SubmitButton variant="warning" busy={form.busy}>Disable</SubmitButton>
          </form>
        {/if}
      {/snippet}
    </ActionRow>
  </div>

  <div style:margin-top="{margins.changePasswordCred}px" class="trans-margin">
    <ActionRow
      bind:this={rowRefs["change-password-cred"]}
      expanded={action === "change-password-cred"}
      disabled={disabledByBlocked("change-password-cred")}
      onclick={toggleAction("change-password-cred")}
    >
      {#snippet label()}Change email or password{/snippet}
      {#snippet expandedContent()}
        <form onsubmit={doChangePasswordCred} class="space-y-2">
          <PasswordInput
            required
            placeholder="Confirm current password"
            bind:value={curPassword}
            class={[
              "w-full rounded-md border border-neutral-300 py-2 pr-14 pl-3 text-sm",
              curPassword ? "" : "bg-amber-50",
            ]}
          />
          <Divider label="new credential" class="pt-1" />
          <input
            type="email"
            required
            placeholder="Email"
            bind:value={newEmail}
            class="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
          <PasswordInput
            minlength={8}
            placeholder="New password (leave empty to keep)"
            bind:value={newPassword}
          />
          <SubmitButton busy={form.busy} disabled={!curPassword || !credentialChange}>
            {emailChanged ? "Continue to verify" : "Continue"}
          </SubmitButton>
        </form>
      {/snippet}
    </ActionRow>
  </div>

  {#if credentialCount > 1}
    <div style:margin-top="{margins.deletePasswordCred}px" class="trans-margin">
      <ActionRow
        bind:this={rowRefs["delete-password-cred"]}
        expanded={action === "delete-password-cred"}
        disabled={disabledByBlocked("delete-password-cred")}
        onclick={toggleAction("delete-password-cred")}
      >
        {#snippet label()}Remove this credential{/snippet}
        {#snippet expandedContent()}
          <form onsubmit={doDeletePasswordCred} class="space-y-2">
            <PasswordInput required placeholder="Current password" bind:value={confirmPassword} />
            <SubmitButton busy={form.busy}>Remove</SubmitButton>
          </form>
        {/snippet}
      </ActionRow>
    </div>
  {/if}
{:else}
  <div style:margin-top="{margins.addPasswordCred}px" class="trans-margin">
    <ActionRow
      bind:this={rowRefs["add-password-cred"]}
      expanded={action === "add-password-cred"}
      disabled={disabledByBlocked("add-password-cred")}
      onclick={toggleAction("add-password-cred")}
    >
      {#snippet label()}Add credential{/snippet}
      {#snippet expandedContent()}
        <form onsubmit={doAddPasswordCredStart} class="space-y-2">
          <input
            type="email"
            required
            placeholder="Email"
            bind:value={newEmail}
            class="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
          <PasswordInput
            required
            minlength={8}
            placeholder="Password (min 8)"
            bind:value={newPassword}
          />
          <SubmitButton busy={form.busy}>Send code</SubmitButton>
        </form>
      {/snippet}
    </ActionRow>
  </div>
{/if}

<!-- OAuth providers -->
{#each OAUTH_PROVIDERS as provider (provider)}
  <div style:margin-top="{margins[`${provider}Section`]}px" class="trans-margin">
    <SectionHeader label="{PROVIDER_LABEL[provider]} OAuth" />
  </div>
  <div style:margin-top="{margins[`${provider}Action`]}px" class="trans-margin">
    <OAuthCredSection
      bind:this={oauthSections[provider]}
      {provider}
      {me}
      {form}
      {hasPasswordCred}
      expandedLink={action === LINK_KEY[provider]}
      expandedDelete={action === DELETE_KEY[provider]}
      bind:infoExpanded={infoExpanded[provider]}
      checking={checking === DELETE_KEY[provider]}
      disabledLink={disabledByBlocked(LINK_KEY[provider])}
      disabledDelete={disabledByBlocked(DELETE_KEY[provider])}
      bind:confirmPassword
      onLinkClick={() => onLinkClick(provider)}
      onDeleteClick={() => onDeleteClick(provider)}
      onSubmitDelete={(e) => doDeleteOAuthCred(e, provider)}
    />
  </div>
{/each}

<!-- The Exit -->
<div style:margin-top="{margins.accountSection}px" class="trans-margin">
  <SectionHeader label="The Exit" />
</div>
<div style:margin-top="{margins.deleteUser}px" class="trans-margin">
  <ActionRow
    bind:this={rowRefs["delete-user"]}
    expanded={action === "delete-user"}
    variant="danger"
    disabled={checking === "delete-user" || disabledByBlocked("delete-user")}
    onclick={() => {
      if (action === "delete-user") openAction(null);
      else startGuardedAction("delete-user");
    }}
  >
    {#snippet label()}{checking === "delete-user" ? "Checking…" : "Delete account"}{/snippet}
    {#snippet expandedContent()}
      <form onsubmit={doDeleteUser} class="space-y-2">
        {#if hasPasswordCred}
          <p class="text-xs text-red-800">Re-enter your password to delete.</p>
          <PasswordInput
            required
            placeholder="Current password"
            bind:value={confirmPassword}
            class="w-full rounded-md border border-red-300 bg-white py-2 pr-14 pl-3 text-sm"
          />
        {:else}
          <p class="text-xs text-red-800">
            Your session is fresh. Confirm to permanently delete this account.
          </p>
        {/if}
        <SubmitButton variant="danger" busy={form.busy}>Delete</SubmitButton>
      </form>
    {/snippet}
  </ActionRow>
</div>

<div style:margin-top="{margins.signOut}px" class="trans-margin">
  <ActionRow
    bind:this={rowRefs["sign-out"]}
    expanded={action === "sign-out"}
    onclick={toggleAction("sign-out")}
  >
    {#snippet label()}Sign out{/snippet}
    {#snippet expandedContent()}
      <div class="space-y-2">
        <p class="text-xs text-neutral-600">Confirm to end this session.</p>
        <SubmitButton type="button" busy={form.busy} onclick={signOut}>
          Confirm sign out
        </SubmitButton>
      </div>
    {/snippet}
  </ActionRow>
</div>
<div style:height="30px"></div>
