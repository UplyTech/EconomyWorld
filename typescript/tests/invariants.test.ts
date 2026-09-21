import { describe, it, expect } from "vitest";
import {
  acceptTrade,
  account,
  addItem,
  createEarnState,
  createItem,
  createOffer,
  EarnOutcome,
  EconomyError,
  Inventory,
  isBalanced,
  memberAccount,
  proposeTrade,
  purchase,
  removeItem,
  settleTrade,
  SystemAccount,
  type EarnState,
  type Posting,
} from "../src/index.js";
import { COIN, engine, MEMBERS, NOW, Rng, SCOPE, World } from "./support/world.js";

/**
 * The concept is explicit that example-based tests are not enough for an
 * economy: it asks for runs over very many random booking sequences that prove
 * the sum of all balances does not move when currency is only ever transferred.
 *
 * These are those runs. They find the class of bug nobody would have written an
 * example for — the one where a rounding step, a clamp or an early return
 * quietly creates or destroys a coin.
 *
 * The generator is a seeded xorshift rather than `Math.random`, so a failure is
 * reproducible from the seed printed in the assertion.
 */


describe("invariant: transfers never change the money supply", () => {
  it("holds over 200 random transfer sequences", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 10_000);
      const economy = engine();
      const before = world.memberTotal();
      const grandBefore = world.grandTotal();

      for (let step = 0; step < 40; step += 1) {
        const from = rng.pick(MEMBERS);
        const to = rng.pick(MEMBERS);
        if (from === to) {
          continue;
        }
        const source = world.account(from);
        const amount = rng.int(1, 3_000);
        if (source.balance < amount) {
          continue; // the caller would show "not enough"
        }
        const result = economy.transfer(source, world.account(to), amount, {
          now: NOW + step * 1000,
          operationId: `s${seed}-${step}`,
          reason: "random transfer",
        });
        world.apply(result.posting);
      }

      expect(world.memberTotal(), `seed ${seed}`).toBe(before);
      // Nothing entered or left the economy, so the books do not move at all.
      expect(world.grandTotal(), `seed ${seed}`).toBe(grandBefore);
    }
  });
});

describe("invariant: every posting balances, whatever produced it", () => {
  it("holds over 200 mixed sequences of every operation", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 5_000);
      const economy = engine();
      const earnStates = new Map<string, EarnState>();
      const postings: Posting[] = [];
      const grandBefore = world.grandTotal();

      for (let step = 0; step < 50; step += 1) {
        const now = NOW + step * 120_000;
        const operationId = `m${seed}-${step}`;
        const member = rng.pick(MEMBERS);
        const action = rng.int(0, 4);

        try {
          if (action === 0) {
            const result = economy.credit(world.account(member), rng.int(1, 500), {
              now,
              operationId,
              reason: "random credit",
              source: world.system(SystemAccount.Mint),
            });
            world.apply(result.posting);
            postings.push(result.posting);
          } else if (action === 1) {
            const result = economy.debit(world.account(member), rng.int(1, 500), {
              now,
              operationId,
              reason: "random debit",
              target: world.system(SystemAccount.Sink),
            });
            world.apply(result.posting);
            postings.push(result.posting);
          } else if (action === 2) {
            const other = rng.pick(MEMBERS);
            if (other === member) {
              continue;
            }
            const result = economy.transfer(
              world.account(member),
              world.account(other),
              rng.int(1, 500),
              { now, operationId, reason: "random transfer" },
            );
            world.apply(result.posting);
            postings.push(result.posting);
          } else if (action === 3) {
            const state = earnStates.get(member) ?? createEarnState();
            const result = economy.earn(world.account(member), "message", state, {
              now,
              operationId,
              reason: "random earn",
              source: world.system(SystemAccount.Mint),
            });
            earnStates.set(member, result.state);
            if (result.outcome === EarnOutcome.Earned && result.posting !== null) {
              world.apply(result.posting);
              postings.push(result.posting);
            }
          } else {
            const result = economy.applyDecay(
              world.account(member),
              {
                amountPerPeriod: rng.int(1, 20),
                permillePerPeriod: rng.int(0, 50),
                periodSeconds: 3600,
                floor: 0,
                graceSeconds: 0,
              },
              {
                now,
                operationId,
                reason: "random decay",
                sink: world.system(SystemAccount.Sink),
                lastActivityAt: NOW,
                lastAppliedAt: NOW + (step - 1) * 120_000,
              },
            );
            if (result.posting !== null) {
              world.apply(result.posting);
              postings.push(result.posting);
            }
          }
        } catch (error) {
          // Insufficient funds and overflow are legitimate refusals; the point
          // of this run is that nothing that *did* book broke the invariant.
          // An assertion failure from world.apply must NOT be swallowed here --
          // that would hide exactly the bug these runs exist to find.
          if (error instanceof EconomyError) {
            continue;
          }
          throw error;
        }
      }

      for (const posting of postings) {
        expect(isBalanced(posting), `seed ${seed}, ${posting.operationId}`).toBe(true);
      }
      // Even with money entering and leaving, the books close: every coin the
      // mint issued is somewhere, and every coin destroyed sits in the sink, so
      // the sum across all accounts never moves.
      expect(world.grandTotal(), `seed ${seed}`).toBe(grandBefore);
    }
  });
});

