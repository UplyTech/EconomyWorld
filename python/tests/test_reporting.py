"""Trial balance, money supply, statements and distribution."""

from __future__ import annotations

import pytest

from economyworld import (
    EconomyEngine,
    PostingKind,
    SystemAccount,
    UnbalancedPostingError,
    ValidationError,
    account_balances,
    account_key,
    assert_books_close,
    create_currency,
    gini_permille,
    make_account,
    member_account,
    money_supply,
    statement_for,
    system_account,
    top_holders,
    trial_balance,
    turnover_by_kind,
    wealth_distribution,
)
from economyworld.reporting import Distribution

NOW = 1_700_000_000_000


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN")])


def ref(name: str, scope: str = "g1", currency: str = "COIN"):
    return member_account(scope, name, currency)


@pytest.fixture
def history(engine):
    """A small economy: mint to two members, one payment, one retirement."""
    return [
        engine.credit(make_account(ref("ada"), 0), 10_000, NOW, "m1", "welcome").posting,
        engine.credit(make_account(ref("bob"), 0), 6_000, NOW + 1, "m2", "welcome").posting,
        engine.transfer(
            source=make_account(ref("ada"), 10_000),
            target=make_account(ref("bob"), 6_000),
            amount=1_500,
            now=NOW + 2,
            operation_id="t1",
            reason="gift",
        ).posting,
        engine.debit(make_account(ref("bob"), 7_500), 500, NOW + 3, "b1", "sink").posting,
    ]


class TestTrialBalance:
    def test_a_healthy_ledger_closes(self, history) -> None:
        result = trial_balance(history)
        assert result.postings == 4
        assert result.total == 0
        assert result.unbalanced == ()
        assert result.duplicates == ()
        assert result.balances
        assert_books_close(history)

    def test_no_postings_close_trivially(self) -> None:
        assert trial_balance([]).balances
        assert_books_close([])

    def test_a_posting_booked_twice_is_caught_by_its_id(self, history) -> None:
        """A sum cannot see a duplicate: two balanced copies still sum to zero.

        And they still gave somebody twice the currency. This is the reason the
        package insists the operation id be UNIQUE in the caller's database.
        """
        doubled = [*history, history[0]]
        result = trial_balance(doubled)
        assert result.total == 0  # the sum notices nothing
        assert result.duplicates == ("m1",)
        assert not result.balances
        with pytest.raises(ValidationError):
            assert_books_close(doubled)

    def test_a_posting_that_does_not_balance_is_named(self, history) -> None:
        from dataclasses import replace

        broken = replace(history[0], lines=history[0].lines[:1])
        with pytest.raises(UnbalancedPostingError):
            assert_books_close([broken])
        assert trial_balance([broken]).unbalanced == ("m1",)

    def test_balances_can_be_replayed_from_the_postings(self, history) -> None:
        """Reconciliation: stored balances against what the history implies."""
        balances = account_balances(history)
        assert balances[account_key(ref("ada"))] == 8_500
        assert balances[account_key(ref("bob"))] == 7_000
        mint_key = account_key(system_account("g1", "COIN", SystemAccount.MINT))
        assert balances[mint_key] == -16_000
        assert sum(balances.values()) == 0


class TestMoneySupply:
    def test_issued_retired_and_circulating(self, history) -> None:
        supply = money_supply(history, "g1", "COIN")
        assert supply.issued == 16_000
        assert supply.retired == 500
        assert supply.circulating == 15_500

    def test_circulating_equals_what_everybody_is_holding(self, history) -> None:
        """The invariant that makes the number trustworthy."""
        supply = money_supply(history, "g1", "COIN")
        assert supply.circulating == supply.held_by_members + supply.held_by_system

    def test_a_scope_with_no_history_has_no_money(self, history) -> None:
        supply = money_supply(history, "other-guild", "COIN")
        assert (supply.issued, supply.retired, supply.circulating) == (0, 0, 0)

    def test_another_currency_is_counted_separately(self, history) -> None:
        assert money_supply(history, "g1", "GEM").issued == 0

    def test_a_fee_is_held_by_the_system_not_by_members(self, engine) -> None:
        booking = engine.transfer(
            source=make_account(ref("ada"), 1_000),
            target=make_account(system_account("g1", "COIN", SystemAccount.FEE), 0),
            amount=100,
            now=NOW,
            operation_id="f1",
            reason="fee",
            kind=PostingKind.FEE,
        )
        supply = money_supply([booking.posting], "g1", "COIN")
        assert supply.held_by_system == 100
        assert supply.held_by_members == -100  # nothing was minted in this slice

    def test_refuses_an_empty_scope(self, history) -> None:
        with pytest.raises(ValidationError):
            money_supply(history, "", "COIN")


