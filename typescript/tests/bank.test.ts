import { describe, expect, it } from "vitest";
import {
  account,
  accountKey,
  accrueDepositInterest,
  activeHolds,
  availableBalance,
  captureHold,
  createCurrency,
  createDepositTerms,
  deposit,
  depositBalance,
  DepositError,
  earlyWithdrawalPenalty,
  EconomyEngine,
  heldAmount,
  HoldError,
  InsufficientFundsError,
  InvalidAmountError,
  isMature,
  maturityValue,
  memberAccount,
  openDeposit,
  placeHold,
  placeInEscrow,
  PostingKind,
  releaseHold,
  releaseFromEscrow,
  SystemAccount,
  systemAccount,
  settleFromEscrow,
  withdraw,
  ValidationError,
} from "../src/index.js";

/** The mirror of `python/tests/test_bank.py`. */

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function engine(): EconomyEngine {
  return new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });
}

function ref(name = "ana") {
  return memberAccount("g1", name, "COIN");
}

describe("deposit terms", () => {
  it("defaults to an on-demand account paying nothing", () => {
    const terms = createDepositTerms();
    expect(terms.termMs).toBe(0);
    expect(terms.rateBasisPoints).toBe(0);
    expect(isMature(openDeposit("d", ref(), terms, NOW), NOW)).toBe(true);
  });

  it("refuses an early-withdrawal penalty on an on-demand account", () => {
    // There is nothing to be early for, and a penalty that could never apply is
    // a configuration mistake worth catching at build time.
    expect(() => createDepositTerms({ termMs: 0, earlyWithdrawalPenaltyBp: 5000 })).toThrow(
      DepositError,
    );
  });

  it("refuses impossible values", () => {
    expect(() => createDepositTerms({ termMs: -1 })).toThrow(DepositError);
    expect(() =>
      createDepositTerms({ termMs: DAY, earlyWithdrawalPenaltyBp: 10_001 }),
    ).toThrow(DepositError);
    expect(() => createDepositTerms({ minimumBalance: -1 })).toThrow(DepositError);
  });
});

describe("depositing", () => {
  it("really moves the money to the bank account", () => {
    // Not a flag beside the balance: a posting, so "how much is on deposit" is
    // one balance rather than a sum across every member's row.
    const opened = openDeposit("d", ref(), createDepositTerms(), NOW);
    const { booking, deposit: saved } = deposit(engine(), opened, account(ref(), 10_000), 4_000, {
      now: NOW,
      operationId: "op",
      reason: "save",
    });
    expect(booking.posting.kind).toBe(PostingKind.Deposit);
    expect(booking.balances[accountKey(ref())]).toBe(6_000);
    expect(booking.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Bank))]).toBe(
      4_000,
    );
    expect(saved.principal).toBe(4_000);
  });

  it("refuses a deposit from somebody else", () => {
    const opened = openDeposit("d", ref("ana"), createDepositTerms(), NOW);
    expect(() =>
      deposit(engine(), opened, account(ref("ben"), 10_000), 100, {
        now: NOW,
        operationId: "op",
        reason: "x",
      }),
    ).toThrow(DepositError);
  });
});

