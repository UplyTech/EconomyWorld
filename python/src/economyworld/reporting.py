"""Reading the books: money supply, statements, and proving nothing leaked.

Everything else in this package writes bookings. This reads them.

# The one number that matters

**Every posting sums to zero, so every set of postings sums to zero.** That is
the whole double-entry design in one sentence, and :func:`trial_balance` is how
you check it actually held -- across a day, a scope, or the entire history.

If it does not, currency was created or destroyed outside a posting, and the
cause is almost always the obligation this package cannot enforce: a posting
written outside a transaction, or written twice. :func:`trial_balance` will not
tell you which, but it will tell you *that*, on the day it happens rather than
three months later when somebody notices a leaderboard is wrong.

# Money supply is a sum of negatives

Currency enters an economy from ``system:mint``, which goes negative by exactly
what it has issued. So the amount in circulation is ``-mint``, less anything
retired into ``system:sink``. Both are read off the same postings, and neither
is a counter somebody has to remember to increment.

# Nothing here reads a database

Every function takes the postings, or the balances, as an argument. A reporting
module that queried storage would be a reporting module that only worked with
one storage layer, and this package works with all of them by working with
none.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from .accounts import AccountRef, account_key, is_system_account, parse_account_key
from .constants import SYSTEM_OWNER_PREFIX
from .errors import UnbalancedPostingError, ValidationError
from .ledger import Posting, PostingKind
from .rounding import Rounding, divide_rounded

__all__ = [
    "TrialBalance",
    "MoneySupply",
    "StatementLine",
    "Statement",
    "Distribution",
    "trial_balance",
    "account_balances",
    "money_supply",
    "statement_for",
    "turnover_by_kind",
    "wealth_distribution",
    "top_holders",
    "gini_permille",
]


@dataclass(frozen=True)
class TrialBalance:
    """Whether a set of postings closes, and where it does not."""

    #: How many postings were checked.
    postings: int
    #: The sum of every line of every posting. Zero when the books close.
    total: int
    #: Postings that did not balance on their own, by operation id.
    unbalanced: tuple[str, ...]
    #: Operation ids that appeared more than once. A duplicate is the second
    #: way books go wrong, and the only one a sum alone cannot see: two copies
    #: of a balanced posting still sum to zero.
    duplicates: tuple[str, ...]

    @property
    def balances(self) -> bool:
        """True when nothing is wrong."""
        return self.total == 0 and not self.unbalanced and not self.duplicates


@dataclass(frozen=True)
class MoneySupply:
    """How much currency exists in a scope, and where it sits."""

    scope: str
    currency: str
    #: Everything ever issued from the mint.
    issued: int
    #: Everything retired into the sink.
    retired: int
    #: Issued less retired: what is out there.
    circulating: int
    #: Of the circulating amount, what members hold.
    held_by_members: int
    #: Of the circulating amount, what the system accounts hold -- shop
    #: takings, escrow, fees, deposits, and lending not yet repaid.
    held_by_system: int


@dataclass(frozen=True)
class StatementLine:
    """One movement on one account, as a member would read it."""

    operation_id: str
    occurred_at: int
    kind: PostingKind
    reason: str
    delta: int
    balance_after: int


@dataclass(frozen=True)
class Statement:
    """Everything that happened to one account, in order."""

    account: AccountRef
    lines: tuple[StatementLine, ...]
    opening_balance: int
    closing_balance: int
    #: Everything that arrived, and everything that left, as positives.
    total_in: int
    total_out: int


@dataclass(frozen=True)
class Distribution:
    """How a scope's currency is spread across its members."""

    holders: int
    total: int
    #: The balance in the middle: half hold more, half hold less. More useful
    #: than the mean, which one wealthy member drags anywhere they like.
    median: int
    mean: int
    #: 0 is everybody equal; 1000 is one member holding everything.
    gini_permille: int


