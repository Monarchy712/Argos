import type { Address } from "viem";

/**
 * The only wallets whose Arkiv entities Argos clients trust. Anyone can write an entity
 * carrying a `dg_*` schema tag, so every read filters on `$creator` against these.
 * Public addresses only; keys live in the operator's .env. Listed in README and ARCHITECTURE §11.
 */
export const TRUSTED_CREATORS = {
  /** Importer records (dg_descriptor, dg_deployment) and baselines (dg_baseline). */
  writer: "0x623EdFf351EB13aCCFc56cBf541eE4D45BDADCf4" as Address,
  /** Watcher records (dg_current_state, dg_latest_change). */
  watcher: "0x8a883182b488cE04f08D348C64d9AC8EecACF2Bf" as Address,
} as const;
