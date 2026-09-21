"""Deposits, term accounts and holds."""

from __future__ import annotations

import pytest

from economyworld import (
    DepositError,
    EconomyEngine,
    HoldError,
    InsufficientFundsError,
    InvalidAmountError,
    PostingKind,
    SystemAccount,
    ValidationError,
    account_key,
    accrue_deposit_interest,
    active_holds,
    available_balance,
    capture_hold,
    create_currency,
    create_deposit_terms,
    deposit,
    early_withdrawal_penalty,
    held_amount,
    is_mature,
    make_account,
    maturity_value,
    member_account,
    open_deposit,
    place_hold,
    place_in_escrow,
    release_from_escrow,
    release_hold,
    settle_from_escrow,
    system_account,
    withdraw,
)

NOW = 1_700_000_000_000
DAY = 86_400_000


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN")])


def ref(name: str = "ana"):
    return member_account("g1", name, "COIN")


class TestTerms:
    def test_defaults_are_an_on_demand_account_paying_nothing(self) -> None:
        terms = create_deposit_terms()
        assert terms.term_ms == 0
        assert terms.rate_basis_points == 0
        assert is_mature(open_deposit("d", ref(), terms, NOW), NOW)

    def test_an_on_demand_account_cannot_have_an_early_penalty(self) -> None:
        # There is nothing to be early for, and a penalty that could never
        # apply is a configuration mistake worth catching at build time.
        with pytest.raises(DepositError):
            create_deposit_terms(term_ms=0, early_withdrawal_penalty_bp=5000)

    def test_refuses_impossible_values(self) -> None:
        with pytest.raises(DepositError):
            create_deposit_terms(term_ms=-1)
        with pytest.raises(DepositError):
            create_deposit_terms(term_ms=DAY, early_withdrawal_penalty_bp=10_001)
        with pytest.raises(DepositError):
            create_deposit_terms(minimum_balance=-1)


class TestDeposit:
    def test_money_really_moves_to_the_bank_account(self, engine: EconomyEngine) -> None:
        # Not a flag beside the balance: a posting, so "how much is on deposit"
        # is one balance rather than a sum across every member's row.
        account = open_deposit("d", ref(), create_deposit_terms(), NOW)
        booking, account = deposit(
            engine, account, make_account(ref(), 10_000), 4_000, NOW, "op", "save"
        )
        assert booking.posting.kind is PostingKind.DEPOSIT
        assert booking.balances[account_key(ref())] == 6_000
        bank = account_key(system_account("g1", "COIN", SystemAccount.BANK))
        assert booking.balances[bank] == 4_000
        assert account.principal == 4_000

    def test_refuses_a_deposit_from_somebody_else(self, engine: EconomyEngine) -> None:
        account = open_deposit("d", ref("ana"), create_deposit_terms(), NOW)
        with pytest.raises(DepositError):
            deposit(engine, account, make_account(ref("ben"), 10_000), 100, NOW, "op", "x")


class TestInterest:
    def test_is_issued_from_the_mint(self, engine: EconomyEngine) -> None:
        # Interest is new currency. In a closed economy there is no other
        # honest place for it to come from, and the posting says so.
        account = open_deposit("d", ref(), create_deposit_terms(rate_basis_points=500), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 10_000), 10_000, NOW, "in", "x"
        )
        booking, account = accrue_deposit_interest(engine, account, 1, NOW, "int", "interest")
        assert booking is not None
        assert booking.posting.kind is PostingKind.INTEREST
        mint = account_key(system_account("g1", "COIN", SystemAccount.MINT))
        assert booking.balances[mint] == -500
        assert account.accrued_interest == 500

    def test_can_be_funded_from_somewhere_else(self, engine: EconomyEngine) -> None:
        # An operator paying interest out of collected fees does not move the
        # money supply, and the posting shows that instead.
        account = open_deposit("d", ref(), create_deposit_terms(rate_basis_points=500), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 10_000), 10_000, NOW, "in", "x"
        )
        fees = make_account(system_account("g1", "COIN", SystemAccount.FEE), 100_000)
        booking, _ = accrue_deposit_interest(
            engine, account, 1, NOW, "int", "interest", source=fees
        )
        assert booking is not None
        assert booking.balances[account_key(fees.ref)] == 99_500

    def test_nothing_to_credit_is_not_an_error(self, engine: EconomyEngine) -> None:
        # A nightly job across a whole community will see a lot of this.
        account = open_deposit("d", ref(), create_deposit_terms(rate_basis_points=0), NOW)
        booking, account = accrue_deposit_interest(engine, account, 5, NOW, "int", "x")
        assert booking is None
        assert account.periods_accrued == 5

    def test_compounds_across_periods(self, engine: EconomyEngine) -> None:
        account = open_deposit("d", ref(), create_deposit_terms(rate_basis_points=200), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 10_000), 5_000, NOW, "in", "x"
        )
        credited = []
        for index in range(3):
            booking, account = accrue_deposit_interest(
                engine, account, 1, NOW, f"i{index}", "interest"
            )
            credited.append(0 if booking is None else booking.posting.amount)
        assert credited == [100, 102, 104]
        assert account.balance == 5_306

    def test_projection_books_nothing_and_reads_no_clock(self) -> None:
        account = open_deposit("d", ref(), create_deposit_terms(rate_basis_points=500), NOW)
        from dataclasses import replace

        account = replace(account, principal=10_000)
        assert maturity_value(account, 0) == 10_000
        assert maturity_value(account, 1) == 10_500