describe("interest", () => {
  function funded(rateBasisPoints: number, amount = 10_000) {
    const economy = engine();
    const opened = openDeposit("d", ref(), createDepositTerms({ rateBasisPoints }), NOW);
    const { deposit: saved } = deposit(economy, opened, account(ref(), 100_000), amount, {
      now: NOW,
      operationId: "in",
      reason: "x",
    });
    return { economy, saved };
  }

  it("is issued from the mint", () => {
    // Interest is new currency. In a closed economy there is no other honest
    // place for it to come from, and the posting says so.
    const { economy, saved } = funded(500);
    const { booking, deposit: accrued } = accrueDepositInterest(economy, saved, 1, {
      now: NOW,
      operationId: "int",
      reason: "interest",
    });
    expect(booking).not.toBeNull();
    expect(booking!.posting.kind).toBe(PostingKind.Interest);
    expect(booking!.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Mint))]).toBe(
      -500,
    );
    expect(accrued.accruedInterest).toBe(500);
  });

  it("can be funded from somewhere else", () => {
    // An operator paying interest out of collected fees does not move the money
    // supply, and the posting shows that instead.
    const { economy, saved } = funded(500);
    const fees = account(systemAccount("g1", "COIN", SystemAccount.Fee), 100_000);
    const { booking } = accrueDepositInterest(economy, saved, 1, {
      now: NOW,
      operationId: "int",
      reason: "interest",
      source: fees,
    });
    expect(booking!.balances[accountKey(fees.ref)]).toBe(99_500);
  });

  it("treats nothing to credit as an ordinary outcome", () => {
    // A nightly job across a whole community will see a lot of this.
    const opened = openDeposit("d", ref(), createDepositTerms(), NOW);
    const { booking, deposit: accrued } = accrueDepositInterest(engine(), opened, 5, {
      now: NOW,
      operationId: "int",
      reason: "x",
    });
    expect(booking).toBeNull();
    expect(accrued.periodsAccrued).toBe(5);
  });

  it("compounds across periods", () => {
    const { economy, saved } = funded(200, 5_000);
    let current = saved;
    const credited: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const step = accrueDepositInterest(economy, current, 1, {
        now: NOW,
        operationId: `i${index}`,
        reason: "interest",
      });
      current = step.deposit;
      credited.push(step.booking === null ? 0 : step.booking.posting.amount);
    }
    expect(credited).toEqual([100, 102, 104]);
    expect(depositBalance(current)).toBe(5_306);
  });

  it("projects a maturity value without booking or reading a clock", () => {
    const opened = openDeposit("d", ref(), createDepositTerms({ rateBasisPoints: 500 }), NOW);
    const funded10k = { ...opened, principal: 10_000 };
    expect(maturityValue(funded10k, 0)).toBe(10_000);
    expect(maturityValue(funded10k, 1)).toBe(10_500);
  });
});

describe("maturity and penalty", () => {
  function funded(terms: Parameters<typeof createDepositTerms>[0]) {
    const economy = engine();
    const opened = openDeposit("d", ref(), createDepositTerms(terms), NOW);
    const { deposit: saved } = deposit(economy, opened, account(ref(), 100_000), 10_000, {
      now: NOW,
      operationId: "in",
      reason: "x",
    });
    return accrueDepositInterest(economy, saved, 5, {
      now: NOW,
      operationId: "int",
      reason: "x",
    }).deposit;
  }

  it("keeps an on-demand account always mature", () => {
    const saved = funded({ rateBasisPoints: 500 });
    expect(isMature(saved, NOW)).toBe(true);
    expect(earlyWithdrawalPenalty(saved, NOW)).toBe(0);
  });

  it("matures a term account when its term runs out", () => {
    const saved = funded({
      rateBasisPoints: 500,
      termMs: 30 * DAY,
      earlyWithdrawalPenaltyBp: 5000,
    });
    expect(isMature(saved, NOW + 29 * DAY)).toBe(false);
    expect(isMature(saved, NOW + 30 * DAY)).toBe(true);
  });

  it("takes the penalty out of the interest only", () => {
    // A term account that could hand a member back less than they put in is a
    // product nobody should ship by accident.
    const saved = funded({
      rateBasisPoints: 500,
      termMs: 30 * DAY,
      earlyWithdrawalPenaltyBp: 10_000,
    });
    expect(earlyWithdrawalPenalty(saved, NOW)).toBe(saved.accruedInterest);
    expect(earlyWithdrawalPenalty(saved, NOW)).toBeLessThan(saved.principal);
    expect(earlyWithdrawalPenalty(saved, NOW + 30 * DAY)).toBe(0);
  });
});

