#!/usr/bin/env node
/**
 * Answer every generated case with the TypeScript edition.
 *
 * Run `npm run build` in typescript/ first — this reads the built package, so
 * what it answers for is what a caller would install rather than what the test
 * suite imports.
 *
 *   node run-typescript.mjs --cases cases.json --out results-typescript.json
 *
 * This file and run_python.py are deliberately written to mirror each other line
 * for line. A difference between them is a difference in the harness, not in the
 * library, and it is the one kind of false positive that would make nobody trust
 * the red build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, and the ESM loader reads `e:` as a URL scheme it does not know.
const ew = await import(
  pathToFileURL(join(HERE, "..", "..", "..", "typescript", "dist", "index.mjs")).href
);

const SCOPE = "g1";
const CURRENCY = "COIN";
const NOW = 1_700_000_000_000;

const engine = new ew.EconomyEngine({ currencies: [ew.createCurrency({ code: CURRENCY })] });
const ref = (owner) => ew.memberAccount(SCOPE, owner, CURRENCY);
const acct = (owner, balance) => ew.account(ref(owner), balance);

/** An error is an answer too: both editions must refuse the same inputs. */
const go = (fn) => {
  try {
    return fn();
  } catch (error) {
    return `E:${error.constructor.name}`;
  }
};

// ---------------------------------------------------------------------------
// Normalised shapes. Both runners emit exactly these keys, in this order.
// ---------------------------------------------------------------------------
const scheduleOf = (schedule) => ({
  principal: schedule.principal,
  totalInterest: schedule.totalInterest,
  totalPaid: schedule.totalPaid,
  payments: schedule.instalments.map((row) => row.payment),
  interest: schedule.instalments.map((row) => row.interest),
  closing: schedule.instalments.map((row) => row.closingBalance),
});

const positionOf = (position) => ({
  units: position.units,
  costBasis: position.costBasis,
  realisedGain: position.realisedGain,
});

const orderOf = (order) => ({
  orderId: order.orderId,
  side: order.side,
  unitPrice: order.unitPrice,
  quantity: order.quantity,
  filled: order.filled,
  state: order.state,
});

const fillOf = (fill) => ({
  buyOrderId: fill.buyOrderId,
  sellOrderId: fill.sellOrderId,
  quantity: fill.quantity,
  unitPrice: fill.unitPrice,
  consideration: fill.consideration,
});

