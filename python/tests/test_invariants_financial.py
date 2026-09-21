"""Property runs over the financial subsystems.

:mod:`test_invariants` proves the engine itself conserves currency. Banking,
credit, investments, markets and billing all book through that same engine, so
they inherit the guarantee -- but each of them decides *which* accounts a
posting touches, and getting that wrong is exactly how a subsystem quietly
issues currency nobody minted, or strands a balance in an account no report
looks at. These runs prove they do not.

The generator, the world and the member list come from :mod:`test_invariants`
so that a failing seed means the same sequence in both files.
"""

from __future__ import annotations

import pytest

from economyworld import (
    AmortisationMethod,
    EconomyEngine,
    EconomyError,
    FeeMode,
    InstrumentKind,
    LoanState,
    OrderSide,
    Posting,
    Rounding,
    SystemAccount,
    account_balances,
    account_key,
    accrue_deposit_interest,
    amount_due,
    assert_books_close,
    buy_units,
    charge_subscription,
    create_currency,
    create_deposit_terms,
    create_fee_rule,
    create_instrument,
    create_loan_terms,
    create_order,
    create_plan,
    deposit,
    distribute_dividend,
    exchange,
    is_balanced,
    make_account,
    match_order,
    member_account,
    money_supply,
    open_deposit,
    open_loan,
    open_position,
    quote_fee,
    repay,
    run_payroll,
    sell_units,
    settle_fill,
    split_fee,
    split_payroll,
    start_subscription,
    system_account,
    withdraw,
    write_off,
)
from economyworld.billing import PayrollLine
from economyworld.instruments import Position
from test_invariants import COIN, MEMBERS, NOW, SCOPE, Rng, World, engine

pytestmark = pytest.mark.filterwarnings("error")

BANK = SystemAccount.BANK
CREDIT = SystemAccount.CREDIT
FEE = SystemAccount.FEE
MARKET = SystemAccount.MARKET
MINT = SystemAccount.MINT


def key_of(kind: SystemAccount) -> str:
    return account_key(system_account(SCOPE, COIN, kind))


class TestBanking:
    def test_a_deposit_never_creates_or_destroys_currency(self) -> None:
        """Money on deposit is money that moved, not money that vanished."""
        for seed in range(1, 201):
            rng = Rng(seed)
            world = World(MEMBERS, 50_000)
            economy = engine()
            grand_before = world.grand_total()

            member = rng.pick(MEMBERS)
            terms = create_deposit_terms(
                rate_basis_points=rng.int(0, 500), minimum_balance=rng.int(0, 100)
            )
            savings = open_deposit(f"d{seed}", member_account(SCOPE, member, COIN), terms, NOW)

            for step in range(20):
                now = NOW + step * 3_600_000
                operation_id = f"d{seed}-{step}"
                action = rng.int(0, 2)
                try:
                    if action == 0:
                        booking, savings = deposit(
                            economy,
                            savings,
                            world.account(member),
                            rng.int(1, 2_000),
                            now,
                            operation_id,
                            "random deposit",
                            bank_account=world.system(BANK),
                        )
                        world.apply(booking.posting)
                    elif action == 1:
                        booking, savings = withdraw(
                            economy,
                            savings,
                            world.account(member),
                            rng.int(1, 2_000),
                            now,
                            operation_id,
                            "random withdrawal",
                            bank_account=world.system(BANK),
                        )
                        world.apply(booking.posting)
                    else:
                        accrued, savings = accrue_deposit_interest(
                            economy,
                            savings,
                            rng.int(1, 4),
                            now,
                            operation_id,
                            "random interest",
                            source=world.system(MINT),
                            bank_account=world.system(BANK),
                        )
                        if accrued is not None:
                            world.apply(accrued.posting)
                except EconomyError:
                    continue

                # The bank holds exactly what is on deposit, to the unit. A
                # drift here is a subsystem telling a member one number and the
                # books another.
                assert world.balances.get(key_of(BANK), 0) == savings.balance, (
                    f"seed {seed}, step {step}"
                )

            assert world.grand_total() == grand_before, f"seed {seed}"