class TestMaturityAndPenalty:
    def _funded(self, engine: EconomyEngine, **terms):
        account = open_deposit("d", ref(), create_deposit_terms(**terms), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 100_000), 10_000, NOW, "in", "x"
        )
        _, account = accrue_deposit_interest(engine, account, 5, NOW, "int", "x")
        return account

    def test_an_on_demand_account_is_always_mature(self, engine: EconomyEngine) -> None:
        account = self._funded(engine, rate_basis_points=500)
        assert is_mature(account, NOW)
        assert early_withdrawal_penalty(account, NOW) == 0

    def test_a_term_account_matures_when_the_term_runs_out(
        self, engine: EconomyEngine
    ) -> None:
        account = self._funded(
            engine, rate_basis_points=500, term_ms=30 * DAY, early_withdrawal_penalty_bp=5000
        )
        assert not is_mature(account, NOW + 29 * DAY)
        assert is_mature(account, NOW + 30 * DAY)

    def test_the_penalty_is_a_share_of_the_interest_only(self, engine: EconomyEngine) -> None:
        # A term account that could hand a member back less than they put in is
        # a product nobody should ship by accident.
        account = self._funded(
            engine, rate_basis_points=500, term_ms=30 * DAY, early_withdrawal_penalty_bp=10_000
        )
        assert early_withdrawal_penalty(account, NOW) == account.accrued_interest
        assert early_withdrawal_penalty(account, NOW) < account.principal
        assert early_withdrawal_penalty(account, NOW + 30 * DAY) == 0


class TestWithdraw:
    def test_takes_interest_before_principal(self, engine: EconomyEngine) -> None:
        account = open_deposit("d", ref(), create_deposit_terms(rate_basis_points=1000), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 100_000), 10_000, NOW, "in", "x"
        )
        _, account = accrue_deposit_interest(engine, account, 1, NOW, "int", "x")
        assert account.accrued_interest == 1_000

        _, account = withdraw(engine, account, make_account(ref(), 90_000), 600, NOW, "w", "x")
        assert account.accrued_interest == 400
        assert account.principal == 10_000  # untouched

    def test_the_posting_is_labelled_a_withdrawal(self, engine: EconomyEngine) -> None:
        account = open_deposit("d", ref(), create_deposit_terms(), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 10_000), 5_000, NOW, "in", "x"
        )
        booking, _ = withdraw(
            engine, account, make_account(ref(), 5_000), 1_000, NOW, "w", "x"
        )
        assert booking.posting.kind is PostingKind.WITHDRAWAL

    def test_cannot_take_more_than_is_there(self, engine: EconomyEngine) -> None:
        account = open_deposit("d", ref(), create_deposit_terms(), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 10_000), 5_000, NOW, "in", "x"
        )
        with pytest.raises(DepositError):
            withdraw(engine, account, make_account(ref(), 5_000), 5_001, NOW, "w", "x")

    def test_the_penalty_reduces_what_can_be_taken(self, engine: EconomyEngine) -> None:
        account = open_deposit(
            "d",
            ref(),
            create_deposit_terms(
                rate_basis_points=1000, term_ms=30 * DAY, early_withdrawal_penalty_bp=5000
            ),
            NOW,
        )
        _, account = deposit(
            engine, account, make_account(ref(), 100_000), 10_000, NOW, "in", "x"
        )
        _, account = accrue_deposit_interest(engine, account, 1, NOW, "int", "x")
        penalty = early_withdrawal_penalty(account, NOW)
        assert penalty == 500
        with pytest.raises(DepositError):
            withdraw(
                engine, account, make_account(ref(), 90_000), account.balance, NOW, "w", "x"
            )
        _, account = withdraw(
            engine,
            account,
            make_account(ref(), 90_000),
            account.balance - penalty,
            NOW,
            "w",
            "x",
        )
        assert account.balance == 0

    def test_a_minimum_balance_refuses_a_stranding_withdrawal(
        self, engine: EconomyEngine
    ) -> None:
        account = open_deposit("d", ref(), create_deposit_terms(minimum_balance=1_000), NOW)
        _, account = deposit(
            engine, account, make_account(ref(), 10_000), 5_000, NOW, "in", "x"
        )
        with pytest.raises(DepositError):
            withdraw(engine, account, make_account(ref(), 5_000), 4_500, NOW, "w", "x")
        # Taking everything is allowed; taking all but a scrap is not.
        _, account = withdraw(
            engine, account, make_account(ref(), 5_000), 5_000, NOW, "w", "x"
        )
        assert account.balance == 0