function answer(item) {
  switch (item.kind) {
    case "money": {
      const mode = item.rounding;
      return {
        permille: go(() => ew.applyPermille(Math.abs(item.amount), item.permilleChain)),
        basisPoints: go(() => ew.applyBasisPoints(item.amount, item.basisPoints, mode)),
        rate: go(() =>
          ew.applyRate(item.amount, item.rateNumerator, item.rateDenominator, mode),
        ),
        divide: go(() => ew.divideRounded(item.amount, item.rateDenominator, mode)),
        distribute: go(() => ew.distribute(item.amount, item.weights)),
        evenly: go(() => ew.distributeEvenly(item.amount, item.parts)),
        split: go(() => {
          const parts = ew.splitMinorUnits(
            item.amount,
            ew.createCurrency({ code: "X", minorUnits: 2 }),
          );
          // A list rather than the object, so both runners emit the same shape.
          return [parts.negative, parts.whole, parts.fraction];
        }),
      };
    }

    case "interest": {
      return {
        accrue: go(() =>
          ew.accrueInterest(
            item.principal,
            item.rateBasisPoints,
            item.periods,
            item.basis,
            item.rounding,
          ),
        ),
        projected: go(() =>
          ew.projectBalance(
            item.principal,
            item.rateBasisPoints,
            item.periods,
            item.basis,
            item.rounding,
          ),
        ),
        level: go(() =>
          ew.levelPayment(item.principal, item.rateBasisPoints, item.periods, item.rounding),
        ),
        schedule: go(() =>
          scheduleOf(
            ew.amortisationSchedule(
              item.principal,
              item.rateBasisPoints,
              item.periods,
              item.method,
              item.rounding,
            ),
          ),
        ),
      };
    }

    case "fee": {
      const rule = go(() =>
        ew.createFeeRule("f", {
          mode: item.mode,
          flat: item.flat,
          basisPoints: item.basisPoints,
          tiers: item.tiers,
          minimum: item.minimum,
          maximum: item.maximum,
          rounding: item.rounding,
        }),
      );
      if (typeof rule === "string") return { rule };
      const quote = go(() => ew.quoteFee(rule, item.amount));
      return {
        rule: "ok",
        fee: typeof quote === "string" ? quote : quote.fee,
        payerPays: typeof quote === "string" ? quote : quote.payerPays,
        recipientReceives: typeof quote === "string" ? quote : quote.recipientReceives,
        splitFee: go(() => ew.splitFee(typeof quote === "string" ? 0 : quote.fee, [1, 2, 3])),
      };
    }

    case "bank": {
      const terms = go(() =>
        ew.createDepositTerms({
          rateBasisPoints: item.rateBasisPoints,
          basis: item.basis,
          rounding: item.rounding,
          termMs: item.termMs,
          earlyWithdrawalPenaltyBp: item.penaltyBp,
        }),
      );
      if (typeof terms === "string") return { terms };

      let account = ew.openDeposit("d1", ref("ana"), terms, NOW);
      const member = acct("ana", 1_000_000_000);
      const paidIn = go(() => {
        const out = ew.deposit(engine, account, member, item.principal || 1, {
          now: NOW,
          operationId: "in",
          reason: "in",
        });
        account = out.deposit;
        return out.booking.posting.amount;
      });
      const accrued = go(() => {
        const out = ew.accrueDepositInterest(engine, account, item.periods, {
          now: NOW,
          operationId: "acc",
          reason: "acc",
        });
        account = out.deposit;
        return out.booking === null ? 0 : out.booking.posting.amount;
      });
      const at = NOW + item.withdrawAt;
      return {
        terms: "ok",
        paidIn,
        accrued,
        balance: ew.depositBalance(account),
        mature: go(() => ew.isMature(account, at)),
        penalty: go(() => ew.earlyWithdrawalPenalty(account, at)),
        maturity: go(() => ew.maturityValue(account, 12)),
        withdrawn: go(() => {
          const out = ew.withdraw(engine, account, member, item.withdraw, {
            now: at,
            operationId: "out",
            reason: "out",
          });
          return [
            out.booking.posting.amount,
            out.deposit.principal,
            out.deposit.accruedInterest,
          ];
        }),
      };
    }

    case "credit": {
      const terms = go(() =>
        ew.createLoanTerms({
          principal: item.principal,
          rateBasisPoints: item.rateBasisPoints,
          periods: item.periods,
          method: item.method,
          rounding: item.rounding,
          lateFeeBasisPoints: item.lateFeeBp,
          gracePeriods: item.gracePeriods,
        }),
      );
      if (typeof terms === "string") return { terms };

      const opened = go(() =>
        ew.openLoan(engine, "L", terms, acct("ben", 0), {
          now: NOW,
          operationId: "open",
          reason: "open",
        }),
      );
      if (typeof opened === "string") return { terms: "ok", opened };
      let loan = opened.loan;
      if (item.missed > 0) loan = go(() => ew.chargeLateFee(loan, item.missed)) ?? loan;
      if (typeof loan === "string") return { terms: "ok", opened: "ok", fee: loan };

      const borrower = acct("ben", 1_000_000_000);
      const steps = [];
      for (const payment of item.payments) {
        const outcome = go(() =>
          ew.repay(engine, loan, borrower, payment, {
            now: NOW,
            operationId: `p${steps.length}`,
            reason: "pay",
          }),
        );
        if (typeof outcome === "string") {
          steps.push(outcome);
          break;
        }
        loan = outcome.loan;
        steps.push([
          outcome.toFees,
          outcome.toInterest,
          outcome.toPrincipal,
          outcome.instalmentsCleared,
          outcome.settled,
        ]);
      }

      return {
        terms: "ok",
        opened: "ok",
        disbursed: opened.booking.posting.amount,
        totalPayable: opened.loan.schedule.totalPaid,
        steps,
        outstandingPrincipal: loan.principalOutstanding,
        outstandingInterest: loan.interestOutstanding,
        fees: loan.feesOutstanding,
        state: loan.state,
        quote: go(() => ew.settlementQuote(loan, item.rebateBp)),
        writeOff: go(() => {
          const out = ew.writeOff(engine, loan, {
            now: NOW,
            operationId: "wo",
            reason: "wo",
          });
          return out.booking === null ? 0 : out.booking.posting.amount;
        }),
      };
    }

    case "instrument": {
      const share = ew.createInstrument("ACME", ew.InstrumentKind.Share, CURRENCY);
      let position = ew.openPosition(ref("ana"), share);
      const holder = acct("ana", 1_000_000_000_000);
      const steps = [];
      for (const trade of item.trades) {
        const outcome = go(() =>
          trade.side === "BUY"
            ? ew.buyUnits(engine, share, position, holder, trade.units, trade.unitPrice, {
                now: NOW,
                operationId: `t${steps.length}`,
                reason: "t",
              })
            : ew.sellUnits(engine, share, position, holder, trade.units, trade.unitPrice, {
                now: NOW,
                operationId: `t${steps.length}`,
                reason: "t",
              }),
        );
        if (typeof outcome === "string") {
          steps.push(outcome);
          continue;
        }
        position = outcome.position;
        steps.push([outcome.consideration, outcome.realisedGain]);
      }

      const bond = go(() =>
        ew.createInstrument("GOV", ew.InstrumentKind.Bond, CURRENCY, {
          faceValue: item.faceValue,
          couponBasisPoints: item.couponBp,
        }),
      );
      const positions = item.holders.map((units, index) => ({
        holder: ref(`h${index}`),
        instrumentId: "ACME",
        units,
        costBasis: 0,
        realisedGain: 0,
      }));

      return {
        steps,
        position: positionOf(position),
        averageCost: ew.averageCost(position),
        valuation: go(() => {
          const v = ew.valuePosition(position, item.valuationPrice);
          return [v.marketValue, v.unrealisedGain];
        }),
        coupon:
          typeof bond === "string"
            ? bond
            : go(() => ew.couponDue(bond, item.couponUnits, item.couponPeriods)),
        dividend: go(() =>
          ew.distributeDividend(positions, item.dividend).map((share_) => share_.amount),
        ),
      };
    }

    case "market": {
      let book = [];
      const results = [];
      for (const spec of item.orders) {
        const order = go(() =>
          ew.createOrder(
            spec.orderId,
            ref(spec.owner),
            "ACME",
            spec.side,
            spec.unitPrice,
            spec.quantity,
            spec.placedAt,
          ),
        );
        if (typeof order === "string") {
          results.push(order);
          continue;
        }
        const match = go(() => ew.matchOrder(order, book));
        if (typeof match === "string") {
          results.push(match);
          continue;
        }
        book = match.book;
        results.push(match.fills.map(fillOf));
      }

      let auction = go(() =>
        ew.openAuction({
          auctionId: "a1",
          seller: ref("seller"),
          subject: "sword",
          currency: CURRENCY,
          reserve: item.reserve,
          openedAt: NOW,
          endsAt: NOW + 10_000,
          minIncrement: item.minIncrement,
          reserveHidden: item.reserveHidden,
        }),
      );
      const bidResults = [];
      if (typeof auction !== "string") {
        for (const bid of item.bids) {
          const next = go(() =>
            ew.placeBid(
              auction,
              {
                bidder: ref(bid.bidder),
                amount: bid.amount,
                placedAt: bid.placedAt,
                bidId: bid.bidId,
              },
              bid.placedAt,
            ),
          );
          if (typeof next === "string") {
            bidResults.push(next);
          } else {
            auction = next;
            bidResults.push("ok");
          }
        }
      }
      const closed =
        typeof auction === "string"
          ? auction
          : go(() => {
              const outcome = ew.closeAuction(auction, NOW + 20_000);
              return [
                outcome.auction.state,
                outcome.winner === null ? null : outcome.winner.bidId,
                outcome.price,
              ];
            });

      return {
        fills: results,
        book: book.map(orderOf),
        bestBid: (() => {
          const found = ew.bestBid(book, "ACME");
          return found === null ? null : found.unitPrice;
        })(),
        bestAsk: (() => {
          const found = ew.bestAsk(book, "ACME");
          return found === null ? null : found.unitPrice;
        })(),
        spread: ew.spread(book, "ACME"),
        depth: [
          ew.bookDepth(book, "ACME", ew.OrderSide.Buy),
          ew.bookDepth(book, "ACME", ew.OrderSide.Sell),
        ],
        bids: bidResults,
        closed,
        exchanged: go(() => {
          const other = ew.memberAccount(SCOPE, "ana", "SILVER");
          const engine2 = new ew.EconomyEngine({
            currencies: [
              ew.createCurrency({ code: CURRENCY }),
              ew.createCurrency({ code: "SILVER" }),
            ],
          });
          const out = ew.exchange(
            engine2,
            acct("ana", 1_000_000_000),
            ew.account(other, 0),
            item.exchangeAmount,
            item.rateNumerator,
            item.rateDenominator,
            { now: NOW, operationId: "x", reason: "x", rounding: item.rounding },
          );
          return out.received;
        }),
      };
    }

    case "billing": {
      const plan = go(() =>
        ew.createPlan({
          planId: "p1",
          payer: ref("ana"),
          payee: ref("guild"),
          amount: item.amountPer,
          intervalMs: item.intervalMs,
          occurrences: item.occurrences,
        }),
      );
      if (typeof plan === "string") return { plan };

      let subscription = ew.startSubscription("s1", plan, NOW);
      if (item.pauseAtMs !== null) {
        const paused = go(() => ew.pauseSubscription(subscription, NOW + item.pauseAtMs));
        if (typeof paused !== "string") {
          subscription = paused;
          const resumed = go(() =>
            ew.resumeSubscription(
              subscription,
              NOW + Math.max(item.pauseAtMs, item.resumeAtMs),
            ),
          );
          if (typeof resumed !== "string") subscription = resumed;
        }
      }
      const at = NOW + item.elapsedMs;
      const due = go(() => ew.chargesDue(subscription, at));
      const charged = go(() => {
        const out = ew.chargeSubscription(engine, subscription, acct("ana", 10_000_000_000), {
          now: at,
          operationId: "c1",
          reason: "c",
        });
        return [
          out.charges,
          out.amount,
          out.subscription.state,
          out.booking === null ? null : out.booking.posting.amount,
        ];
      });

      return {
        plan: "ok",
        due,
        charged,
        nextAt: go(() => {
          const next = ew.nextChargeAt(subscription);
          return next === null ? null : next - NOW;
        }),
        payroll: go(() =>
          ew
            .splitPayroll(
              item.payrollTotal,
              Array.from({ length: item.recipients }, (unused, i) => ref(`r${i}`)),
              item.weights,
            )
            .map((line) => line.amount),
        ),
      };
    }

    case "reporting": {
      const postings = [];
      item.mints.forEach((value, index) => {
        postings.push(
          engine.credit(acct("ana", 0), value, {
            now: NOW,
            operationId: `m${index}`,
            reason: "mint",
          }).posting,
        );
      });
      item.transfers.forEach((value, index) => {
        const out = go(() =>
          engine.transfer(acct("ana", 10_000_000_000), acct("ben", 0), value, {
            now: NOW,
            operationId: `t${index}`,
            reason: "move",
          }),
        );
        if (typeof out !== "string") postings.push(out.posting);
      });

      const tb = ew.trialBalance(postings);
      const supply = ew.moneySupply(postings, SCOPE, CURRENCY);
      const statement = ew.statementFor(postings, ref("ana"));
      const balances = {};
      item.balances.forEach((value, index) => {
        balances[`${SCOPE}/m${index}/${CURRENCY}`] = value;
      });
      const distribution = ew.wealthDistribution(balances);

      return {
        trial: [tb.postings, tb.total, tb.balances, tb.duplicates.length],
        supply: [supply.issued, supply.retired, supply.circulating, supply.heldByMembers],
        statement: [
          statement.lines.length,
          statement.closingBalance,
          statement.totalIn,
          statement.totalOut,
        ],
        distribution: [
          distribution.holders,
          distribution.total,
          distribution.median,
          distribution.mean,
          distribution.giniPermille,
        ],
        top: ew.topHolders(balances, item.limit).map(([key, value]) => [key, value]),
        turnover: ew.turnoverByKind(postings),
      };
    }

    default:
      throw new Error(`unknown case kind: ${item.kind}`);
  }
}

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };

  const input = JSON.parse(readFileSync(flag("cases", join(HERE, "cases.json")), "utf8"));
  const out = flag("out", join(HERE, "results-typescript.json"));

  const results = input.cases.map((item) => {
    try {
      return { id: item.id, kind: item.kind, value: answer(item) };
    } catch (error) {
      return { id: item.id, kind: item.kind, error: error.constructor.name };
    }
  });

  writeFileSync(
    out,
    `${JSON.stringify({ formatVersion: input.formatVersion, seed: input.seed, edition: "typescript", results })}\n`,
    "utf8",
  );
  console.log(`typescript answered ${results.length} cases -> ${out}`);
}

main();