def trial_balance(postings: Iterable[Posting]) -> TrialBalance:
    """Check that a set of postings closes.

    The check an operator should run nightly. It answers three questions at
    once: does every posting balance on its own, do they balance together, and
    was anything booked twice.

    Duplicates are checked because a sum cannot see them. Two copies of a
    perfectly balanced posting still sum to zero -- and they still gave somebody
    twice the currency. Only the ``operation_id`` catches that, which is why
    this package insists it be ``UNIQUE`` in your database.
    """
    total = 0
    count = 0
    unbalanced: list[str] = []
    seen: dict[str, int] = {}

    for posting in postings:
        count += 1
        seen[posting.operation_id] = seen.get(posting.operation_id, 0) + 1
        posting_total = sum(line.delta for line in posting.lines)
        total += posting_total
        if posting_total != 0:
            unbalanced.append(posting.operation_id)

    duplicates = sorted(key for key, times in seen.items() if times > 1)
    return TrialBalance(
        postings=count,
        total=total,
        unbalanced=tuple(unbalanced),
        duplicates=tuple(duplicates),
    )


def assert_books_close(postings: Iterable[Posting]) -> None:
    """Raise unless a set of postings closes.

    For a caller who wants a nightly job that fails loudly rather than one that
    prints a number nobody reads.
    """
    result = trial_balance(postings)
    if result.total != 0:
        raise UnbalancedPostingError("<trial balance>", result.total)
    if result.unbalanced:
        raise UnbalancedPostingError(result.unbalanced[0], 0)
    if result.duplicates:
        raise ValidationError(
            "An operation id was booked more than once",
            operation_id=result.duplicates[0],
            duplicates=len(result.duplicates),
        )


def account_balances(postings: Iterable[Posting]) -> dict[str, int]:
    """What every account's balance would be if these postings were all of them.

    Useful for a test, for a replay, and for reconciling a database against its
    own history: if the balances you have stored differ from the balances the
    postings imply, one of the two is wrong and you now know to look.
    """
    balances: dict[str, int] = {}
    for posting in postings:
        for line in posting.lines:
            key = account_key(line.account)
            balances[key] = balances.get(key, 0) + line.delta
    return balances


def money_supply(postings: Iterable[Posting], scope: str, currency: str) -> MoneySupply:
    """How much currency exists in a scope, and who is holding it.

    Read off the postings rather than off a counter, so it cannot drift. The
    mint's balance is negative by everything it has ever issued; the sink's is
    positive by everything retired.
    """
    if not isinstance(scope, str) or not scope:
        raise ValidationError("scope must be a non-empty string", scope=scope)

    balances = {
        key: balance
        for key, balance in account_balances(postings).items()
        if _in(key, scope, currency)
    }

    mint = balances.get(f"{scope}/system:mint/{currency}", 0)
    sink = balances.get(f"{scope}/system:sink/{currency}", 0)

    members = 0
    system = 0
    for key, balance in balances.items():
        ref = parse_account_key(key)
        if not is_system_account(ref):
            members += balance
        elif ref.owner not in ("system:mint", "system:sink"):
            system += balance

    return MoneySupply(
        scope=scope,
        currency=currency,
        issued=-mint,
        retired=sink,
        circulating=-mint - sink,
        held_by_members=members,
        held_by_system=system,
    )


def statement_for(
    postings: Iterable[Posting], account: AccountRef, opening_balance: int = 0
) -> Statement:
    """Everything that happened to one account, in the order it happened.

    Postings are read in the order given, so hand them over sorted by
    ``occurred_at`` -- this function will not sort them, because two postings in
    the same millisecond have an order only the caller knows.

    A posting that touches the account twice contributes one line with the net
    change. That is a deliberate choice: a member seeing "-1000" and "+40" for
    one purchase would ask what the +40 was, and the answer -- an internal
    rounding line -- is not something they should have to understand.
    """
    key = account_key(account)
    lines: list[StatementLine] = []
    balance = opening_balance
    total_in = 0
    total_out = 0

    for posting in postings:
        delta = sum(line.delta for line in posting.lines if account_key(line.account) == key)
        if delta == 0:
            continue
        balance += delta
        if delta > 0:
            total_in += delta
        else:
            total_out += -delta
        lines.append(
            StatementLine(
                operation_id=posting.operation_id,
                occurred_at=posting.occurred_at,
                kind=posting.kind,
                reason=posting.reason,
                delta=delta,
                balance_after=balance,
            )
        )

    return Statement(
        account=account,
        lines=tuple(lines),
        opening_balance=opening_balance,
        closing_balance=balance,
        total_in=total_in,
        total_out=total_out,
    )


