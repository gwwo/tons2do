// The signed-in identity the whole client operates under — the one source of
// truth for "who is the app acting as right now", shared by the page, the
// mutators, and the sync engine.

export const session = $state<{
  // The account whose data the app operates under; null = guest/demo mode.
  // Flips at the START of an auth change so sync requests immediately run as
  // the new account.
  userId: string | null;
  // True while an auth change is being applied: appState still reflects the
  // previous account, so persistence effects (localStorage / cookie) must hold
  // off until the switch settles.
  switching: boolean;
}>({ userId: null, switching: false });

export const signedIn = (): boolean => session.userId != null;