describe("withdrawing", () => {
  function saved(economy: EconomyEngine, terms = {}, amount = 5_000, periods = 0) {
    const opened = openDeposit("d", ref(), createDepositTerms(terms), NOW);
    let current = deposit(economy, opened, account(ref(), 100_000), amount, {
      now: NOW,
      operationId: "in",
      reason: "x",
    }).deposit;
    if (periods > 0) {
      current = accrueDepositInterest(economy, current, periods, {
        now: NOW,
        operationId: "int",
        reason: "x",
      }).deposit;
    }
    return current;
  }

  it("takes interest before principal", () => {
    const economy = engine();
    const current = saved(economy, { rateBasisPoints: 1000 }, 10_000, 1);
    expect(current.accruedInterest).toBe(1_000);

    const after = withdraw(economy, current, account(ref(), 90_000), 600, {
      now: NOW,
      operationId: "w",
      reason: "x",
    }).deposit;
    expect(after.accruedInterest).toBe(400);
    expect(after.principal).toBe(10_000); // untouched
  });

  it("labels the posting a withdrawal", () => {
    const economy = engine();
    const { booking } = withdraw(economy, saved(economy), account(ref(), 5_000), 1_000, {
      now: NOW,
      operationId: "w",
      reason: "x",
    });
    expect(booking.posting.kind).toBe(PostingKind.Withdrawal);
  });

  it("cannot take more than is there", () => {
    const economy = engine();
    expect(() =>
      withdraw(economy, saved(economy), account(ref(), 5_000), 5_001, {
        now: NOW,
        operationId: "w",
        reason: "x",
      }),
    ).toThrow(DepositError);
  });

  it("lets the penalty reduce what can be taken", () => {
    const economy = engine();
    const current = saved(
      economy,
      { rateBasisPoints: 1000, termMs: 30 * DAY, earlyWithdrawalPenaltyBp: 5000 },
      10_000,
      1,
    );
    const penalty = earlyWithdrawalPenalty(current, NOW);
    expect(penalty).toBe(500);
    expect(() =>
      withdraw(economy, current, account(ref(), 90_000), depositBalance(current), {
        now: NOW,
        operationId: "w",
        reason: "x",
      }),
    ).toThrow(DepositError);
    const after = withdraw(
      economy,
      current,
      account(ref(), 90_000),
      depositBalance(current) - penalty,
      { now: NOW, operationId: "w", reason: "x" },
    ).deposit;
    expect(depositBalance(after)).toBe(0);
  });

  it("refuses a withdrawal that would strand a balance below the minimum", () => {
    const economy = engine();
    const current = saved(economy, { minimumBalance: 1_000 });
    expect(() =>
      withdraw(economy, current, account(ref(), 5_000), 4_500, {
        now: NOW,
        operationId: "w",
        reason: "x",
      }),
    ).toThrow(DepositError);
    // Taking everything is allowed; taking all but a scrap is not.
    const after = withdraw(economy, current, account(ref(), 5_000), 5_000, {
      now: NOW,
      operationId: "w",
      reason: "x",
    }).deposit;
    expect(depositBalance(after)).toBe(0);
  });
});