describe("invariant: a settled trade moves value without creating it", () => {
  it("holds over 200 random trades", () => {
    const sword = createItem({ itemId: "sword", stackable: false });
    const potion = createItem({ itemId: "potion", maxStack: 100 });
    const items = { sword, potion };

    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const economy = engine();

      const leftBalance = rng.int(0, 5_000);
      const rightBalance = rng.int(0, 5_000);
      const leftAmount = rng.int(0, leftBalance);
      const rightAmount = rng.int(0, rightBalance);
      const leftPotions = rng.int(0, 10);
      const rightPotions = rng.int(0, 10);
      const leftOffers = rng.int(0, leftPotions);
      const rightOffers = rng.int(0, rightPotions);

      if (leftAmount === 0 && rightAmount === 0 && leftOffers === 0 && rightOffers === 0) {
        continue; // not a trade
      }

      const proposed = proposeTrade({
        tradeId: `t${seed}`,
        scope: SCOPE,
        currency: COIN,
        left: {
          owner: "ana",
          amount: leftAmount,
          items: leftOffers > 0 ? [{ itemId: "potion", quantity: leftOffers }] : [],
        },
        right: {
          owner: "ben",
          amount: rightAmount,
          items: rightOffers > 0 ? [{ itemId: "potion", quantity: rightOffers }] : [],
        },
        now: NOW,
      });

      const settled = settleTrade(economy, {
        trade: acceptTrade(acceptTrade(proposed, "ana", NOW), "ben", NOW),
        leftAccount: account(memberAccount(SCOPE, "ana", COIN), leftBalance),
        rightAccount: account(memberAccount(SCOPE, "ben", COIN), rightBalance),
        leftInventory: new Inventory([{ itemId: "potion", quantity: leftPotions }]),
        rightInventory: new Inventory([{ itemId: "potion", quantity: rightPotions }]),
        items,
        now: NOW + 1000,
        operationId: `t${seed}-settle`,
        reason: "random trade",
      });

      // Currency is conserved.
      const balancesAfter =
        settled.booking === null
          ? leftBalance + rightBalance
          : (settled.booking.balances[`${SCOPE}/ana/${COIN}`] ?? 0) +
            (settled.booking.balances[`${SCOPE}/ben/${COIN}`] ?? 0);
      expect(balancesAfter, `seed ${seed}`).toBe(leftBalance + rightBalance);

      // Items are conserved.
      const potionsAfter =
        settled.leftInventory.inventory.quantityOf("potion") +
        settled.rightInventory.inventory.quantityOf("potion");
      expect(potionsAfter, `seed ${seed}`).toBe(leftPotions + rightPotions);

      if (settled.booking !== null) {
        expect(isBalanced(settled.booking.posting)).toBe(true);
      }
    }
  });
});

describe("invariant: a purchase moves exactly the price", () => {
  it("holds over 200 random purchases", () => {
    const potion = createItem({ itemId: "potion", maxStack: 1000 });

    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const economy = engine();
      const unitPrice = rng.int(0, 500);
      const quantity = rng.int(1, 20);
      const balance = rng.int(unitPrice * quantity, unitPrice * quantity + 5_000);

      const result = purchase(economy, {
        offer: createOffer({
          offerId: "o",
          itemId: "potion",
          unitPrice,
          currency: COIN,
          stock: 1000,
        }),
        item: potion,
        buyer: account(memberAccount(SCOPE, "ana", COIN), balance),
        inventory: new Inventory(),
        quantity,
        now: NOW,
        operationId: `p${seed}`,
        reason: "random purchase",
      });

      expect(result.totalPrice, `seed ${seed}`).toBe(unitPrice * quantity);
      expect(result.booking.balances[`${SCOPE}/ana/${COIN}`], `seed ${seed}`).toBe(
        balance - unitPrice * quantity,
      );
      expect(result.inventory.inventory.quantityOf("potion")).toBe(quantity);
      expect(result.offer.stock).toBe(1000 - quantity);
      expect(isBalanced(result.booking.posting)).toBe(true);
    }
  });
});

describe("invariant: a reversal restores the exact balances", () => {
  it("holds over 200 random credit-then-reverse pairs", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, rng.int(0, 10_000));
      const economy = engine();
      const member = rng.pick(MEMBERS);
      const other = rng.pick(MEMBERS.filter((m) => m !== member));
      const snapshot = new Map(world.balances);

      const source = world.account(member);
      const amount = rng.int(1, Math.max(1, source.balance));
      if (source.balance < amount) {
        continue;
      }

      const original = economy.transfer(source, world.account(other), amount, {
        now: NOW,
        operationId: `r${seed}`,
        reason: "to be undone",
      });
      world.apply(original.posting);

      const reversal = economy.reverse(
        original.posting,
        Object.fromEntries(world.balances),
        { now: NOW + 1000, operationId: `r${seed}-undo`, reason: "undo" },
      );
      world.apply(reversal.posting);

      for (const [key, value] of snapshot) {
        expect(world.balances.get(key), `seed ${seed}, ${key}`).toBe(value);
      }
    }
  });
});

describe("invariant: inventory operations conserve quantity", () => {
  it("holds over 200 random add/remove sequences", () => {
    const potion = createItem({ itemId: "potion", maxStack: 100_000 });

    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      let held = new Inventory();
      let expected = 0;

      for (let step = 0; step < 30; step += 1) {
        const amount = rng.int(1, 50);
        if (rng.int(0, 1) === 0) {
          held = addItem(held, potion, amount).inventory;
          expected += amount;
        } else if (expected >= amount) {
          held = removeItem(held, "potion", amount).inventory;
          expected -= amount;
        }
        // The running count the test keeps and the inventory's own must never
        // disagree, whatever order the operations came in.
        expect(held.quantityOf("potion"), `seed ${seed}, step ${step}`).toBe(expected);
      }
      expect(held.isEmpty, `seed ${seed}`).toBe(expected === 0);
    }
  });
});