class TestHolds:
    def test_a_hold_reserves_without_booking(self) -> None:
        account = make_account(ref(), 5_000)
        hold = place_hold("h1", account, 3_000, NOW, "an order")
        assert hold.amount == 3_000
        assert available_balance(account, [hold], NOW) == 2_000
        assert held_amount([hold], NOW) == 3_000

    def test_the_same_currency_cannot_be_reserved_twice(self) -> None:
        # The entire reason holds exist: a member placing an order, bidding in
        # an auction and buying from a shop with one balance.
        account = make_account(ref(), 5_000)
        holds = [place_hold("h1", account, 3_000, NOW, "order")]
        with pytest.raises(InsufficientFundsError):
            place_hold("h2", account, 3_000, NOW, "bid", holds)

    def test_a_hold_expires_on_its_own(self) -> None:
        account = make_account(ref(), 5_000)
        hold = place_hold("h1", account, 3_000, NOW, "order", expires_at=NOW + 1000)
        assert available_balance(account, [hold], NOW) == 2_000
        assert available_balance(account, [hold], NOW + 1000) == 5_000
        assert active_holds([hold], NOW + 1000) == []

    def test_releasing_frees_the_funds(self) -> None:
        account = make_account(ref(), 5_000)
        holds = [place_hold("h1", account, 3_000, NOW, "order")]
        holds = release_hold(holds, "h1")
        assert available_balance(account, holds, NOW) == 5_000
        with pytest.raises(HoldError):
            release_hold(holds, "h1")

    def test_capturing_books_the_movement(self, engine: EconomyEngine) -> None:
        account = make_account(ref("ana"), 5_000)
        hold = place_hold("h1", account, 3_000, NOW, "order")
        booking, remaining = capture_hold(
            engine,
            hold,
            account,
            make_account(ref("ben"), 0),
            NOW,
            "cap",
            "settled",
            holds=[hold],
        )
        assert booking.posting.amount == 3_000
        assert remaining == []

    def test_capturing_less_is_allowed_and_more_is_not(self, engine: EconomyEngine) -> None:
        account = make_account(ref("ana"), 5_000)
        hold = place_hold("h1", account, 3_000, NOW, "order")
        booking, _ = capture_hold(
            engine, hold, account, make_account(ref("ben"), 0), NOW, "c", "x", amount=1_000
        )
        assert booking.posting.amount == 1_000
        with pytest.raises(HoldError):
            capture_hold(
                engine,
                hold,
                account,
                make_account(ref("ben"), 0),
                NOW,
                "c2",
                "x",
                amount=3_001,
            )

    def test_an_expired_hold_cannot_be_captured(self, engine: EconomyEngine) -> None:
        account = make_account(ref("ana"), 5_000)
        hold = place_hold("h1", account, 3_000, NOW, "order", expires_at=NOW + 100)
        with pytest.raises(HoldError):
            capture_hold(
                engine, hold, account, make_account(ref("ben"), 0), NOW + 100, "c", "x"
            )

    def test_refuses_a_duplicate_id_and_a_past_expiry(self) -> None:
        account = make_account(ref(), 5_000)
        holds = [place_hold("h1", account, 100, NOW, "x")]
        with pytest.raises(HoldError):
            place_hold("h1", account, 100, NOW, "x", holds)
        with pytest.raises(HoldError):
            place_hold("h2", account, 100, NOW, "x", holds, expires_at=NOW)

    def test_only_holds_on_the_same_account_count(self) -> None:
        ana = make_account(ref("ana"), 5_000)
        ben = make_account(ref("ben"), 5_000)
        holds = [place_hold("h1", ben, 4_000, NOW, "ben's order")]
        assert available_balance(ana, holds, NOW) == 5_000

    def test_an_over_held_account_reports_a_negative_available(self) -> None:
        # A fee or a decay run can take a balance below what was held. Reported
        # rather than clamped: a caller that sees it has a decision to make.
        account = make_account(ref(), 5_000)
        hold = place_hold("h1", account, 5_000, NOW, "order")
        after_decay = make_account(ref(), 4_000)
        assert available_balance(after_decay, [hold], NOW) == -1_000