describe("holds", () => {
  it("reserves without booking", () => {
    const held = account(ref(), 5_000);
    const hold = placeHold("h1", held, 3_000, { now: NOW, reason: "an order" });
    expect(hold.amount).toBe(3_000);
    expect(availableBalance(held, [hold], NOW)).toBe(2_000);
    expect(heldAmount([hold], NOW)).toBe(3_000);
  });

  it("will not reserve the same currency twice", () => {
    // The entire reason holds exist: a member placing an order, bidding in an
    // auction and buying from a shop with one balance.
    const held = account(ref(), 5_000);
    const holds = [placeHold("h1", held, 3_000, { now: NOW, reason: "order" })];
    expect(() => placeHold("h2", held, 3_000, { now: NOW, reason: "bid", existing: holds })).toThrow(
      InsufficientFundsError,
    );
  });

  it("expires a hold on its own", () => {
    const held = account(ref(), 5_000);
    const hold = placeHold("h1", held, 3_000, {
      now: NOW,
      reason: "order",
      expiresAt: NOW + 1000,
    });
    expect(availableBalance(held, [hold], NOW)).toBe(2_000);
    expect(availableBalance(held, [hold], NOW + 1000)).toBe(5_000);
    expect(activeHolds([hold], NOW + 1000)).toEqual([]);
  });

  it("frees the funds when released", () => {
    const held = account(ref(), 5_000);
    const holds = releaseHold(
      [placeHold("h1", held, 3_000, { now: NOW, reason: "order" })],
      "h1",
    );
    expect(availableBalance(held, holds, NOW)).toBe(5_000);
    expect(() => releaseHold(holds, "h1")).toThrow(HoldError);
  });

  it("books the movement when captured", () => {
    const held = account(ref("ana"), 5_000);
    const hold = placeHold("h1", held, 3_000, { now: NOW, reason: "order" });
    const { booking, holds } = captureHold(engine(), hold, held, account(ref("ben"), 0), {
      now: NOW,
      operationId: "cap",
      reason: "settled",
      holds: [hold],
    });
    expect(booking.posting.amount).toBe(3_000);
    expect(holds).toEqual([]);
  });

  it("captures less but never more than was reserved", () => {
    const held = account(ref("ana"), 5_000);
    const hold = placeHold("h1", held, 3_000, { now: NOW, reason: "order" });
    const { booking } = captureHold(engine(), hold, held, account(ref("ben"), 0), {
      now: NOW,
      operationId: "c",
      reason: "x",
      amount: 1_000,
    });
    expect(booking.posting.amount).toBe(1_000);
    expect(() =>
      captureHold(engine(), hold, held, account(ref("ben"), 0), {
        now: NOW,
        operationId: "c2",
        reason: "x",
        amount: 3_001,
      }),
    ).toThrow(HoldError);
  });

  it("cannot capture an expired hold", () => {
    const held = account(ref("ana"), 5_000);
    const hold = placeHold("h1", held, 3_000, {
      now: NOW,
      reason: "order",
      expiresAt: NOW + 100,
    });
    expect(() =>
      captureHold(engine(), hold, held, account(ref("ben"), 0), {
        now: NOW + 100,
        operationId: "c",
        reason: "x",
      }),
    ).toThrow(HoldError);
  });

  it("captures only against the account the hold is on", () => {
    const held = account(ref("ana"), 5_000);
    const hold = placeHold("h1", held, 3_000, { now: NOW, reason: "order" });
    expect(() =>
      captureHold(engine(), hold, account(ref("eve"), 5_000), account(ref("ben"), 0), {
        now: NOW,
        operationId: "c",
        reason: "x",
      }),
    ).toThrow(HoldError);
  });

  it("ignores a hold that belongs to somebody else", () => {
    // Callers pass a list of holds, and the list may hold other people's.
    const mine = account(ref("ana"), 500);
    const theirs = placeHold("h", account(ref("bob"), 5_000), 1_000, {
      now: NOW,
      reason: "bid",
    });
    expect(availableBalance(mine, [theirs], NOW)).toBe(500);
    expect(placeHold("h2", mine, 500, { now: NOW, reason: "bid", existing: [theirs] }).amount).toBe(
      500,
    );
  });

  it("uses a hold id once", () => {
    const mine = account(ref(), 1_000);
    const first = placeHold("h1", mine, 100, { now: NOW, reason: "bid" });
    expect(() =>
      placeHold("h1", mine, 100, { now: NOW, reason: "bid", existing: [first] }),
    ).toThrow(HoldError);
  });

  it("refuses a hold that expires before it is placed", () => {
    expect(() =>
      placeHold("h", account(ref(), 1_000), 100, { now: NOW, reason: "bid", expiresAt: NOW }),
    ).toThrow(HoldError);
  });
});

