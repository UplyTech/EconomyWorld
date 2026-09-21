/**
 * Things a member can hold besides currency: bonds, shares, units in a fund.
 *
 * # This package has no prices, and that is the design
 *
 * **Every price here is an argument.** There is no market model, no volatility,
 * no drift, no random walk. When a member buys, the caller says what a unit
 * costs; when a portfolio is valued, the caller says what a unit is worth today.
 *
 * That is not a gap to be filled in a later version. A holding whose value moves
 * by chance is a wager, and several EU jurisdictions treat a wager as gambling
 * whether or not real money is involved — the same reason this package has no
 * loot boxes and no random payouts. A product that wants prices to move builds
 * and legally reviews that mechanism itself; what it gets from here is the
 * arithmetic of holding, valuing and settling, which is the part that is easy to
 * get subtly wrong.
 *
 * A **bond** is the exception that proves it: its coupon is fixed in its terms,
 * so its return is knowable in advance. That is why it is the one instrument
 * this module can pay out on by itself.
 *
 * # Cost is averaged, and a part sale takes its share exactly
 *
 * A member who bought 100 units at 10 and 100 more at 20 holds 200 units that
 * cost 3000. Selling 50 removes `3000 * 50 / 200` of the cost — computed
 * exactly, with the remainder staying on the position, so a series of part sales
 * can never leave a cost basis that does not match the units held.
 *
 * Average cost rather than FIFO because it needs no lot history: a caller
 * storing one row per position can compute a correct gain, and one storing every
 * purchase separately can still do FIFO itself on top.
 */
import {
  type Account,
  type AccountRef,
  SystemAccount,
  accountKey,
  emptyAccount,
  systemAccount,
} from "./accounts.js";
import type { EconomyEngine } from "./engine.js";
import {
  ConfigurationError,
  CurrencyMismatchError,
  InstrumentError,
  ValidationError,
} from "./errors.js";
import { PostingKind } from "./ledger.js";
import {
  applyBasisPoints,
  applyRate,
  assertWholeAmount,
  distribute,
} from "./money.js";
import { Rounding } from "./rounding.js";
import type { BookingResult } from "./types.js";

/**
 * Most units of one instrument a single position may hold.
 *
 * Well inside the range where `units * price` stays exact, so a valuation cannot
 * overflow through quantity alone.
 */
export const MAX_UNITS = 1_000_000_000;

/** What sort of thing is being held. */
export enum InstrumentKind {
  /**
   * Pays a fixed coupon and returns its face value at maturity. The only kind
   * this module can pay out on unaided, because its return is written into its
   * terms rather than discovered in a market.
   */
  Bond = "BOND",
  /**
   * A share in something. Worth what the caller says it is worth, and may
   * receive a dividend the caller declares.
   */
  Share = "SHARE",
  /** A quantity of a good. Same rule: the price is the caller's. */
  Commodity = "COMMODITY",
  /** A unit in a pooled holding. */
  Fund = "FUND",
}

/** Something that can be held, priced and settled. */
export interface Instrument {
  readonly instrumentId: string;
  readonly kind: InstrumentKind;
  readonly name: string;
  /**
   * What it is priced and settled in. A position and its instrument must agree,
   * or a sale would credit the wrong currency.
   */
  readonly currency: string;
  /** For a bond: what one unit repays at maturity. Zero for everything else. */
  readonly faceValue: number;
  /**
   * For a bond: what one unit pays each coupon period, in basis points of the
   * face value. Zero for everything else.
   */
  readonly couponBasisPoints: number;
  /** Free-form context for the caller's own display. */
  readonly metadata?: Record<string, string>;
}

/** What one member holds of one instrument. */
export interface Position {
  readonly holder: AccountRef;
  readonly instrumentId: string;
  readonly units: number;
  /**
   * Everything paid for the units still held, less what part sales took with
   * them. Divided by `units` it is the average cost.
   */
  readonly costBasis: number;
  /**
   * Gains and losses already crystallised by selling. Kept so a statement can
   * show performance without replaying every trade.
   */
  readonly realisedGain: number;
}

/** What a holding is worth at a price the caller supplied. */
export interface Valuation {
  readonly instrumentId: string;
  readonly units: number;
  readonly unitPrice: number;
  readonly marketValue: number;
  readonly costBasis: number;
  /** Market value less cost. Negative is a loss. */
  readonly unrealisedGain: number;
}

