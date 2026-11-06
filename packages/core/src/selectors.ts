/**
 * Function selectors recovered from deployed runtime bytecode.
 *
 * When Argos detects that the code behind a proxy changed, the useful question is "what changed
 * about the functions the descriptor documents?". Answering it from verified source would mean
 * depending on a block explorer and would fail for unverified contracts (including our own Sepolia
 * demo implementations). Deployed bytecode is always available over plain `eth_getCode`, so we
 * read the selectors out of it instead.
 *
 * HOW, AND WHAT THIS IS NOT. Solidity dispatchers compare `calldataload(0) >> 224` against each
 * selector, which compiles to a `PUSH4 <selector>` followed closely by a comparison. We scan for
 * PUSH4 operands, skipping PUSH data so bytes inside other push payloads are never mistaken for
 * opcodes. That is a heuristic, not a decompiler:
 *   - it can over-report: a PUSH4 of a constant that happens not to be a selector is included;
 *   - it can under-report: assembly dispatchers, `fallback`-only contracts, very large jump-table
 *     dispatchers and proxies that delegate everything expose no selectors here.
 * So treat the result as "4-byte values the bytecode pushes", which is a superset of the external
 * ABI in practice. Every caller must present it that way — never as "the contract's ABI".
 */

/** A 4-byte selector, lowercase `0x` + 8 hex. */
export type Selector = `0x${string}`;

const PUSH1 = 0x60;
const PUSH32 = 0x7f;
const PUSH4 = 0x63;

/**
 * Every distinct PUSH4 operand in `runtimeBytecode`, in ascending order.
 * Returns an empty array for `0x`, for an odd-length string, or for anything that isn't hex.
 */
export function selectorsFromBytecode(runtimeBytecode: string): Selector[] {
  const hex = runtimeBytecode.startsWith("0x") ? runtimeBytecode.slice(2) : runtimeBytecode;
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return [];
  // Uint8Array rather than Buffer: the web app runs this on deployed bytecode in the browser, and
  // both callers must read selectors with exactly the same heuristic.
  const code = new Uint8Array(hex.length / 2);
  for (let i = 0; i < code.length; i++) code[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  const found = new Set<Selector>();
  const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  for (let i = 0; i < code.length; i++) {
    const op = code[i]!;
    if (op < PUSH1 || op > PUSH32) continue;
    const width = op - PUSH1 + 1;
    // Only a complete operand counts; a truncated tail at the end of the code is ignored.
    if (op === PUSH4 && i + 4 < code.length) {
      found.add(`0x${toHex(code.subarray(i + 1, i + 5))}` as Selector);
    }
    i += width; // skip the operand so its bytes are never read as opcodes
  }
  return [...found].sort();
}

/**
 * 4-byte values every Solidity contract pushes for its built-in revert types. They are error
 * selectors, not functions, so they show up in `selectorsFromBytecode` and mean nothing about the
 * call surface. Callers that present selectors to a human should drop these first.
 */
export const SOLIDITY_ERROR_SELECTORS: readonly Selector[] = ["0x08c379a0", "0x4e487b71"]; // Error(string), Panic(uint256)

/** `selectors` without the built-in Solidity error selectors. */
export function withoutErrorSelectors(selectors: readonly Selector[]): Selector[] {
  return selectors.filter((s) => !SOLIDITY_ERROR_SELECTORS.includes(s));
}

export interface SelectorDiff {
  /** In the new code, not in the old. */
  added: Selector[];
  /** In the old code, not in the new. */
  removed: Selector[];
  /** In both. */
  kept: Selector[];
}

/** Compare two sets of selectors. Inputs need not be sorted or unique. */
export function diffSelectors(before: readonly Selector[], after: readonly Selector[]): SelectorDiff {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: [...b].filter((s) => !a.has(s)).sort(),
    removed: [...a].filter((s) => !b.has(s)).sort(),
    kept: [...a].filter((s) => b.has(s)).sort(),
  };
}

/**
 * True when the two bytecodes expose the same 4-byte values. An upgrade like this is the
 * interesting one for clear signing: the descriptor still matches every selector it documents,
 * and nothing about the call surface looks different, but the code behind it is not the code that
 * was reviewed. "Same surface" is never "same behaviour".
 */
export function sameSurface(diff: SelectorDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0;
}