describe("escrow", () => {
  // A hold reserves a balance where it is; escrow puts it in a third account
  // both sides can see. Which one a caller wants is a real decision, so both
  // exist and the difference is documented rather than implied.
  const escrowRef = () => systemAccount("g1", "COIN", SystemAccount.Escrow);

  it("really moves the currency", () => {
    const booking = placeInEscrow(engine(), account(ref("ana"), 5_000), 3_000, {
      now: NOW,
      operationId: "e1",
      reason: "a big trade",
    });
    expect(booking.posting.kind).toBe(PostingKind.Escrow);
    expect(booking.balances[accountKey(ref("ana"))]).toBe(2_000);
    expect(booking.balances[accountKey(escrowRef())]).toBe(3_000);
  });

  it("will not escrow what a member does not have", () => {
    expect(() =>
      placeInEscrow(engine(), account(ref("ana"), 100), 3_000, {
        now: NOW,
        operationId: "e1",
        reason: "x",
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("gives it back under its own kind", () => {
    // "You got your money back" and "the seller was paid" are the two outcomes
    // an operator is asked to tell apart six months later.
    const escrow = account(escrowRef(), 3_000);
    const booking = releaseFromEscrow(engine(), account(ref("ana"), 2_000), 3_000, {
      now: NOW,
      operationId: "e2",
      reason: "the deal fell through",
      escrowAccount: escrow,
    });
    expect(booking.posting.kind).toBe(PostingKind.EscrowRelease);
    expect(booking.balances[accountKey(ref("ana"))]).toBe(5_000);
    expect(booking.balances[accountKey(escrow.ref)]).toBe(0);
  });

  it("pays the counterparty as a settlement", () => {
    const escrow = account(escrowRef(), 3_000);
    const booking = settleFromEscrow(engine(), account(ref("ben"), 0), 3_000, {
      now: NOW,
      operationId: "e3",
      reason: "the deal went through",
      escrowAccount: escrow,
    });
    expect(booking.posting.kind).toBe(PostingKind.Settlement);
    expect(booking.balances[accountKey(ref("ben"))]).toBe(3_000);
    expect(booking.balances[accountKey(escrow.ref)]).toBe(0);
  });

  it("conserves the currency over a whole escrowed deal", () => {
    const economy = engine();
    const balances: Record<string, number> = {
      [accountKey(ref("ana"))]: 5_000,
      [accountKey(ref("ben"))]: 0,
    };
    const apply = (booking: { posting: { lines: readonly { account: { scope: string; owner: string; currency: string }; delta: number }[] } }) => {
      for (const line of booking.posting.lines) {
        const key = accountKey(line.account);
        balances[key] = (balances[key] ?? 0) + line.delta;
      }
    };

    apply(
      placeInEscrow(economy, account(ref("ana"), 5_000), 3_000, {
        now: NOW,
        operationId: "e1",
        reason: "x",
      }),
    );
    expect(balances[accountKey(ref("ana"))]).toBe(2_000);
    apply(
      settleFromEscrow(economy, account(ref("ben"), 0), 3_000, {
        now: NOW,
        operationId: "e2",
        reason: "x",
        escrowAccount: account(escrowRef(), 3_000),
      }),
    );
    expect(balances[accountKey(ref("ben"))]).toBe(3_000);
    expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(5_000);
  });

  it("will not let a caller who stores escrow over-release it", () => {
    // The engine lets a system account go negative; escrow should not. The
    // check sits in these functions and is conditional on the caller handing
    // the account over -- the same bargain the rest of the library strikes
    // about system balances.
    const escrow = account(escrowRef(), 1_000);
    expect(() =>
      releaseFromEscrow(engine(), account(ref("ana"), 0), 3_000, {
        now: NOW,
        operationId: "e",
        reason: "x",
        escrowAccount: escrow,
      }),
    ).toThrow(InsufficientFundsError);
    expect(() =>
      settleFromEscrow(engine(), account(ref("ben"), 0), 3_000, {
        now: NOW,
        operationId: "e",
        reason: "x",
        escrowAccount: escrow,
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("does not second-guess a caller who does not store escrow", () => {
    // Storing system accounts is the caller's choice, and this cannot invent a
    // balance it was never given.
    const booking = releaseFromEscrow(engine(), account(ref("ana"), 0), 3_000, {
      now: NOW,
      operationId: "e",
      reason: "x",
    });
    expect(booking.balances[accountKey(ref("ana"))]).toBe(3_000);
  });

  it("refuses a zero amount and a bad timestamp", () => {
    for (const book of [placeInEscrow, releaseFromEscrow, settleFromEscrow]) {
      expect(() =>
        book(engine(), account(ref("ana"), 5_000), 0, {
          now: NOW,
          operationId: "e",
          reason: "x",
        }),
      ).toThrow(InvalidAmountError);
      expect(() =>
        book(engine(), account(ref("ana"), 5_000), 100, {
          now: 1.5,
          operationId: "e",
          reason: "x",
        }),
      ).toThrow(ValidationError);
    }
  });
});