/** What buying or selling did. Write both parts in one transaction. */
export interface TradeOutcome {
  /**
   * A grant, an airdrop of founder shares, a bond handed out as a prize: units
   * really can change hands for nothing. There is no posting to make when they
   * do — a zero-amount posting is not a thing this ledger will write — so the
   * booking comes back as `null`, exactly as a zero fee does.
   */
  readonly booking: BookingResult | null;
  readonly position: Position;
  readonly units: number;
  readonly unitPrice: number;
  readonly consideration: number;
  /** What this sale crystallised. Zero for a purchase. */
  readonly realisedGain: number;
}

/** Build a validated instrument. */
export function createInstrument(
  instrumentId: string,
  kind: InstrumentKind,
  currency: string,
  options: {
    name?: string;
    faceValue?: number;
    couponBasisPoints?: number;
    metadata?: Record<string, string>;
  } = {},
): Instrument {
  const faceValue = options.faceValue ?? 0;
  const couponBasisPoints = options.couponBasisPoints ?? 0;

  if (typeof instrumentId !== "string" || instrumentId.length === 0) {
    throw new ConfigurationError("An instrument needs a non-empty id", {
      instrumentId,
    });
  }
  if (typeof currency !== "string" || currency.length === 0) {
    throw new ConfigurationError("An instrument needs a currency", {
      currency,
    });
  }
  assertWholeAmount(faceValue);
  if (faceValue < 0) {
    throw new ConfigurationError("A face value cannot be negative", {
      faceValue,
    });
  }
  if (!Number.isSafeInteger(couponBasisPoints) || couponBasisPoints < 0) {
    throw new ConfigurationError(
      "A coupon must be a non-negative integer number of basis points",
      { couponBasisPoints },
    );
  }
  if (
    kind !== InstrumentKind.Bond &&
    (faceValue !== 0 || couponBasisPoints !== 0)
  ) {
    throw new ConfigurationError(
      "Only a bond has a face value and a coupon: for anything else the price is the caller's to supply",
      { kind },
    );
  }
  if (kind === InstrumentKind.Bond && faceValue <= 0) {
    throw new ConfigurationError("A bond needs a positive face value", {
      instrumentId,
    });
  }

  return {
    instrumentId,
    kind,
    name: options.name ?? instrumentId,
    currency,
    faceValue,
    couponBasisPoints,
    metadata: options.metadata,
  };
}

/** An empty holding, before anything has been bought. */
export function openPosition(
  holder: AccountRef,
  instrument: Instrument,
): Position {
  if (holder.currency !== instrument.currency) {
    throw new CurrencyMismatchError({
      expected: instrument.currency,
      received: holder.currency,
    });
  }
  return {
    holder,
    instrumentId: instrument.instrumentId,
    units: 0,
    costBasis: 0,
    realisedGain: 0,
  };
}

/**
 * Buy units at a price the caller supplies.
 *
 * `unitPrice` is an argument and always will be. See this module's opening note
 * for why.
 *
 * The currency goes to `counterparty` if one is given — another member, in a
 * peer-to-peer sale — and otherwise to the scope's market account, which is
 * where an issuance from the community itself is paid.
 */
export function buyUnits(
  engine: EconomyEngine,
  instrument: Instrument,
  position: Position,
  buyer: Account,
  units: number,
  unitPrice: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    counterparty?: Account;
    metadata?: Record<string, string>;
  },
): TradeOutcome {
  assertUnits(units);
  assertPrice(unitPrice);
  assertPosition(position, instrument, buyer);
  assertTimestamp(options.now);

  if (position.units + units > MAX_UNITS) {
    throw new InstrumentError(
      "That would take the position past the unit ceiling",
      {
        units: position.units,
        buying: units,
        limit: MAX_UNITS,
      },
    );
  }

  const consideration = considerationFor(units, unitPrice);
  const booking =
    consideration === 0
      ? null
      : engine.transfer(
          buyer,
          options.counterparty ??
            emptyAccount(
              systemAccount(
                buyer.ref.scope,
                instrument.currency,
                SystemAccount.Market,
              ),
            ),
          consideration,
          {
            now: options.now,
            operationId: options.operationId,
            reason: options.reason,
            kind: PostingKind.Exchange,
            // The source here is the buyer. Whoever they are buying from, they pay
            // with currency they hold: no overdraft, no buying on margin.
            allowNegative: false,
            metadata: options.metadata,
          },
        );

  return {
    booking,
    position: {
      ...position,
      units: position.units + units,
      costBasis: position.costBasis + consideration,
    },
    units,
    unitPrice,
    consideration,
    realisedGain: 0,
  };
}