class TestCredit:
    def test_a_loan_repaid_in_full_leaves_the_credit_account_at_zero(self) -> None:
        """The invariant that says lending was lending and not issuance.

        Interest is new currency and ends up as fee revenue; the capital is not,
        and must come back to the account it left. Mix the two up and the credit
        account keeps a balance for a loan nobody owes any more.
        """
        for seed in range(1, 201):
            rng = Rng(seed)
            world = World(MEMBERS, 5_000_000)
            economy = engine()
            member = rng.pick(MEMBERS)
            grand_before = world.grand_total()

            terms = create_loan_terms(
                principal=rng.int(100, 500_000),
                rate_basis_points=rng.int(0, 1_500),
                periods=rng.int(1, 24),
                method=rng.pick(list(AmortisationMethod)),
            )
            booking, loan = open_loan(
                economy,
                f"L{seed}",
                terms,
                world.account(member),
                NOW,
                f"L{seed}-open",
                "random loan",
                credit_account=world.system(CREDIT),
            )
            world.apply(booking.posting)

            step = 0
            while loan.state in (LoanState.ACTIVE, LoanState.IN_ARREARS) and step < 80:
                step += 1
                result = repay(
                    economy,
                    loan,
                    world.account(member),
                    amount_due(loan),
                    NOW + step * 86_400_000,
                    f"L{seed}-{step}",
                    "random repayment",
                    credit_account=world.system(CREDIT),
                    fee_account=world.system(FEE),
                )
                loan = result.loan
                if result.booking is not None:
                    world.apply(result.booking.posting)

            assert loan.state is LoanState.SETTLED, f"seed {seed}"
            assert world.balances.get(key_of(CREDIT), 0) == 0, f"seed {seed}"
            # Every unit of interest the schedule charged is fee revenue, and
            # not one unit more: the capital went back to credit.
            assert world.balances.get(key_of(FEE), 0) == loan.schedule.total_interest, (
                f"seed {seed}"
            )
            assert world.grand_total() == grand_before, f"seed {seed}"

    def test_a_written_off_loan_is_issuance_not_destruction(self) -> None:
        """The borrower still has what they were lent. Somebody minted it.

        Sending the loss to the sink instead would leave the scope reporting a
        negative amount in circulation, which is not a thing.
        """
        for seed in range(1, 121):
            rng = Rng(seed)
            world = World(MEMBERS, 1_000_000)
            economy = engine()
            member = rng.pick(MEMBERS)

            terms = create_loan_terms(
                principal=rng.int(1_000, 200_000),
                rate_basis_points=rng.int(0, 1_000),
                periods=rng.int(2, 12),
            )
            booking, loan = open_loan(
                economy,
                f"W{seed}",
                terms,
                world.account(member),
                NOW,
                f"W{seed}-open",
                "random loan",
                credit_account=world.system(CREDIT),
            )
            world.apply(booking.posting)

            if rng.int(0, 1) == 1:
                result = repay(
                    economy,
                    loan,
                    world.account(member),
                    amount_due(loan),
                    NOW + 86_400_000,
                    f"W{seed}-r",
                    "one payment",
                    credit_account=world.system(CREDIT),
                    fee_account=world.system(FEE),
                )
                loan = result.loan
                if result.booking is not None:
                    world.apply(result.booking.posting)

            lost = loan.principal_outstanding
            written, loan = write_off(
                economy,
                loan,
                NOW + 200 * 86_400_000,
                f"W{seed}-off",
                "gave up",
                credit_account=world.system(CREDIT),
                mint_account=world.system(MINT),
            )
            if written is not None:
                world.apply(written.posting)
                assert written.posting.amount == lost, f"seed {seed}"

            assert loan.total_outstanding == 0, f"seed {seed}"
            assert world.balances.get(key_of(CREDIT), 0) == 0, f"seed {seed}"
            # What was lent and never came back is permanently in circulation,
            # and the mint's balance says exactly that.
            assert -world.balances.get(key_of(MINT), 0) == lost, f"seed {seed}"
            assert lost <= terms.principal, f"seed {seed}"


