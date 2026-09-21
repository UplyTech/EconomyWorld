import { expect } from "vitest";
import {
  account,
  accountKey,
  createCurrency,
  createEarnRule,
  EconomyEngine,
  isBalanced,
  memberAccount,
  systemAccount,
  type Account,
  type Posting,
  type SystemAccount,
} from "../../src/index.js";

/**
 * The harness the property runs share.
 *
 * `invariants.test.ts` proves the engine conserves currency;
 * `invariants-financial.test.ts` proves each financial subsystem does too. They
 * take the generator and the world from here so that a failing seed means the
 * same sequence in both — and the same sequence as the Python edition, whose
 * `test_invariants.py` defines the identical xorshift.
 */

export const SCOPE = "guild-1";
export const COIN = "COIN";
export const NOW = 1_700_000_000_000;
export const MEMBERS = ["ana", "ben", "cai", "dee", "eli"] as const;

/** Small deterministic PRNG. Test-only; the library itself contains no randomness. */
export class Rng {
  private state: number;

  constructor(public readonly seed: number) {
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  public next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  public int(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }

  public pick<T>(values: readonly T[]): T {
    return values[this.next() % values.length] as T;
  }
}

/** The caller's world: balances the engine never sees between calls. */
export class World {
  public readonly balances = new Map<string, number>();

  constructor(
    public readonly members: readonly string[],
    startingBalance: number,
  ) {
    for (const member of members) {
      this.balances.set(accountKey(memberAccount(SCOPE, member, COIN)), startingBalance);
    }
  }

  public account(member: string): Account {
    const ref = memberAccount(SCOPE, member, COIN);
    return account(ref, this.balances.get(accountKey(ref)) ?? 0);
  }

  /**
   * A system account with its current balance.
   *
   * A caller that stores system accounts has to load and pass them, or the
   * engine fills in a zero and the stored system balance goes wrong. These
   * suites store them, precisely so they can assert that the books close.
   */
  public system(kind: SystemAccount): Account {
    const ref = systemAccount(SCOPE, COIN, kind);
    return account(ref, this.balances.get(accountKey(ref)) ?? 0);
  }

  /** Apply a posting the way a caller must: every line, all at once. */
  public apply(posting: Posting): void {
    expect(isBalanced(posting)).toBe(true);
    for (const line of posting.lines) {
      const key = accountKey(line.account);
      const current = this.balances.get(key) ?? 0;
      expect(current).toBe(line.balanceBefore);
      this.balances.set(key, line.balanceAfter);
    }
  }

  /** Sum over member accounts only — the money in members' hands. */
  public memberTotal(): number {
    let total = 0;
    for (const member of this.members) {
      total += this.balances.get(accountKey(memberAccount(SCOPE, member, COIN))) ?? 0;
    }
    return total;
  }

  /** Sum over every account, system ones included. */
  public grandTotal(): number {
    let total = 0;
    for (const value of this.balances.values()) {
      total += value;
    }
    return total;
  }
}

export const engine = (): EconomyEngine =>
  new EconomyEngine({
    currencies: [createCurrency({ code: COIN, maxBalance: 100_000_000 })],
    earnRules: [
      createEarnRule({
        key: "message",
        amount: 10,
        currency: COIN,
        cooldownSeconds: 60,
        periodCapAmount: 100,
      }),
    ],
  });
