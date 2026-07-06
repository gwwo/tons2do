// At most ONE checklist may have selected checks at a time, and a check
// selection never coexists with a row selection (project rows / placement
// entries) — so Delete/Backspace always has exactly one selection to act on.
//
// This module only tracks who currently owns the check selection; the
// selection state itself stays local to the owning CheckList (it registers a
// callback that clears it). The exclusivity rules are enforced in the state
// layer:
//   - CheckList claims here when its selection becomes non-empty, and pairs
//     the claim with useClearRowSelections (mutate-local).
//   - The row-selection mutators (useSetRowSelected / useSelectRow /
//     useSetPlacementSelected) call clearCheckSelection when they set a
//     non-empty selection.

export type CheckSelectionOwner = {
  /** Clears the owner's local selection state. */
  clear: () => void;
};

let current: CheckSelectionOwner | null = null;

/** Make `owner` the sole check-selection holder, clearing any previous one. */
export const claimCheckSelection = (owner: CheckSelectionOwner) => {
  if (current !== owner) current?.clear();
  current = owner;
};

/** Drop ownership if `owner` still holds it (its selection emptied or it unmounted). */
export const releaseCheckSelection = (owner: CheckSelectionOwner) => {
  if (current === owner) current = null;
};

/** Clear whichever checklist currently has selected checks, if any. */
export const clearCheckSelection = () => {
  current?.clear();
  current = null;
};
