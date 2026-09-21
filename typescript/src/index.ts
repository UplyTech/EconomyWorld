/**
 * @uplytech/economyworld
 *
 * Balances, bookings, inventories and trades as a rule set — calculated, never
 * stored.
 *
 * Play money only: no real currency, no payout, no payment provider, no random
 * payouts. See the README for why each of those is deliberately absent.
 */

export { EconomyEngine, createEarnRule, createEarnState, cloneEarnState, serializeEarnState, deserializeEarnState } from "./engine.js";

export {
  SystemAccount,
  memberAccount,
  systemAccount,
  isSystemAccount,
  accountKey,
  parseAccountKey,
  sameAccount,
  account,
  emptyAccount,
} from "./accounts.js";
export type { Account, AccountRef } from "./accounts.js";

export {
  createCurrency,
  splitMinorUnits,
  applyPermille,
  applyBasisPoints,
  applyRate,
  distribute,
  distributeEvenly,
  assertWholeAmount,
  assertPositiveAmount,
} from "./money.js";
export type { MinorUnits } from "./money.js";
export type { Currency, CurrencyInput } from "./money.js";

export { Rounding, divideRounded, divideExactRounded } from "./rounding.js";

export { mulExact, mulDivTrunc, mulModExact, fitsSafely, toNumber } from "./exact.js";

export {
  PostingKind,
  createPosting,
  isBalanced,
  assertBalanced,
  netChange,
  resultingBalances,
  serializePosting,
  deserializePosting,
  InMemoryOperationLog,
} from "./ledger.js";
export type { Posting, PostingLine, PostingInput } from "./ledger.js";

export {
  Inventory,
  createItem,
  addItem,
  removeItem,
  moveItem,
  applyChanges,
} from "./inventory.js";
export type {
  Item,
  ItemInput,
  InventorySlot,
  InventoryDelta,
  InventoryChange,
} from "./inventory.js";

export { createOffer, purchase, isAvailable, maxPurchasable } from "./shop.js";
export type { Offer, OfferInput, PurchaseInput, PurchaseResult } from "./shop.js";

export {
  TradeState,
  proposeTrade,
  acceptTrade,
  revokeAcceptance,
  cancelTrade,
  expireTrade,
  settleTrade,
  isOpen,
  isFinal,
} from "./trade.js";
export type {
  Trade,
  TradeSide,
  TradeProposal,
  TradeSettlement,
  TradeSettlementInput,
} from "./trade.js";

export {
  MAX_BALANCE,
  VERSION,
  MIN_BALANCE,
  PERMILLE_ONE,
  DEFAULT_PERIOD_SECONDS,
  MAX_ITEM_QUANTITY,
  DEFAULT_TRADE_TTL_SECONDS,
  SYSTEM_OWNER_PREFIX,
  BASIS_POINTS_ONE,
} from "./constants.js";

export {
  EconomyError,
  ConfigurationError,
  ValidationError,
  InvalidAmountError,
  InsufficientFundsError,
  BalanceOverflowError,
  CurrencyMismatchError,
  UnknownReferenceError,
  DuplicateOperationError,
  UnbalancedPostingError,
  ItemError,
  InsufficientQuantityError,
  OfferError,
  TradeStateError,
  ReversalError,
  RateError,
  HoldError,
  DepositError,
  LoanStateError,
  CreditLimitError,
  InstrumentError,
  OrderError,
  AuctionStateError,
  ScheduleError,
} from "./errors.js";

export { EarnOutcome } from "./types.js";
export type {
  BookingOptions,
  BookingResult,
  DecayResult,
  DecayRule,
  EarnResult,
  EarnRule,
  EarnRuleInput,
  EarnState,
  EconomyConfig,
  EconomyConfigInput,
} from "./types.js";

import { EconomyEngine as _EconomyEngine } from "./engine.js";
export default _EconomyEngine;

// ---------------------------------------------------------------------------
// The financial system: interest, banking, credit, instruments, markets,
// recurring money, fees and reporting.
// ---------------------------------------------------------------------------

export {
  AccrualBasis,
  AmortisationMethod,
  MAX_PERIODS,
  schedulePeriods,
  accrueInterest,
  projectBalance,
  levelPayment,
  amortisationSchedule,
  totalInterest,
  outstandingAfter,
} from "./interest.js";
export type { Instalment, AmortisationSchedule } from "./interest.js";

export {
  createDepositTerms,
  openDeposit,
  deposit,
  withdraw,
  accrueDepositInterest,
  depositBalance,
  isMature,
  maturityValue,
  earlyWithdrawalPenalty,
  placeHold,
  placeInEscrow,
  releaseFromEscrow,
  settleFromEscrow,
  releaseHold,
  captureHold,
  activeHolds,
  heldAmount,
  availableBalance,
} from "./bank.js";
export type { DepositTerms, Deposit, Hold } from "./bank.js";

export {
  LoanState,
  createLoanTerms,
  openLoan,
  repay,
  settlementQuote,
  settleEarly,
  chargeLateFee,
  writeOff,
  amountDue,
  isInArrears,
  nextInstalment,
  assertWithinCreditLimit,
  outstanding,
  totalOutstanding,
  isClosed,
} from "./credit.js";
export type { LoanTerms, Loan, RepaymentResult } from "./credit.js";

export {
  InstrumentKind,
  MAX_UNITS,
  createInstrument,
  openPosition,
  buyUnits,
  sellUnits,
  valuePosition,
  valuePortfolio,
  unrealisedGain,
  averageCost,
  couponDue,
  payCoupon,
  distributeDividend,
} from "./instruments.js";
export type { Instrument, Position, Valuation, TradeOutcome } from "./instruments.js";

export {
  OrderSide,
  OrderState,
  AuctionState,
  createOrder,
  matchOrder,
  cancelOrder,
  bestBid,
  bestAsk,
  spread,
  bookDepth,
  settleFill,
  exchange,
  openAuction,
  placeBid,
  closeAuction,
  settleAuction,
  highestBid,
  remaining,
  isActive,
  filledQuantity,
  totalConsideration,
} from "./market.js";
export type { Order, Fill, MatchResult, Bid, Auction, AuctionOutcome } from "./market.js";

export {
  ScheduleState,
  MAX_CATCH_UP,
  createPlan,
  startSubscription,
  chargesDue,
  nextChargeAt,
  chargeSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  financePurchase,
  runPayroll,
  splitPayroll,
  isSubscriptionActive,
  totalPayable,
  costOfCredit,
} from "./billing.js";
export type {
  RecurringPlan,
  Subscription,
  ChargeResult,
  InstalmentPlan,
  PayrollLine,
} from "./billing.js";

export {
  MAX_FEE_BASIS_POINTS,
  isFree,
  FeeMode,
  createFeeRule,
  createTier,
  quoteFee,
  chargeFee,
  splitFee,
  totalOf,
} from "./tax.js";
export type { FeeTier, FeeRule, FeeQuote } from "./tax.js";

export {
  trialBalance,
  assertBooksClose,
  accountBalances,
  moneySupply,
  statementFor,
  turnoverByKind,
  wealthDistribution,
  topHolders,
  giniPermille,
} from "./reporting.js";
export type {
  TrialBalance,
  MoneySupply,
  StatementLine,
  Statement,
  Distribution,
} from "./reporting.js";
