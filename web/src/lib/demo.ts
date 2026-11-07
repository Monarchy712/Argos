/**
 * The contracts Argos deployed to demonstrate itself.
 *
 * Kept in its own module, with no Vite-only imports, so the identity test is a plain unit under
 * `node --test` — the thing worth testing here is that a contract is matched on (network,
 * normalised address) and never on its name.
 *
 * These are real contracts on Sepolia with real baselines on Arkiv. The Transaction Guard
 * demonstration and the A→B→A upgrade walkthrough both need them, so neither the contracts nor
 * their Arkiv entities are ever deleted. They are the contracts this deployment's operator owns
 * and upgrades, so they are listed under **Yours** in My Contracts (with a Demo badge) rather
 * than in the Argos network list of registry contracts.
 */

/** The Sepolia demo proxy upgraded A→B→A in the walkthrough (contracts/deployments/11155111.json). */
export const DEMO_PROXY = {
  chainId: 11155111,
  address: "0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5",
  label: "Argos demo proxy",
} as const;

/**
 * A second Sepolia proxy whose own (non-upgradeable) code reports its implementation, plus
 * ArgosGuard, which checks that implementation and makes the call in one transaction
 * (contracts/src/ArgosGuardableProxy.sol, ArgosGuard.sol;
 * contracts/deployments/11155111-guard.json). No registry contract has this getter.
 */
export const GUARD_DEMO = {
  chainId: 11155111,
  proxy: "0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669",
  guard: "0xBf9cAA1F914b76c87143183B9E82Ed574179E281",
  label: "Argos guard demo proxy",
} as const;

export interface DemoContract {
  chainId: number;
  address: string;
  label: string;
  /** Shown next to the contract, so a reader knows why Argos deployed it. */
  why: string;
}

export const DEMO_CONTRACTS: readonly DemoContract[] = [
  {
    chainId: DEMO_PROXY.chainId,
    address: DEMO_PROXY.address,
    label: DEMO_PROXY.label,
    why: "Upgraded A→B→A to show change detection end to end.",
  },
  {
    chainId: GUARD_DEMO.chainId,
    address: GUARD_DEMO.proxy,
    label: GUARD_DEMO.label,
    why: "The only proxy exposing the getter ArgosGuard needs, for the Transaction Guard demonstration.",
  },
  {
    chainId: 11155111,
    address: "0x319480a00314B03453d1f43b96eCc9F1C4f6EF1d",
    label: "Argos test proxy",
    why: "Deployed for the watcher's end-to-end run (contracts/deployments/11155111-e2e.json); upgrade it to see a change detected.",
  },
];

const DEMO_IDS = new Set(DEMO_CONTRACTS.map((d) => `${d.chainId}:${d.address.toLowerCase()}`));

/**
 * True for a contract Argos deployed to demonstrate itself.
 *
 * Network **and** normalised address, never the label: a real user could legitimately call a
 * contract of theirs "Argos demo proxy", and the same address on another network is a different
 * contract. This is the only test anything should use.
 */
export const isDemoContract = (chainId: number, address: string): boolean =>
  DEMO_IDS.has(`${chainId}:${address.toLowerCase()}`);

/** The demo registry entry for a contract, for the note shown beside it. */
export const demoContractInfo = (chainId: number, address: string): DemoContract | null =>
  DEMO_CONTRACTS.find((d) => d.chainId === chainId && d.address.toLowerCase() === address.toLowerCase()) ?? null;