class TestMarkets:
    def test_a_settled_fill_moves_only_what_the_fill_says(self) -> None:
        for seed in range(1, 201):
            rng = Rng(seed)
            world = World(MEMBERS, 100_000)
            economy = engine()
            grand_before = world.grand_total()

            buyer_member = rng.pick(MEMBERS)
            seller_member = rng.pick([m for m in MEMBERS if m != buyer_member])
            price = rng.int(1, 500)

            resting = create_order(
                f"s{seed}",
                member_account(SCOPE, seller_member, COIN),
                "ore",
                OrderSide.SELL,
                price,
                rng.int(1, 50),
                NOW,
            )
            incoming = create_order(
                f"b{seed}",
                member_account(SCOPE, buyer_member, COIN),
                "ore",
                OrderSide.BUY,
                price + rng.int(0, 100),
                rng.int(1, 50),
                NOW + 1,
            )
            result = match_order(incoming, [resting])

            for index, fill in enumerate(result.fills):
                # The resting order named the price, so a fill can never cost
                # the buyer more than their own limit.
                assert fill.unit_price <= incoming.unit_price, f"seed {seed}"
                assert fill.consideration == fill.quantity * fill.unit_price
                try:
                    booking = settle_fill(
                        economy,
                        fill,
                        world.account(buyer_member),
                        world.account(seller_member),
                        NOW + 2,
                        f"f{seed}-{index}",
                        "random fill",
                    )
                except EconomyError:
                    continue
                world.apply(booking.posting)

            # A fill is a transfer: two members, one currency, nothing issued.
            assert world.grand_total() == grand_before, f"seed {seed}"
            filled = sum(fill.quantity for fill in result.fills)
            assert filled <= min(incoming.quantity, resting.quantity), f"seed {seed}"

    def test_an_exchange_retires_one_currency_and_issues_the_other(self) -> None:
        """Two currencies, two postings, and both of them on the books."""
        for seed in range(1, 201):
            rng = Rng(seed)
            economy = EconomyEngine(currencies=[create_currency(COIN), create_currency("GEM")])
            member = rng.pick(MEMBERS)
            balance = rng.int(1, 100_000)
            amount = rng.int(1, balance)

            try:
                sold, bought, received = exchange(
                    economy,
                    make_account(member_account(SCOPE, member, COIN), balance),
                    make_account(member_account(SCOPE, member, "GEM"), 0),
                    amount,
                    rng.int(1, 100),
                    rng.int(1, 100),
                    NOW,
                    f"x{seed}",
                    "random exchange",
                )
            except EconomyError:
                continue

            assert is_balanced(sold.posting) and is_balanced(bought.posting)
            assert sold.posting.currency == COIN
            assert bought.posting.currency == "GEM"
            # Two rows, two ids: a shared one would make the second insert fail
            # for a caller doing exactly what the docs ask.
            assert sold.posting.operation_id != bought.posting.operation_id
            assert sold.balances[f"{SCOPE}/{member}/{COIN}"] == balance - amount
            assert bought.balances[f"{SCOPE}/{member}/GEM"] == received
            assert received > 0


class TestFeesAndShares:
    def test_a_fee_is_never_more_than_the_payment_it_comes_out_of(self) -> None:
        for seed in range(1, 401):
            rng = Rng(seed)
            rule = create_fee_rule(
                f"r{seed}",
                mode=rng.pick(list(FeeMode)),
                flat=rng.int(0, 200),
                basis_points=rng.int(0, 2_000),
                minimum=rng.int(0, 50),
                maximum=rng.int(50, 10_000),
                rounding=rng.pick(list(Rounding)),
            )
            amount = rng.int(0, 1_000_000)
            quote = quote_fee(rule, amount)

            assert quote.fee >= 0, f"seed {seed}"
            assert quote.payer_pays >= quote.recipient_receives >= 0, f"seed {seed}"
            if quote.mode is FeeMode.INCLUSIVE:
                # An inclusive fee comes out of the amount, so it can take all
                # of it and never more: the recipient gets nothing, not a debt.
                assert quote.fee <= amount, f"seed {seed}"
                assert quote.payer_pays == amount
                assert quote.recipient_receives + quote.fee == amount
            else:
                assert quote.payer_pays == amount + quote.fee
                assert quote.recipient_receives == amount

    def test_every_share_of_anything_adds_up_to_the_whole(self) -> None:
        """Fees, dividends and payroll all split a pot. None may lose a unit."""
        for seed in range(1, 401):
            rng = Rng(seed)
            total = rng.int(0, 1_000_000)
            count = rng.int(1, 8)
            weights = [rng.int(0, 100) for _ in range(count)]
            if sum(weights) == 0:
                weights[0] = 1

            assert sum(split_fee(total, weights)) == total, f"seed {seed}"

            recipients = [member_account(SCOPE, f"m{index}", COIN) for index in range(count)]
            lines = split_payroll(total, recipients, weights)
            assert sum(line.amount for line in lines) == total, f"seed {seed}"

            positions = [
                Position(recipients[index], "s", weights[index], 0)
                for index in range(count)
                if weights[index] > 0
            ]
            if positions:
                payouts = distribute_dividend(positions, total)
                assert sum(amount for _, amount in payouts) == total, f"seed {seed}"


