<script lang="ts">
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import PasswordInput from "$lib/components/user-panel/PasswordInput.svelte";
  import HydratedSubmit from "$lib/components/user-panel/HydratedSubmit.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // Generic controller-token destination: `reset` plus the daily-cap escape
  // hatch for the sign-up-shape flows. The token is resolved server-side (see
  // +page.server.ts) so the form is server-rendered rather than appearing
  // after a fetch. Everything except `change-email` collects a password.
  const COPY = {
    reset: { heading: "Set a new password", cta: "Update password", done: "Password updated" },
    signup: {
      heading: "Set a password to complete sign-up",
      cta: "Sign up",
      done: "Account created",
    },
    "add-password-cred": {
      heading: "Set a password to link this email",
      cta: "Link email",
      done: "Email linked",
    },
    "change-email": { heading: "Confirm your new email", cta: "Confirm", done: "Email updated" },
  } as const;

  const ct = $derived(page.url.searchParams.get("ct") ?? "");
  let done = $state(false);
  let pw = $state("");
  let busy = $state(false);
  let error: string | null = $state(null);

  // The submit handler only attaches at hydration; a click before then would
  // trigger a native (handler-less) form submit. HydratedSubmit keeps the
  // button disabled until onMount (client-only, post-hydration) flips this.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || data.dest.status !== "loaded") return;
    busy = true;
    error = null;
    try {
      const r = await fetch("/auth/api/reset-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          controllerToken: ct,
          ...(data.dest.type === "change-email" ? {} : { newPassword: pw }),
        }),
      });
      const resp = await r.json();
      if (!r.ok) {
        error = resp?.message ?? "Could not complete this action";
        return;
      }
      done = true;
      setTimeout(() => goto(resolve("/")), 1000);
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-dvh items-center justify-center p-6">
  <div class="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
    {#if data.dest.status === "invalid"}
      <h1 class="mb-2 text-lg font-semibold">Link invalid or expired</h1>
      <p class="text-sm text-neutral-600">Request a new email.</p>
    {:else if done}
      <h1 class="mb-2 text-lg font-semibold">{COPY[data.dest.type].done}</h1>
      <p class="text-sm text-neutral-600">Redirecting…</p>
    {:else}
      {@const copy = COPY[data.dest.type]}
      <h1 class="mb-1 text-lg font-semibold">{copy.heading}</h1>
      <p class="mb-4 text-xs break-all text-neutral-500">{data.dest.email}</p>
      <form onsubmit={submit} class="space-y-3">
        {#if data.dest.needsSession}
          <p class="text-sm text-amber-800">
            This link belongs to a signed-in request — sign in as that account in this browser, then
            submit here.
          </p>
        {/if}
        {#if data.dest.type !== "change-email"}
          <!-- Native `autofocus` (forwarded via PasswordInput's rest props)
               works in the SSR'd HTML before hydration, so a mobile arrival
               from the email link gets the keyboard right away. a11y-safe
               here: the password field is this page's only purpose. -->
          <PasswordInput
            autofocus
            required
            minlength={8}
            placeholder="New password (min 8)"
            bind:value={pw}
          />
        {/if}
        {#if error}<p class="text-sm text-red-600">{error}</p>{/if}
        <HydratedSubmit {hydrated} {busy} label={copy.cta} />
      </form>
    {/if}
  </div>
</div>