class TestEscrow:
    """The heavier sibling of a hold: the currency really moves.

    A hold reserves a balance where it is; escrow puts it in a third account
    both sides can see. Which one a caller wants is a real decision, so both
    exist and the difference is documented rather than implied.
    """

    def test_the_currency_really_moves(self, engine: EconomyEngine) -> None:
        booking = place_in_escrow(
            engine, make_account(ref("ana"), 5_000), 3_000, NOW, "e1", "a big trade"
        )
        assert booking.posting.kind is PostingKind.ESCROW
        assert booking.balances[account_key(ref("ana"))] == 2_000
        escrow = system_account("g1", "COIN", SystemAccount.ESCROW)
        assert booking.balances[account_key(escrow)] == 3_000

    def test_a_member_cannot_escrow_what_they_do_not_have(self, engine: EconomyEngine) -> None:
        with pytest.raises(InsufficientFundsError):
            place_in_escrow(engine, make_account(ref("ana"), 100), 3_000, NOW, "e1", "x")

    def test_releasing_gives_it_back_under_its_own_kind(self, engine: EconomyEngine) -> None:
        # "You got your money back" and "the seller was paid" are the two
        # outcomes an operator is asked to tell apart six months later.
        escrow = make_account(system_account("g1", "COIN", SystemAccount.ESCROW), 3_000)
        booking = release_from_escrow(
            engine,
            make_account(ref("ana"), 2_000),
            3_000,
            NOW,
            "e2",
            "the deal fell through",
            escrow_account=escrow,
        )
        assert booking.posting.kind is PostingKind.ESCROW_RELEASE
        assert booking.balances[account_key(ref("ana"))] == 5_000
        assert booking.balances[account_key(escrow.ref)] == 0

    def test_settling_pays_the_counterparty_as_a_settlement(
        self, engine: EconomyEngine
    ) -> None:
        escrow = make_account(system_account("g1", "COIN", SystemAccount.ESCROW), 3_000)
        booking = settle_from_escrow(
            engine,
            make_account(ref("ben"), 0),
            3_000,
            NOW,
            "e3",
            "the deal went through",
            escrow_account=escrow,
        )
        assert booking.posting.kind is PostingKind.SETTLEMENT
        assert booking.balances[account_key(ref("ben"))] == 3_000
        assert booking.balances[account_key(escrow.ref)] == 0

    def test_a_whole_escrowed_deal_conserves_the_currency(self, engine: EconomyEngine) -> None:
        """In, then out. The sum across both members never moves."""
        balances = {account_key(ref("ana")): 5_000, account_key(ref("ben")): 0}

        def apply(booking) -> None:
            for line in booking.posting.lines:
                key = account_key(line.account)
                balances[key] = balances.get(key, 0) + line.delta

        apply(place_in_escrow(engine, make_account(ref("ana"), 5_000), 3_000, NOW, "e1", "x"))
        assert balances[account_key(ref("ana"))] == 2_000
        apply(
            settle_from_escrow(
                engine,
                make_account(ref("ben"), 0),
                3_000,
                NOW,
                "e2",
                "x",
                escrow_account=make_account(
                    system_account("g1", "COIN", SystemAccount.ESCROW), 3_000
                ),
            )
        )
        assert balances[account_key(ref("ben"))] == 3_000
        assert sum(balances.values()) == 5_000

    def test_a_caller_who_stores_escrow_cannot_over_release(
        self, engine: EconomyEngine
    ) -> None:
        """The engine lets a system account go negative; escrow should not.

        The check is in the escrow functions rather than in the engine, and it
        is conditional on the caller handing the account over -- which is the
        same bargain the rest of the library strikes about system balances.
        """
        escrow = make_account(system_account("g1", "COIN", SystemAccount.ESCROW), 1_000)
        with pytest.raises(InsufficientFundsError):
            release_from_escrow(
                engine,
                make_account(ref("ana"), 0),
                3_000,
                NOW,
                "e",
                "x",
                escrow_account=escrow,
            )
        with pytest.raises(InsufficientFundsError):
            settle_from_escrow(
                engine,
                make_account(ref("ben"), 0),
                3_000,
                NOW,
                "e",
                "x",
                escrow_account=escrow,
            )

    def test_a_caller_who_does_not_store_escrow_is_not_second_guessed(
        self, engine: EconomyEngine
    ) -> None:
        # Storing system accounts is the caller's choice, and this function
        # cannot invent a balance it was never given.
        booking = release_from_escrow(
            engine, make_account(ref("ana"), 0), 3_000, NOW, "e", "x"
        )
        assert booking.balances[account_key(ref("ana"))] == 3_000

    def test_refuses_a_zero_amount_and_a_bad_timestamp(self, engine: EconomyEngine) -> None:
        for book in (place_in_escrow, release_from_escrow, settle_from_escrow):
            with pytest.raises(InvalidAmountError):
                book(engine, make_account(ref("ana"), 5_000), 0, NOW, "e", "x")
            with pytest.raises(ValidationError):
                book(engine, make_account(ref("ana"), 5_000), 100, 1.5, "e", "x")