class TestInvestments:
    def test_a_position_bought_and_sold_realises_exactly_what_it_made(self) -> None:
        for seed in range(1, 301):
            rng = Rng(seed)
            economy = engine()
            instrument = create_instrument("share", InstrumentKind.SHARE, COIN)
            holder = member_account(SCOPE, rng.pick(MEMBERS), COIN)
            position = open_position(holder, instrument)

            spent = 0
            received = 0
            for step in range(10):
                price = rng.int(0, 1_000)
                units = rng.int(1, 100)
                try:
                    if rng.int(0, 1) == 0 or position.units == 0:
                        outcome = buy_units(
                            economy,
                            instrument,
                            position,
                            make_account(holder, 100_000_000),
                            units,
                            price,
                            NOW + step,
                            f"i{seed}-{step}",
                            "random buy",
                        )
                        spent += outcome.consideration
                    else:
                        outcome = sell_units(
                            economy,
                            instrument,
                            position,
                            make_account(holder, 0),
                            min(units, position.units),
                            price,
                            NOW + step,
                            f"i{seed}-{step}",
                            "random sell",
                        )
                        received += outcome.consideration
                except EconomyError:
                    continue
                position = outcome.position
                assert 0 <= position.cost_basis <= spent, f"seed {seed}, step {step}"

            if position.units > 0:
                outcome = sell_units(
                    economy,
                    instrument,
                    position,
                    make_account(holder, 0),
                    position.units,
                    rng.int(0, 1_000),
                    NOW + 100,
                    f"i{seed}-final",
                    "close out",
                )
                received += outcome.consideration
                position = outcome.position

            # Everything sold, so nothing is left: no stranded cost, and the
            # gain is exactly what came back minus what went out.
            assert position.units == 0, f"seed {seed}"
            assert position.cost_basis == 0, f"seed {seed}"
            assert position.realised_gain == received - spent, f"seed {seed}"


class TestBilling:
    def test_a_subscription_charges_each_interval_exactly_once(self) -> None:
        """A scheduler running every minute must not bill every minute."""
        for seed in range(1, 201):
            rng = Rng(seed)
            world = World(MEMBERS, 10_000_000)
            economy = engine()
            payer_member = rng.pick(MEMBERS)
            payee_member = rng.pick([m for m in MEMBERS if m != payer_member])
            grand_before = world.grand_total()

            interval = rng.int(1, 24) * 3_600_000
            amount = rng.int(1, 500)
            subscription = start_subscription(
                f"s{seed}",
                create_plan(
                    f"p{seed}",
                    member_account(SCOPE, payer_member, COIN),
                    member_account(SCOPE, payee_member, COIN),
                    amount,
                    interval,
                ),
                NOW,
            )

            elapsed = 0
            for step in range(30):
                elapsed += rng.int(0, interval)
                try:
                    result = charge_subscription(
                        economy,
                        subscription,
                        world.account(payer_member),
                        NOW + elapsed,
                        f"c{seed}-{step}",
                        "random charge",
                        payee=world.account(payee_member),
                    )
                except EconomyError:
                    continue
                subscription = result.subscription
                if result.booking is not None:
                    world.apply(result.booking.posting)
                assert result.amount == result.charges * amount

            # However often the scheduler ran, the member paid for the time that
            # passed and not a period more.
            assert subscription.charges_made == elapsed // interval, f"seed {seed}"
            assert subscription.total_charged == subscription.charges_made * amount
            assert world.grand_total() == grand_before, f"seed {seed}"

    def test_a_payroll_run_pays_everybody_or_nobody(self) -> None:
        for seed in range(1, 201):
            rng = Rng(seed)
            world = World(MEMBERS, 100_000)
            economy = engine()
            employer_member = rng.pick(MEMBERS)
            recipients = [m for m in MEMBERS if m != employer_member]
            grand_before = world.grand_total()

            lines = [
                PayrollLine(member_account(SCOPE, member, COIN), rng.int(1, 40_000))
                for member in recipients
            ]
            employer = world.account(employer_member)
            total = sum(line.amount for line in lines)

            try:
                booking = run_payroll(
                    economy,
                    employer,
                    lines,
                    NOW,
                    f"pay{seed}",
                    "random payroll",
                    recipients={
                        account_key(line.recipient): world.account(line.recipient.owner)
                        for line in lines
                    },
                )
            except EconomyError:
                # Refused for want of funds -- and nobody was paid, which is the
                # whole point of the run being one posting.
                assert employer.balance < total, f"seed {seed}"
                continue

            world.apply(booking.posting)
            assert is_balanced(booking.posting)
            assert booking.posting.amount == total, f"seed {seed}"
            assert len(booking.posting.lines) == len(lines) + 1
            assert world.grand_total() == grand_before, f"seed {seed}"