/**
 * Sell units at a price the caller supplies.
 *
 * The cost that leaves with the units is their exact share of the position's
 * cost basis, so selling everything always leaves a cost basis of zero and a
 * realised gain equal to every gain and loss along the way. Rounding cannot
 * strand a few units of cost on an empty position.
 */
export function sellUnits(
  engine: EconomyEngine,
  instrument: Instrument,
  position: Position,
  seller: Account,
  units: number,
  unitPrice: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    counterparty?: Account;
    metadata?: Record<string, string>;
  },
): TradeOutcome {
  assertUnits(units);
  assertPrice(unitPrice);
  assertPosition(position, instrument, seller);
  assertTimestamp(options.now);

  if (units > position.units) {
    throw new InstrumentError("That position does not hold that many units", {
      held: position.units,
      selling: units,
    });
  }

  const consideration = considerationFor(units, unitPrice);
  // The exact share of the cost, so a full sale always clears the basis.
  const costReleased =
    units === position.units
      ? position.costBasis
      : applyRate(position.costBasis, units, position.units, Rounding.Down);
  const gain = consideration - costReleased;

  const booking =
    consideration === 0
      ? null
      : engine.transfer(
          options.counterparty ??
            emptyAccount(
              systemAccount(
                seller.ref.scope,
                instrument.currency,
                SystemAccount.Market,
              ),
            ),
          seller,
          consideration,
          {
            now: options.now,
            operationId: options.operationId,
            reason: options.reason,
            kind: PostingKind.Exchange,
            allowNegative: options.counterparty === undefined,
            metadata: options.metadata,
          },
        );

  return {
    booking,
    position: {
      ...position,
      units: position.units - units,
      costBasis: position.costBasis - costReleased,
      realisedGain: position.realisedGain + gain,
    },
    units,
    unitPrice,
    consideration,
    realisedGain: gain,
  };
}

/** What one unit cost on average. Zero for an empty position. */
export function averageCost(position: Position): number {
  if (position.units === 0) return 0;
  return applyRate(position.costBasis, 1, position.units, Rounding.Down);
}

/** What a holding is worth at a price the caller supplies. */
export function valuePosition(
  position: Position,
  unitPrice: number,
): Valuation {
  assertPrice(unitPrice);
  const marketValue = position.units
    ? considerationFor(position.units, unitPrice)
    : 0;
  return {
    instrumentId: position.instrumentId,
    units: position.units,
    unitPrice,
    marketValue,
    costBasis: position.costBasis,
    unrealisedGain: marketValue - position.costBasis,
  };
}

/**
 * Value every holding a member has, at prices the caller supplies.
 *
 * A position whose instrument has no price is an error rather than a zero: a
 * portfolio total that quietly omitted a holding would be a number a member
 * makes decisions on and that is wrong.
 */
export function valuePortfolio(
  positions: readonly Position[],
  prices: Readonly<Record<string, number>>,
): Valuation[] {
  return positions.map((position) => {
    const price = prices[position.instrumentId];
    if (price === undefined) {
      throw new InstrumentError("No price was supplied for a held instrument", {
        instrumentId: position.instrumentId,
      });
    }
    return valuePosition(position, price);
  });
}

/** What a portfolio is up or down, before anything is sold. */
export function unrealisedGain(
  positions: readonly Position[],
  prices: Readonly<Record<string, number>>,
): number {
  return valuePortfolio(positions, prices).reduce(
    (sum, v) => sum + v.unrealisedGain,
    0,
  );
}

/**
 * What a bond pays its holder over `periods` coupon dates.
 *
 * Fixed by the bond's terms and knowable in advance, which is what separates it
 * from every other instrument here.
 */