class TestStatements:
    def test_a_statement_reads_in_order_with_a_running_balance(self, history) -> None:
        statement = statement_for(history, ref("ada"))
        assert [line.delta for line in statement.lines] == [10_000, -1_500]
        assert [line.balance_after for line in statement.lines] == [10_000, 8_500]
        assert statement.closing_balance == 8_500
        assert statement.total_in == 10_000
        assert statement.total_out == 1_500

    def test_an_opening_balance_is_carried_forward(self, history) -> None:
        statement = statement_for(history, ref("ada"), opening_balance=500)
        assert statement.opening_balance == 500
        assert statement.closing_balance == 9_000

    def test_postings_that_do_not_touch_the_account_are_left_out(self, history) -> None:
        assert len(statement_for(history, ref("bob")).lines) == 3
        assert statement_for(history, ref("nobody")).lines == ()

    def test_a_posting_touching_the_account_twice_is_one_net_line(self, engine) -> None:
        """A member should not have to understand an internal rounding line."""
        from economyworld.ledger import PostingLine, create_posting

        posting = create_posting(
            operation_id="x1",
            kind=PostingKind.TRANSFER,
            scope="g1",
            currency="COIN",
            amount=1_000,
            reason="split",
            occurred_at=NOW,
            lines=[
                PostingLine(ref("ada"), -1_000, 5_000, 4_000),
                PostingLine(ref("ada"), 40, 4_000, 4_040),
                PostingLine(ref("bob"), 960, 0, 960),
            ],
        )
        statement = statement_for([posting], ref("ada"))
        assert len(statement.lines) == 1
        assert statement.lines[0].delta == -960

    def test_the_closing_balance_matches_the_replayed_balance(self, history) -> None:
        for name in ("ada", "bob"):
            replayed = account_balances(history)[account_key(ref(name))]
            assert statement_for(history, ref(name)).closing_balance == replayed


class TestTurnover:
    def test_movement_is_totalled_by_kind(self, history) -> None:
        totals = turnover_by_kind(history)
        assert totals[PostingKind.CREDIT] == 16_000
        assert totals[PostingKind.TRANSFER] == 1_500
        assert totals[PostingKind.DEBIT] == 500

    def test_no_postings_no_turnover(self) -> None:
        assert turnover_by_kind([]) == {}


class TestDistribution:
    def keyed(self, **balances):
        return {account_key(ref(name)): amount for name, amount in balances.items()}

    def test_the_shape_of_a_small_economy(self) -> None:
        distribution = wealth_distribution(self.keyed(ada=100, bob=200, cat=300))
        assert distribution.holders == 3
        assert distribution.total == 600
        assert distribution.median == 200
        assert distribution.mean == 200

    def test_the_median_of_an_even_count_is_the_middle_pair(self) -> None:
        assert wealth_distribution(self.keyed(a=10, b=20, c=30, d=40)).median == 25

    def test_system_accounts_are_left_out(self) -> None:
        """The mint holding minus ten million says nothing about equality."""
        balances = {
            **self.keyed(ada=100, bob=100),
            account_key(system_account("g1", "COIN", SystemAccount.MINT)): -200,
        }
        distribution = wealth_distribution(balances)
        assert distribution.holders == 2
        assert distribution.total == 200
        assert distribution.gini_permille == 0

    def test_an_empty_economy_reports_zeroes_rather_than_dividing_by_none(self) -> None:
        assert wealth_distribution({}) == Distribution(0, 0, 0, 0, 0)

    def test_perfect_equality_is_zero(self) -> None:
        assert gini_permille([100, 100, 100, 100]) == 0
        assert gini_permille([7]) == 0

    def test_one_holder_with_everything_approaches_a_thousand(self) -> None:
        many = [0] * 999 + [1_000_000]
        assert gini_permille(many) == 999

    def test_an_economy_with_nothing_in_it_is_equal(self) -> None:
        # Technically true, and better than dividing by the total.
        assert gini_permille([0, 0, 0]) == 0
        assert gini_permille([]) == 0

    def test_inequality_rises_as_wealth_concentrates(self) -> None:
        flat = gini_permille([100, 100, 100, 100])
        tilted = gini_permille([50, 100, 100, 150])
        steep = gini_permille([1, 1, 1, 397])
        assert flat < tilted < steep

    def test_the_order_of_the_balances_does_not_matter(self) -> None:
        assert gini_permille([5, 1, 90, 4]) == gini_permille([90, 5, 4, 1])

    def test_a_huge_economy_does_not_overflow_the_shared_range(self) -> None:
        """The intermediate sum passes 2^53 long before any balance does.

        Python is exact either way; the TypeScript edition computes the same
        expression in BigInt so the two agree to the unit.
        """
        balances = [9_000_000_000_000 + i for i in range(1_000)]
        result = gini_permille(balances)
        assert 0 <= result <= 1_000

    def test_the_answer_stays_on_its_scale(self) -> None:
        for balances in ([1], [0, 1], [1, 2, 3], [1_000_000, 1], [3, 3, 3, 1]):
            assert 0 <= gini_permille(balances) <= 1_000


class TestTopHolders:
    def keyed(self, **balances):
        return {account_key(ref(name)): amount for name, amount in balances.items()}

    def test_largest_first(self) -> None:
        holders = top_holders(self.keyed(ada=100, bob=300, cat=200))
        assert [amount for _, amount in holders] == [300, 200, 100]

    def test_a_tie_is_broken_by_the_account_key(self) -> None:
        """A leaderboard whose joint-third moves every draw looks broken."""
        first = top_holders(self.keyed(zoe=100, ada=100))
        second = top_holders(self.keyed(ada=100, zoe=100))
        assert first == second
        assert first[0][0] < first[1][0]

    def test_the_limit_is_honoured(self) -> None:
        holders = top_holders(self.keyed(a=1, b=2, c=3, d=4), limit=2)
        assert len(holders) == 2
        assert top_holders(self.keyed(a=1), limit=0) == []

    def test_system_accounts_never_appear(self) -> None:
        balances = {
            **self.keyed(ada=100),
            account_key(system_account("g1", "COIN", SystemAccount.FEE)): 999_999,
        }
        assert [key for key, _ in top_holders(balances)] == [account_key(ref("ada"))]

    def test_refuses_a_negative_limit(self) -> None:
        with pytest.raises(ValidationError):
            top_holders({}, limit=-1)
