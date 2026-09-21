"""A whole community economy, run for a year.

    PYTHONPATH=src python examples/financial_system.py

The other two examples show single operations. This one shows the parts working
together, because that is where the questions actually are: what does the bank
account hold, where did the interest come from, what is the credit account
supposed to say, and does the whole thing still add up at the end.

Nothing here is stored. The world below is a dictionary standing in for your
database, and every posting the library returns is applied to it the way a real
caller must apply one: **every line, in a single transaction**.

Its TypeScript twin, `typescript/examples/financial-system.ts`, prints the same
numbers. That is not a coincidence and it is not decorative -- if the two ever
diverged, that is a bug in the library, and the shared vectors would already
have gone red.
"""

from __future__ import annotations

from economyworld import (
    AmortisationMethod,
    EconomyEngine,
    InstrumentKind,
    LoanState,
    Posting,
    SystemAccount,
    account_balances,
    account_key,
    accrue_deposit_interest,
    amount_due,
    assert_books_close,
    buy_units,
    charge_fee,
    charge_subscription,
    create_currency,
    create_deposit_terms,
    create_fee_rule,
    create_instrument,
    create_loan_terms,
    create_plan,
    create_tier,
    deposit,
    make_account,
    member_account,
    money_supply,
    open_deposit,
    open_loan,
    open_position,
    quote_fee,
    repay,
    run_payroll,
    sell_units,
    split_payroll,
    start_subscription,
    statement_for,
    system_account,
    top_holders,
    trial_balance,
    wealth_distribution,
)
from economyworld.billing import PayrollLine

SCOPE = "guild-1"
COIN = "COIN"
DAY = 86_400_000
MONTH = 30 * DAY
START = 1_735_689_600_000  # 1 January 2025, as epoch milliseconds

MEMBERS = ("ana", "ben", "cai", "dee")


# ---------------------------------------------------------------------------
# The world: your database, standing in for itself
# ---------------------------------------------------------------------------


class World:
    """Balances the library never sees between calls.

    A real caller loads these from a database and writes them back inside one
    transaction. The point of the class is that ``apply`` refuses to write a
    posting whose ``balance_before`` disagrees with what the world holds -- a
    stale read is the failure this design is most exposed to, and it should be
    loud rather than silent.
    """

    def __init__(self) -> None:
        self.balances: dict[str, int] = {}
        self.postings: list[Posting] = []

    def account(self, owner: str):
        ref = member_account(SCOPE, owner, COIN)
        return make_account(ref, self.balances.get(account_key(ref), 0))

    def system(self, kind: SystemAccount):
        ref = system_account(SCOPE, COIN, kind)
        return make_account(ref, self.balances.get(account_key(ref), 0))

    def apply(self, posting: Posting | None) -> None:
        if posting is None:
            return
        for line in posting.lines:
            key = account_key(line.account)
            current = self.balances.get(key, 0)
            if current != line.balance_before:
                raise AssertionError(
                    f"stale read on {key}: world has {current}, "
                    f"the posting expected {line.balance_before}"
                )
            self.balances[key] = line.balance_after
        self.postings.append(posting)

    def of(self, owner: str) -> int:
        return self.balances.get(account_key(member_account(SCOPE, owner, COIN)), 0)

    def system_balance(self, kind: SystemAccount) -> int:
        return self.balances.get(account_key(system_account(SCOPE, COIN, kind)), 0)


def money(amount: int) -> str:
    """Two decimal places, from an integer. The library never formats."""
    sign = "-" if amount < 0 else ""
    whole, fraction = divmod(abs(amount), 100)
    return f"{sign}{whole:,}.{fraction:02d}"


def heading(text: str) -> None:
    print(f"\n{text}\n{'-' * len(text)}")


world = World()
engine = EconomyEngine(currencies=[create_currency(COIN, minor_units=2)])


# ---------------------------------------------------------------------------
# January: the guild pays its staff
# ---------------------------------------------------------------------------

heading("January - payroll")

# The treasury is funded by the mint, which is what "the guild issued currency"
# means on a double-entry ledger.
world.apply(
    engine.credit(
        world.account("treasury"),
        5_000_000,
        now=START,
        operation_id="mint-treasury",
        reason="opening float",
        source=world.system(SystemAccount.MINT),
    ).posting
)

wages = [PayrollLine(member_account(SCOPE, member, COIN), 120_000) for member in MEMBERS]
world.apply(
    run_payroll(
        engine,
        world.account("treasury"),
        wages,
        START,
        "payroll-jan",
        "January wages",
        recipients={
            account_key(line.recipient): world.account(line.recipient.owner) for line in wages
        },
    ).posting
)

print(f"treasury            {money(world.of('treasury')):>12}")
for member in MEMBERS:
    print(f"{member:<20}{money(world.of(member)):>12}")
print("\nOne posting, five lines. A payroll run either happens or it does not;")
print("half a payroll is the worst possible outcome.")