export function couponDue(
  instrument: Instrument,
  units: number,
  periods = 1,
): number {
  if (instrument.kind !== InstrumentKind.Bond) {
    throw new InstrumentError("Only a bond pays a coupon", {
      instrumentId: instrument.instrumentId,
    });
  }
  assertUnits(units, true);
  if (!Number.isSafeInteger(periods) || periods < 0) {
    throw new ValidationError("periods must be a non-negative integer", {
      periods,
    });
  }
  if (units === 0 || periods === 0) return 0;
  const perUnit = applyBasisPoints(
    instrument.faceValue,
    instrument.couponBasisPoints,
    Rounding.Down,
  );
  const total = perUnit * units * periods;
  assertWholeAmount(total);
  return total;
}

/**
 * Pay a bond's coupon to its holder.
 *
 * Issued from the mint unless the caller names another source, exactly like
 * interest on a deposit and for the same reason: in a closed economy a payment
 * that is not funded by somebody is new currency, and the posting should say so.
 *
 * `null` when there is nothing to pay — no units, or a coupon too small to round
 * to a whole unit.
 */
export function payCoupon(
  engine: EconomyEngine,
  instrument: Instrument,
  position: Position,
  holder: Account,
  options: {
    now: number;
    operationId: string;
    reason: string;
    periods?: number;
    source?: Account;
    metadata?: Record<string, string>;
  },
): BookingResult | null {
  assertTimestamp(options.now);
  assertPosition(position, instrument, holder);
  const amount = couponDue(instrument, position.units, options.periods ?? 1);
  if (amount === 0) return null;
  return engine.transfer(
    options.source ??
      emptyAccount(
        systemAccount(
          holder.ref.scope,
          instrument.currency,
          SystemAccount.Mint,
        ),
      ),
    holder,
    amount,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Distribution,
      // The mint issues; a named payer pays out of its own balance.
      allowNegative: options.source === undefined,
      metadata: options.metadata,
    },
  );
}

/**
 * Split a declared dividend between holders, by units held, exactly.
 *
 * The amount is the caller's to declare — this module has no notion of profit
 * and will not invent one. What it guarantees is that the shares add up to the
 * declared total, so a community that declares 1000 pays out 1000 and not 999
 * with a unit lost to three-way rounding.
 *
 * Comes back as pairs rather than as postings: the caller books them, and which
 * account funds a dividend is a decision this module should not make.
 */
export function distributeDividend(
  positions: readonly Position[],
  total: number,
): { holder: AccountRef; amount: number }[] {
  assertWholeAmount(total);
  if (total < 0) {
    throw new ValidationError("A dividend cannot be negative", { total });
  }
  const holding = positions.filter((p) => p.units > 0);
  if (holding.length === 0) {
    throw new InstrumentError(
      "There is nobody holding units to pay a dividend to",
      {},
    );
  }
  const shares = distribute(
    total,
    holding.map((p) => p.units),
  );
  return holding.map((p, index) => ({
    holder: p.holder,
    amount: shares[index] as number,
  }));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function considerationFor(units: number, unitPrice: number): number {
  const total = units * unitPrice;
  assertWholeAmount(total);
  return total;
}

function assertUnits(units: number, allowZero = false): void {
  if (!Number.isSafeInteger(units)) {
    throw new ValidationError("units must be an integer", { units });
  }
  if (units < 0 || (units === 0 && !allowZero)) {
    throw new ValidationError("units must be positive", { units });
  }
  if (units > MAX_UNITS) {
    throw new InstrumentError("units is past the ceiling a position may hold", {
      units,
      limit: MAX_UNITS,
    });
  }
}

function assertPrice(unitPrice: number): void {
  assertWholeAmount(unitPrice);
  if (unitPrice < 0) {
    throw new ValidationError("A price cannot be negative", { unitPrice });
  }
}

function assertPosition(
  position: Position,
  instrument: Instrument,
  account: Account,
): void {
  if (position.instrumentId !== instrument.instrumentId) {
    throw new InstrumentError("The position and the instrument do not match", {
      position: position.instrumentId,
      instrument: instrument.instrumentId,
    });
  }
  if (accountKey(account.ref) !== accountKey(position.holder)) {
    throw new InstrumentError("That account does not hold this position", {
      holder: accountKey(position.holder),
      given: accountKey(account.ref),
    });
  }
  if (account.ref.currency !== instrument.currency) {
    throw new CurrencyMismatchError({
      expected: instrument.currency,
      received: account.ref.currency,
    });
  }
}

function assertTimestamp(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new ValidationError("Timestamps are epoch milliseconds as integers", {
      timestamp: now,
    });
  }
}
