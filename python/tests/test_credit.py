"""Loans, repayments, arrears and write-offs."""

from __future__ import annotations

import pytest

from economyworld import (
    AmortisationMethod,
    CreditLimitError,
    EconomyEngine,
    LoanState,
    LoanStateError,
    PostingKind,
    SystemAccount,
    account_key,
    amount_due,
    assert_within_credit_limit,
    charge_late_fee,
    create_currency,
    create_loan_terms,
    is_in_arrears,
    make_account,
    member_account,
    next_instalment,
    open_loan,
    repay,
    settle_early,
    settlement_quote,
    system_account,
    write_off,
)

NOW = 1_700_000_000_000


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN")])


def ref(name: str = "ben"):
    return member_account("g1", name, "COIN")


def terms(**overrides):
    base = {"principal": 120_000, "rate_basis_points": 100, "periods": 12}
    base.update(overrides)
    return create_loan_terms(**base)


def opened(engine: EconomyEngine, **overrides):
    return open_loan(engine, "L", terms(**overrides), make_account(ref(), 0), NOW, "o", "loan")


class TestOpening:
    def test_pays_out_of_the_credit_account(self, engine: EconomyEngine) -> None:
        # The credit account's balance is the scope's outstanding lending, with
        # a minus sign, and that number can be checked against the open loans.
        booking, loan = opened(engine)
        assert booking.posting.kind is PostingKind.LOAN_DISBURSEMENT
        credit = account_key(system_account("g1", "COIN", SystemAccount.CREDIT))
        assert booking.balances[credit] == -120_000
        assert booking.balances[account_key(ref())] == 120_000
        assert loan.state is LoanState.ACTIVE

    def test_the_schedule_is_computed_once_and_stored(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        assert loan.schedule.periods == 12
        assert loan.principal_outstanding == 120_000
        assert loan.interest_outstanding == loan.schedule.total_interest
        assert loan.total_outstanding == loan.schedule.total_paid

    def test_the_credit_limit_is_the_caller_s_to_supply(self) -> None:
        assert_within_credit_limit(terms(), existing=0, credit_limit=None)
        assert_within_credit_limit(terms(), existing=0, credit_limit=200_000)
        with pytest.raises(CreditLimitError):
            assert_within_credit_limit(terms(), existing=100_000, credit_limit=200_000)


class TestRepayment:
    def test_paying_every_instalment_settles_it_exactly(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        borrower = make_account(ref(), 500_000)
        paid = 0
        for index in range(12):
            due = amount_due(loan)
            outcome = repay(engine, loan, borrower, due, NOW, f"r{index}", "instalment")
            loan = outcome.loan
            paid += due
        assert loan.state is LoanState.SETTLED
        assert loan.total_outstanding == 0
        assert paid == 120_000 + loan.schedule.total_interest

    def test_the_split_always_adds_up_to_the_payment(self, engine: EconomyEngine) -> None:
        # The line a member reads on their statement. If it does not add up
        # they will notice, and they will be right.
        _, loan = opened(engine, late_fee_basis_points=500)
        loan = charge_late_fee(loan, 1)
        borrower = make_account(ref(), 500_000)
        for index in range(5):
            due = min(amount_due(loan), 4_000)
            outcome = repay(engine, loan, borrower, due, NOW, f"r{index}", "part")
            assert outcome.to_fees + outcome.to_interest + outcome.to_principal == due
            loan = outcome.loan

    def test_fees_are_paid_first_then_interest_then_principal(
        self, engine: EconomyEngine
    ) -> None:
        _, loan = opened(engine, late_fee_basis_points=500)
        loan = charge_late_fee(loan, 1)
        fees = loan.fees_outstanding
        assert fees > 0
        outcome = repay(engine, loan, make_account(ref(), 500_000), fees + 10, NOW, "r", "x")
        assert outcome.to_fees == fees
        assert outcome.to_interest == 10
        assert outcome.to_principal == 0

    def test_capital_and_revenue_go_to_different_accounts(self, engine: EconomyEngine) -> None:
        """The three-line posting, and why it is three lines.

        Sending the whole payment to the credit account would leave it positive
        by exactly the interest once every loan had been repaid, and a number
        that means "currency currently lent out" would mean nothing at all.
        """
        _, loan = opened(engine)
        outcome = repay(
            engine, loan, make_account(ref(), 500_000), amount_due(loan), NOW, "r", "x"
        )
        lines = outcome.booking.posting.lines
        assert len(lines) == 3
        credit = account_key(system_account("g1", "COIN", SystemAccount.CREDIT))
        fee = account_key(system_account("g1", "COIN", SystemAccount.FEE))
        assert outcome.booking.balances[credit] == outcome.to_principal
        assert outcome.booking.balances[fee] == outcome.to_interest

    def test_the_credit_account_returns_to_zero_over_a_whole_loan(
        self, engine: EconomyEngine
    ) -> None:
        booking, loan = opened(engine)
        postings = [booking.posting]
        borrower = make_account(ref(), 500_000)
        for index in range(12):
            outcome = repay(engine, loan, borrower, amount_due(loan), NOW, f"r{index}", "x")
            loan = outcome.loan
            postings.append(outcome.booking.posting)

        balances: dict[str, int] = {}
        for posting in postings:
            for line in posting.lines:
                key = account_key(line.account)
                balances[key] = balances.get(key, 0) + line.delta

        credit = account_key(system_account("g1", "COIN", SystemAccount.CREDIT))
        fee = account_key(system_account("g1", "COIN", SystemAccount.FEE))
        assert balances[credit] == 0  # lent 120,000, got 120,000 back
        assert balances[fee] == loan.schedule.total_interest
        assert sum(balances.values()) == 0  # and the books close

    def test_a_part_payment_does_not_advance_the_schedule(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        due = amount_due(loan)
        outcome = repay(engine, loan, make_account(ref(), 500_000), due - 1, NOW, "r", "x")
        assert outcome.instalments_cleared == 0
        assert outcome.loan.part_paid == due - 1
        # One more unit completes it.
        outcome = repay(engine, outcome.loan, make_account(ref(), 500_000), 1, NOW, "r2", "x")
        assert outcome.instalments_cleared == 1

    def test_overpaying_is_refused_rather_than_credited(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        with pytest.raises(LoanStateError):
            repay(
                engine,
                loan,
                make_account(ref(), 500_000),
                loan.total_outstanding + 1,
                NOW,
                "r",
                "x",
            )

    def test_a_closed_loan_takes_no_more(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        outcome = settle_early(engine, loan, make_account(ref(), 500_000), NOW, "s", "x")
        with pytest.raises(LoanStateError):
            repay(engine, outcome.loan, make_account(ref(), 500_000), 1, NOW, "r", "x")

    def test_only_the_borrower_may_repay(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        with pytest.raises(LoanStateError):
            repay(
                engine,
                loan,
                make_account(member_account("g1", "someone-else", "COIN"), 500_000),
                100,
                NOW,
                "r",
                "x",
            )


class TestEarlySettlement:
    def test_the_quote_is_the_outstanding_balance_without_a_rebate(
        self, engine: EconomyEngine
    ) -> None:
        _, loan = opened(engine)
        assert settlement_quote(loan, 0) == loan.total_outstanding

    def test_a_rebate_forgives_future_interest_only(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        borrower = make_account(ref(), 500_000)
        for index in range(3):
            loan = repay(engine, loan, borrower, amount_due(loan), NOW, f"r{index}", "x").loan

        full = settlement_quote(loan, 0)
        half = settlement_quote(loan, 5000)
        assert half < full
        # The interest inside the instalment already reached is still owed.
        future = sum(
            row.interest for row in loan.schedule.instalments[loan.paid_instalments + 1 :]
        )
        assert full - half == future // 2

    def test_settling_closes_the_loan_and_repays_the_capital_in_full(
        self, engine: EconomyEngine
    ) -> None:
        _, loan = opened(engine)
        outcome = settle_early(
            engine,
            loan,
            make_account(ref(), 500_000),
            NOW,
            "s",
            "x",
            rebate_basis_points=10_000,
        )
        assert outcome.settled
        assert outcome.loan.state is LoanState.SETTLED
        assert outcome.loan.total_outstanding == 0
        # A full rebate forgives every unreached period's interest; the capital
        # is still repaid in full.
        assert outcome.to_principal == 120_000

    def test_the_rebate_never_exceeds_the_interest_actually_owed(
        self, engine: EconomyEngine
    ) -> None:
        # A part payment can already have cleared some of it, and a rebate
        # larger than the debt would pay the borrower for closing their loan.
        _, loan = opened(engine)
        loan = repay(engine, loan, make_account(ref(), 500_000), 5_000, NOW, "r", "x").loan
        assert settlement_quote(loan, 10_000) >= loan.principal_outstanding


class TestArrearsAndDefault:
    def test_a_late_fee_is_owed_but_not_yet_booked(self, engine: EconomyEngine) -> None:
        # A fee is charged to the loan, not to the balance: they owe it, they
        # have not paid it.
        _, loan = opened(engine, late_fee_basis_points=500, grace_periods=1)
        after = charge_late_fee(loan, 1)
        assert after.fees_outstanding > 0
        assert after.total_outstanding == loan.total_outstanding + after.fees_outstanding

    def test_grace_decides_when_a_loan_is_in_arrears(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine, late_fee_basis_points=500, grace_periods=1)
        assert charge_late_fee(loan, 1).state is LoanState.ACTIVE
        assert charge_late_fee(loan, 2).state is LoanState.IN_ARREARS

    def test_is_in_arrears_asks_the_caller_for_the_clock(self, engine: EconomyEngine) -> None:
        # Only the caller knows how many instalments should have been paid.
        _, loan = opened(engine, grace_periods=1)
        assert not is_in_arrears(loan, instalments_expected=1)
        assert is_in_arrears(loan, instalments_expected=2)

    def test_write_off_removes_exactly_the_unpaid_capital(self, engine: EconomyEngine) -> None:
        """The bug that made this a tracked field rather than a computed one.

        A member who has part-paid an instalment has paid some of its interest.
        A figure derived from whole instalments counts that interest as still
        owed, and the write-off then removes too little currency from the
        economy -- leaving the credit account permanently wrong.
        """
        _, loan = opened(engine, late_fee_basis_points=500)
        loan = charge_late_fee(loan, 1)
        outcome = repay(engine, loan, make_account(ref(), 500_000), 5_000, NOW, "r", "x")
        loan = outcome.loan

        booking, closed = write_off(engine, loan, NOW, "w", "uncollectable")
        assert booking is not None
        assert booking.posting.amount == 120_000 - outcome.to_principal
        assert booking.posting.kind is PostingKind.WRITE_OFF
        assert closed.state is LoanState.WRITTEN_OFF
        assert closed.total_outstanding == 0

    def test_write_off_moves_currency_out_of_the_economy(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        booking, _ = write_off(engine, loan, NOW, "w", "gone")
        assert booking is not None
        credit = account_key(system_account("g1", "COIN", SystemAccount.CREDIT))
        mint = account_key(system_account("g1", "COIN", SystemAccount.MINT))
        # The credit account comes back to zero for this loan; the mint goes
        # negative, because the currency the borrower kept is now issued for
        # good rather than lent.
        assert booking.balances[credit] == 120_000
        assert booking.balances[mint] == -120_000

    def test_writing_off_a_settled_loan_is_refused(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        outcome = settle_early(engine, loan, make_account(ref(), 500_000), NOW, "s", "x")
        with pytest.raises(LoanStateError):
            write_off(engine, outcome.loan, NOW, "w", "x")

    def test_only_the_unpaid_capital_is_ever_written_off(self, engine: EconomyEngine) -> None:
        # Unpaid interest and fees were never issued -- nobody minted them, so
        # nothing has to be un-minted. They simply stop being owed.
        for method in AmortisationMethod:
            _, loan = opened(engine, method=method, periods=4)
            borrower = make_account(ref(), 500_000)
            loan = repay(engine, loan, borrower, amount_due(loan), NOW, "r1", "x").loan
            expected = loan.principal_outstanding
            booking, closed = write_off(engine, loan, NOW, "w", "x")
            assert (0 if booking is None else booking.posting.amount) == expected, method
            assert closed.state is LoanState.WRITTEN_OFF
            assert closed.total_outstanding == 0

    def test_a_loan_with_no_capital_left_writes_nothing_off(
        self, engine: EconomyEngine
    ) -> None:
        _, loan = opened(engine, method=AmortisationMethod.INTEREST_ONLY, periods=4)
        borrower = make_account(ref(), 500_000)
        # Interest-only: the first three instalments are pure interest, so the
        # capital is untouched -- pay the lot to clear it.
        loan = settle_early(engine, loan, borrower, NOW, "s", "x").loan
        with pytest.raises(LoanStateError):
            write_off(engine, loan, NOW, "w", "x")


class TestQueries:
    def test_amount_due_puts_fees_first(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine, late_fee_basis_points=500)
        plain = amount_due(loan)
        loan = charge_late_fee(loan, 1)
        assert amount_due(loan) == plain + loan.fees_outstanding

    def test_next_instalment_is_none_once_it_is_over(self, engine: EconomyEngine) -> None:
        _, loan = opened(engine)
        assert next_instalment(loan) is loan.schedule.instalments[0]
        outcome = settle_early(engine, loan, make_account(ref(), 500_000), NOW, "s", "x")
        assert next_instalment(outcome.loan) is None
        assert amount_due(outcome.loan) == 0