# ---------------------------------------------------------------------------
# February: ana saves, ben borrows
# ---------------------------------------------------------------------------

heading("February - a deposit and a loan")

savings = open_deposit(
    "savings-ana",
    member_account(SCOPE, "ana", COIN),
    create_deposit_terms(rate_basis_points=50),  # 0.5 % a month
    START + MONTH,
)
booking, savings = deposit(
    engine,
    savings,
    world.account("ana"),
    100_000,
    START + MONTH,
    "dep-ana",
    "ana saves",
    bank_account=world.system(SystemAccount.BANK),
)
world.apply(booking.posting)

booking, loan = open_loan(
    engine,
    "loan-ben",
    create_loan_terms(
        principal=240_000,
        rate_basis_points=100,  # 1 % a month
        periods=10,
        method=AmortisationMethod.EQUAL_INSTALMENT,
        late_fee_basis_points=200,
        grace_periods=1,
    ),
    world.account("ben"),
    START + MONTH,
    "loan-ben",
    "ben borrows for a workshop",
    credit_account=world.system(SystemAccount.CREDIT),
)
world.apply(booking.posting)

print(f"ana's balance       {money(world.of('ana')):>12}")
print(f"on deposit          {money(savings.balance):>12}   (in system:bank)")
print(f"ben's balance       {money(world.of('ben')):>12}")
print(
    f"ben owes            {money(loan.total_outstanding):>12}   over {len(loan.schedule.instalments)} instalments"
)
print(
    f"system:credit       {money(world.system_balance(SystemAccount.CREDIT)):>12}   <- what the guild has lent"
)


# ---------------------------------------------------------------------------
# The year: interest, repayments, a subscription
# ---------------------------------------------------------------------------

heading("March to December - the months pass")

plan = create_plan(
    "guild-membership",
    member_account(SCOPE, "cai", COIN),
    member_account(SCOPE, "treasury", COIN),
    2_500,
    MONTH,
)
subscription = start_subscription("sub-cai", plan, START + MONTH)

for month in range(2, 12):
    now = START + month * MONTH

    # The bank credits interest. It comes from the mint: in a closed economy a
    # payment nobody funds is new currency, and the posting says so.
    accrued, savings = accrue_deposit_interest(
        engine,
        savings,
        1,
        now,
        f"interest-{month}",
        "monthly interest",
        source=world.system(SystemAccount.MINT),
        bank_account=world.system(SystemAccount.BANK),
    )
    world.apply(None if accrued is None else accrued.posting)

    # Ben pays his instalment. Capital goes back to credit, interest to fees.
    if loan.state is LoanState.ACTIVE:
        result = repay(
            engine,
            loan,
            world.account("ben"),
            amount_due(loan),
            now,
            f"repay-{month}",
            f"instalment {loan.paid_instalments + 1}",
            credit_account=world.system(SystemAccount.CREDIT),
            fee_account=world.system(SystemAccount.FEE),
        )
        loan = result.loan
        world.apply(None if result.booking is None else result.booking.posting)

    # Cai's membership is charged for however many months have passed since the
    # last charge -- once each, however often this loop runs.
    charge = charge_subscription(
        engine,
        subscription,
        world.account("cai"),
        now,
        f"sub-{month}",
        "guild membership",
        payee=world.account("treasury"),
    )
    subscription = charge.subscription
    world.apply(None if charge.booking is None else charge.booking.posting)

print(
    f"ana on deposit      {money(savings.balance):>12}   (principal {money(savings.principal)})"
)
print(f"ben still owes      {money(loan.total_outstanding):>12}")
print(
    f"cai paid            {money(subscription.total_charged):>12}   over {subscription.charges_made} months"
)
print(
    f"system:fee          {money(world.system_balance(SystemAccount.FEE)):>12}   <- interest earned on the loan"
)


# ---------------------------------------------------------------------------
# December: dee buys a share, and the market takes a commission
# ---------------------------------------------------------------------------

heading("December - an investment, and what it costs")

share = create_instrument("guild-share", InstrumentKind.SHARE, COIN, "Guild share")
position = open_position(member_account(SCOPE, "dee", COIN), share)

# The price is ours to decide. The library will not invent one -- see the README.
outcome = buy_units(
    engine,
    share,
    position,
    world.account("dee"),
    20,
    2_500,
    START + 11 * MONTH,
    "buy-dee",
    "dee buys into the guild",
    counterparty=world.system(SystemAccount.MARKET),
)
position = outcome.position
world.apply(None if outcome.booking is None else outcome.booking.posting)

commission = create_fee_rule(
    "market-commission",
    tiers=[create_tier(0, 0), create_tier(10_000, 250)],  # free under 100.00, then 2.5 %
    minimum=0,
)
quote = quote_fee(commission, outcome.consideration)
print(f"dee bought          {position.units:>12} units at {money(2_500)} each")
print(f"consideration       {money(outcome.consideration):>12}")
print(
    f"commission quoted   {money(quote.fee):>12}   (nothing on the first {money(10_000)}, then 2.5 %)"
)
world.apply(
    charge_fee(
        engine,
        world.account("dee"),
        quote,
        START + 11 * MONTH,
        "fee-dee",
        "market commission",
        fee_account=world.system(SystemAccount.FEE),
    ).posting
)