def turnover_by_kind(postings: Iterable[Posting]) -> dict[PostingKind, int]:
    """How much moved, by what sort of event.

    The shape of an economy in one table: how much was earned, how much was
    spent in shops, how much was lent. Sorted by nothing -- a dictionary, for
    the caller to present as it likes.
    """
    totals: dict[PostingKind, int] = {}
    for posting in postings:
        totals[posting.kind] = totals.get(posting.kind, 0) + posting.amount
    return totals


def wealth_distribution(balances: Mapping[str, int]) -> Distribution:
    """How evenly a scope's currency is spread.

    System accounts are left out: the mint holding minus ten million says
    nothing about whether members are equal.

    The Gini coefficient is in permille, computed on integers. Zero is perfect
    equality; a thousand is one member holding everything. It is the number that
    tells an operator whether their earning rules have quietly produced an
    economy where nothing is affordable for anybody but the top three members.
    """
    member_balances = sorted(
        balance
        for key, balance in balances.items()
        if not parse_account_key(key).owner.startswith(SYSTEM_OWNER_PREFIX)
    )
    if not member_balances:
        return Distribution(holders=0, total=0, median=0, mean=0, gini_permille=0)

    count = len(member_balances)
    total = sum(member_balances)
    middle = count // 2
    median = (
        member_balances[middle]
        if count % 2 == 1
        else (member_balances[middle - 1] + member_balances[middle]) // 2
    )
    mean = total // count if count else 0

    return Distribution(
        holders=count,
        total=total,
        median=median,
        mean=mean,
        gini_permille=gini_permille(member_balances),
    )


def gini_permille(balances: Sequence[int]) -> int:
    """Inequality on a 0..1000 scale, as an integer.

    Computed from the sorted balances with the standard alternative formula::

        G = (2 * sum(i * x_i) - (n + 1) * sum(x)) / (n * sum(x))

    with ``i`` counting from one. All integer, so both editions agree to the
    unit -- a float here would be a number two communities compare and find
    different.

    Zero when everybody has the same, and when nobody has anything: an economy
    where all balances are zero is perfectly equal, which is technically true
    and worth returning rather than dividing by it.
    """
    ordered = sorted(balances)
    count = len(ordered)
    if count == 0:
        return 0
    total = sum(ordered)
    if total <= 0:
        return 0

    # Every term here is a sum of products: with a thousand holders near the
    # balance ceiling ``weighted`` passes 2^53 long before any single balance
    # does. Python is exact either way; the TypeScript edition uses BigInt for
    # the same expression, so the two agree at any size.
    weighted = sum((index + 1) * value for index, value in enumerate(ordered))
    numerator = 2 * weighted - (count + 1) * total
    denominator = count * total
    permille = divide_rounded(numerator * 1000, denominator, Rounding.HALF_UP)
    return max(0, min(1000, permille))


def top_holders(balances: Mapping[str, int], limit: int = 10) -> list[tuple[str, int]]:
    """The members holding most, largest first.

    Ties are broken by account key so the order is stable: a leaderboard whose
    joint-third changes place every time it is drawn looks broken even when the
    numbers are right.
    """
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
        raise ValidationError("limit must be a non-negative integer", limit=limit)
    members = [
        (key, balance)
        for key, balance in balances.items()
        if not parse_account_key(key).owner.startswith(SYSTEM_OWNER_PREFIX)
    ]
    members.sort(key=lambda pair: (-pair[1], pair[0]))
    return members[:limit]


def _in(key: str, scope: str, currency: str) -> bool:
    ref = parse_account_key(key)
    return ref.scope == scope and ref.currency == currency