class TestTheWholeEconomy:
    def test_the_books_close_across_every_subsystem_at_once(self) -> None:
        """The whole economy, run at random, checked the way an operator would.

        Each subsystem above is checked on its own. This one runs them together
        and then asks the reporting module the questions that matter: does the
        ledger close, was anything booked twice, and does the money supply agree
        with what everybody is actually holding.
        """
        for seed in range(1, 121):
            rng = Rng(seed)
            world = World(MEMBERS, 200_000)
            economy = engine()
            postings: list[Posting] = []
            # What everybody started with, which no posting accounts for: the
            # replay below checks the movement, not the opening position.
            opening = dict(world.balances)

            member = rng.pick(MEMBERS)
            holder = member_account(SCOPE, member, COIN)
            savings = open_deposit(
                f"d{seed}", holder, create_deposit_terms(rate_basis_points=200), NOW
            )
            instrument = create_instrument("share", InstrumentKind.SHARE, COIN)
            position = open_position(holder, instrument)
            loan = None

            for step in range(40):
                now = NOW + step * 86_400_000
                operation_id = f"all{seed}-{step}"
                action = rng.int(0, 6)
                try:
                    if action == 0:
                        result = economy.credit(
                            world.account(member),
                            rng.int(1, 5_000),
                            now=now,
                            operation_id=operation_id,
                            reason="wages",
                            source=world.system(MINT),
                        )
                        world.apply(result.posting)
                        postings.append(result.posting)
                    elif action == 1:
                        booking, savings = deposit(
                            economy,
                            savings,
                            world.account(member),
                            rng.int(1, 5_000),
                            now,
                            operation_id,
                            "save",
                            bank_account=world.system(BANK),
                        )
                        world.apply(booking.posting)
                        postings.append(booking.posting)
                    elif action == 2:
                        booking, savings = withdraw(
                            economy,
                            savings,
                            world.account(member),
                            rng.int(1, 5_000),
                            now,
                            operation_id,
                            "spend",
                            bank_account=world.system(BANK),
                        )
                        world.apply(booking.posting)
                        postings.append(booking.posting)
                    elif action == 3 and loan is None:
                        booking, loan = open_loan(
                            economy,
                            f"L{seed}",
                            create_loan_terms(
                                principal=rng.int(1_000, 50_000),
                                rate_basis_points=rng.int(0, 800),
                                periods=rng.int(1, 12),
                            ),
                            world.account(member),
                            now,
                            operation_id,
                            "borrow",
                            credit_account=world.system(CREDIT),
                        )
                        world.apply(booking.posting)
                        postings.append(booking.posting)
                    elif action == 4 and loan is not None:
                        result = repay(
                            economy,
                            loan,
                            world.account(member),
                            amount_due(loan),
                            now,
                            operation_id,
                            "repay",
                            credit_account=world.system(CREDIT),
                            fee_account=world.system(FEE),
                        )
                        if result.booking is not None:
                            world.apply(result.booking.posting)
                            postings.append(result.booking.posting)
                        loan = (
                            result.loan
                            if result.loan.state in (LoanState.ACTIVE, LoanState.IN_ARREARS)
                            else None
                        )
                    elif action == 5:
                        outcome = buy_units(
                            economy,
                            instrument,
                            position,
                            world.account(member),
                            rng.int(1, 20),
                            rng.int(1, 200),
                            now,
                            operation_id,
                            "invest",
                            counterparty=world.system(MARKET),
                        )
                        position = outcome.position
                        if outcome.booking is not None:
                            world.apply(outcome.booking.posting)
                            postings.append(outcome.booking.posting)
                    elif position.units > 0:
                        outcome = sell_units(
                            economy,
                            instrument,
                            position,
                            world.account(member),
                            rng.int(1, position.units),
                            rng.int(1, 200),
                            now,
                            operation_id,
                            "divest",
                            counterparty=world.system(MARKET),
                        )
                        position = outcome.position
                        if outcome.booking is not None:
                            world.apply(outcome.booking.posting)
                            postings.append(outcome.booking.posting)
                except EconomyError:
                    continue

            assert_books_close(postings)

            # Replaying the history must reproduce the balances the caller
            # stored along the way. If the two ever disagree, one of them is
            # wrong -- and the operator now knows to look.
            for key, moved in account_balances(postings).items():
                assert world.balances.get(key, 0) == opening.get(key, 0) + moved, (
                    f"seed {seed}, {key}"
                )

            supply = money_supply(postings, SCOPE, COIN)
            assert supply.circulating == supply.held_by_members + supply.held_by_system, (
                f"seed {seed}"
            )
            assert supply.circulating >= 0, f"seed {seed}"
            # Nothing leaked: every posting moved currency between accounts the
            # world knows about, so the sum across all of them never moved.
            assert world.grand_total() == sum(opening.values()), f"seed {seed}"
