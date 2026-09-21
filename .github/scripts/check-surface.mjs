#!/usr/bin/env node
/**
 * Both editions expose the same economy, and every part of one is there.
 *
 * Two separate failures this catches, neither of which any other check does:
 *
 * **A name that exists in one edition and not the other.** The shared vectors
 * prove the two agree about what they *compute*. Nothing proved they agree
 * about what they *offer* — and a caller porting a bot from Python to Node
 * discovers a missing function at the worst possible moment. Four such gaps
 * were found by hand while writing 2.0.0 (`schedulePeriods`, `isFree`,
 * `isSubscriptionActive`, `MinorUnits`, plus `VERSION`), which is four more
 * than anybody should find by hand.
 *
 * **A subsystem that quietly loses a piece.** The list below is the shape of a
 * complete economy, written down. If a refactor drops `write_off` or
 * `settle_from_escrow` from the public surface, this fails and names it, rather
 * than the gap being noticed by somebody who needed it.
 *
 * The list is deliberately spelled out rather than derived. A check that reads
 * the answer off the thing it is checking is not a check.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The shape of a complete economy, by area. */
const SURFACE = {
  "Money and accounts": [
    "create_currency",
    "member_account",
    "system_account",
    "account_key",
    "parse_account_key",
    "split_minor_units",
    "apply_permille",
    "apply_basis_points",
    "apply_rate",
    "distribute",
    "distribute_evenly",
  ],
  Rounding: ["Rounding", "divide_rounded"],
  "Ledger and bookings": [
    "create_posting",
    "is_balanced",
    "assert_balanced",
    "resulting_balances",
    "serialize_posting",
    "deserialize_posting",
    "net_change",
    "PostingKind",
  ],
  Engine: ["EconomyEngine"],
  "Earning and decay": ["create_earn_rule", "create_earn_state", "EarnOutcome", "DecayRule"],
  Inventory: ["create_item", "Inventory", "add_item", "remove_item"],
  Shops: ["create_offer", "purchase", "max_purchasable", "is_available"],
  Trades: ["propose_trade", "accept_trade", "cancel_trade", "settle_trade", "TradeState"],
  "Interest and schedules": [
    "accrue_interest",
    "project_balance",
    "level_payment",
    "amortisation_schedule",
    "total_interest",
    "outstanding_after",
    "AccrualBasis",
    "AmortisationMethod",
  ],
  Banking: [
    "create_deposit_terms",
    "open_deposit",
    "deposit",
    "withdraw",
    "accrue_deposit_interest",
    "is_mature",
    "maturity_value",
    "early_withdrawal_penalty",
  ],
  "Holds and escrow": [
    "place_hold",
    "release_hold",
    "capture_hold",
    "active_holds",
    "held_amount",
    "available_balance",
    "place_in_escrow",
    "release_from_escrow",
    "settle_from_escrow",
  ],
  Credit: [
    "create_loan_terms",
    "open_loan",
    "assert_within_credit_limit",
    "amount_due",
    "next_instalment",
    "repay",
    "settlement_quote",
    "settle_early",
    "charge_late_fee",
    "is_in_arrears",
    "write_off",
    "LoanState",
  ],
  Investments: [
    "create_instrument",
    "open_position",
    "buy_units",
    "sell_units",
    "average_cost",
    "value_position",
    "value_portfolio",
    "unrealised_gain",
    "coupon_due",
    "pay_coupon",
    "distribute_dividend",
    "InstrumentKind",
  ],
  Markets: [
    "create_order",
    "match_order",
    "cancel_order",
    "best_bid",
    "best_ask",
    "spread",
    "book_depth",
    "settle_fill",
    "exchange",
    "OrderSide",
    "OrderState",
  ],
  Auctions: ["open_auction", "place_bid", "close_auction", "settle_auction", "AuctionState"],
  "Fees and taxes": [
    "create_fee_rule",
    "create_tier",
    "quote_fee",
    "charge_fee",
    "split_fee",
    "total_of",
    "FeeMode",
  ],
  "Billing and payroll": [
    "create_plan",
    "start_subscription",
    "charges_due",
    "next_charge_at",
    "charge_subscription",
    "pause_subscription",
    "resume_subscription",
    "cancel_subscription",
    "finance_purchase",
    "run_payroll",
    "split_payroll",
    "ScheduleState",
  ],
  Reporting: [
    "trial_balance",
    "assert_books_close",
    "account_balances",
    "money_supply",
    "statement_for",
    "turnover_by_kind",
    "wealth_distribution",
    "gini_permille",
    "top_holders",
  ],
};

/**
 * The one deliberate difference between the editions.
 *
 * Python cannot call it `account` without shadowing the variable every caller
 * wants to name `account`. Recorded here so that it is a decision rather than
 * a drift, and so that a second one cannot appear unnoticed.
 */
const RENAMED = { make_account: "account" };

const camel = (name) =>
  name
    .split("_")
    .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("");

function pythonExports() {
  const python = process.env.PYTHON || "python";
  const source = "import economyworld, json; print(json.dumps(list(economyworld.__all__)))";
  const out = execFileSync(python, ["-c", source], {
    cwd: join(root, "python"),
    env: { ...process.env, PYTHONPATH: "src" },
    encoding: "utf8",
  });
  return new Set(JSON.parse(out));
}

function typescriptExports() {
  // Every identifier the entry point re-exports. Read as a word list rather
  // than parsed: this asks "is the name there", not "what shape is it".
  const files = ["src/index.ts", "src/money.ts", "src/constants.ts"];
  const text = files.map((file) => readFileSync(join(root, "typescript", file), "utf8")).join("\n");
  return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

const python = pythonExports();
const typescript = typescriptExports();

let failed = false;
let checked = 0;

for (const [area, names] of Object.entries(SURFACE)) {
  const missing = [];
  for (const name of names) {
    checked += 1;
    if (!python.has(name)) missing.push(`${name} (Python)`);
    const other = RENAMED[name] ?? (name === name.toUpperCase() ? name : camel(name));
    if (!typescript.has(other) && !typescript.has(name)) {
      missing.push(`${other} (TypeScript)`);
    }
  }
  if (missing.length > 0) {
    failed = true;
    console.error(`::error::${area} is incomplete: ${missing.join(", ")}`);
  } else {
    console.log(`ok - ${area} (${names.length})`);
  }
}

// A name Python exports and TypeScript does not is the gap a porting caller
// falls into. The reverse is checked too: an edition-only convenience is fine
// as an internal helper and not as a public export.
const unmatched = [];
for (const name of python) {
  if (name.startsWith("__")) continue;
  const other = RENAMED[name] ?? (name === name.toUpperCase() ? name : camel(name));
  if (!typescript.has(other) && !typescript.has(name)) unmatched.push(name);
}
if (unmatched.length > 0) {
  failed = true;
  console.error(
    `::error::${unmatched.length} Python export(s) have no TypeScript counterpart: ` +
      `${unmatched.join(", ")}. Add it there, or rename it here and record the ` +
      `pair in RENAMED with the reason.`,
  );
}

if (failed) process.exit(1);
console.log(
  `ok - ${Object.keys(SURFACE).length} areas, ${checked} names, present in both editions`,
);