# Later the same month, at a price the community set, dee sells half.
sold = sell_units(
    engine,
    share,
    position,
    world.account("dee"),
    10,
    3_100,
    START + 11 * MONTH + DAY,
    "sell-dee",
    "dee takes some profit",
    counterparty=world.system(SystemAccount.MARKET),
)
position = sold.position
world.apply(None if sold.booking is None else sold.booking.posting)
print(f"sold 10 at          {money(3_100):>12}  ->  realised {money(sold.realised_gain)}")
print(
    f"still holding       {position.units:>12} units, cost basis {money(position.cost_basis)}"
)


# A year-end bonus: a fixed pot rather than fixed salaries. The shares add up to
# the pot exactly, which is not automatic -- 1000 split three ways is 333 each
# and one unit left over, and somebody has to get it.
bonus = split_payroll(
    100_000,
    [member_account(SCOPE, member, COIN) for member in MEMBERS],
    weights=[3, 2, 2, 1],
)
world.apply(
    run_payroll(
        engine,
        world.account("treasury"),
        bonus,
        START + 11 * MONTH + 2 * DAY,
        "bonus-dec",
        "year-end bonus",
        recipients={
            account_key(line.recipient): world.account(line.recipient.owner) for line in bonus
        },
    ).posting
)
print(f"\nyear-end bonus of {money(100_000)} split 3:2:2:1")
for line in bonus:
    print(f"  {line.recipient.owner:<18}{money(line.amount):>12}")
assert sum(line.amount for line in bonus) == 100_000


# ---------------------------------------------------------------------------
# The year end: does it all add up?
# ---------------------------------------------------------------------------

heading("Year end - the books")

result = trial_balance(world.postings)
print(f"postings            {result.postings:>12}")
print(f"sum of every line   {result.total:>12}   <- zero, or something is wrong")
print(f"booked twice        {len(result.duplicates):>12}")
assert_books_close(world.postings)

supply = money_supply(world.postings, SCOPE, COIN)
print(f"\nissued              {money(supply.issued):>12}")
print(f"retired             {money(supply.retired):>12}")
print(f"circulating         {money(supply.circulating):>12}")
print(f"  held by members   {money(supply.held_by_members):>12}")
print(f"  held by system    {money(supply.held_by_system):>12}")
assert supply.circulating == supply.held_by_members + supply.held_by_system

print("\nsystem accounts")
for kind in (
    SystemAccount.MINT,
    SystemAccount.BANK,
    SystemAccount.CREDIT,
    SystemAccount.FEE,
    SystemAccount.MARKET,
):
    print(f"  {kind.value:<20}{money(world.system_balance(kind)):>12}")
assert world.system_balance(SystemAccount.CREDIT) == 0, "the loan was repaid in full"
assert world.system_balance(SystemAccount.BANK) == savings.balance

replayed = account_balances(world.postings)
assert all(world.balances[key] == balance for key, balance in replayed.items())
print("\nEvery balance in the world matches what the postings imply.")
print("That is the check to run nightly: if the two ever disagree, one of them")
print("is wrong, and you now know to look.")

distribution = wealth_distribution(world.balances)
print(f"\nholders             {distribution.holders:>12}")
print(f"median              {money(distribution.median):>12}")
print(f"mean                {money(distribution.mean):>12}")
print(
    f"gini (permille)     {distribution.gini_permille:>12}   0 = equal, 1000 = one member holds everything"
)

print("\ntop holders")
for key, balance in top_holders(world.balances, 3):
    print(f"  {key:<28}{money(balance):>12}")

print("\nben's statement")
statement = statement_for(world.postings, member_account(SCOPE, "ben", COIN))
for line in statement.lines[:4]:
    print(f"  {line.kind.value:<20}{money(line.delta):>12}   -> {money(line.balance_after)}")
print(f"  ... {len(statement.lines) - 4} more")
print(
    f"  in {money(statement.total_in)}, out {money(statement.total_out)}, closing {money(statement.closing_balance)}"
)


heading("What this example is really showing")

print(
    """\
Six subsystems ran against one ledger for a year: payroll, banking, credit,
billing, investments and fees. Nobody had to reconcile them against each other,
because they were never separate to begin with -- every one of them produced a
posting whose lines sum to zero, and the trial balance above is the proof.

Three numbers are worth looking at twice:

  system:credit reached zero as the loan was repaid. It is the amount the guild
  currently has lent out, and it is checkable against the open loans.

  system:fee holds exactly the interest and commission earned. Interest is
  revenue, not returned capital, and keeping them apart is why the credit
  account means anything.

  system:mint, negated, is every unit of currency that has ever existed here.
  Nothing appeared from nowhere. If it had, the trial balance would say so."""
)
