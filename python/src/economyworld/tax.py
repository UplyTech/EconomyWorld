"""Fees and taxes: what a transaction costs beyond its amount.

A transfer fee, a sales tax, a market commission, a wealth levy. All of them are
the same shape -- a rule turns an amount into a smaller amount -- so they are
one module rather than four scattered special cases.

# Who pays is a separate question from how much

A fee of 50 on a payment of 1000 can mean two things, and communities argue
about both:

===============  =======================================================
``ON_TOP``       the payer sends 1050; the recipient gets 1000
``INCLUSIVE``    the payer sends 1000; the recipient gets 950
===============  =======================================================

Neither is more correct. :class:`FeeMode` makes it explicit so that a bot's
"/pay 1000" and its confirmation message cannot disagree.

# A fee is booked, never deducted

:func:`charge_fee` produces a posting to ``system:fee``, so collected revenue is
a balance an operator can see and spend. Quietly reducing a member's balance
without a counter-line would put the books out by exactly the fees collected,
which is the same failure as minting without a mint.

# A rate above the amount is allowed; a rate a hundred times it is not

A fee of more than 100 % is a real thing -- a penalty surcharge, a punitive
withdrawal charge -- so it is not refused. A rate of a million basis points is
not a fee, it is a typo, and it is refused at the same ceiling interest rates
use: :data:`MAX_FEE_BASIS_POINTS`.

# Tiers are inclusive of their floor and exclusive of their ceiling

A tier from 0 to 1000 and another from 1000 upwards do not overlap, and 1000
falls in the second. Written down because half of all tier bugs are somebody
assuming the other convention.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import Enum

from .accounts import Account, SystemAccount, empty_account, system_account
from .engine import EconomyEngine
from .errors import ConfigurationError, ValidationError
from .ledger import PostingKind
from .money import apply_basis_points, assert_whole_amount, distribute
from .rounding import Rounding
from .types import BookingResult

#: The largest rate a fee rule or tier may charge: 10,000 %, the same ceiling
#: interest rates use. Above this a rate is a typo rather than a policy.
MAX_FEE_BASIS_POINTS = 1_000_000

__all__ = [
    "MAX_FEE_BASIS_POINTS",
    "FeeMode",
    "FeeTier",
    "FeeRule",
    "FeeQuote",
    "create_fee_rule",
    "create_tier",
    "quote_fee",
    "charge_fee",
    "split_fee",
    "total_of",
]


class FeeMode(str, Enum):
    """Where the fee comes from."""

    #: The payer pays the amount *plus* the fee. The recipient gets the amount
    #: they were promised.
    ON_TOP = "ON_TOP"
    #: The fee comes out of the amount. The payer sends what they said; the
    #: recipient receives less.
    INCLUSIVE = "INCLUSIVE"


@dataclass(frozen=True)
class FeeTier:
    """One band of a tiered fee.

    Applies to the part of the amount that falls inside the band, not to the
    whole amount -- the way income tax brackets work, and the way people expect
    a "progressive" fee to behave.
    """

    #: Where the band starts. Inclusive.
    threshold: int
    #: What the part of the amount inside this band is charged, in basis points.
    basis_points: int


@dataclass(frozen=True)
class FeeRule:
    """How much a transaction costs.

    A flat part, a proportional part and a tiered part, any of which may be
    zero. Most rules use one; having all three in one shape means a community
    that starts with a flat fee and later wants a percentage does not change
    the type it stores.
    """

    key: str
    mode: FeeMode = FeeMode.ON_TOP
    #: Charged on every transaction regardless of size.
    flat: int = 0
    #: Charged on the whole amount, in basis points.
    basis_points: int = 0
    #: Charged band by band. Empty for a rule that does not use tiers.
    tiers: tuple[FeeTier, ...] = ()
    #: The least any transaction is charged, after everything else.
    minimum: int = 0
    #: The most any transaction is charged. ``None`` is uncapped.
    maximum: int | None = None
    #: How the proportional parts are rounded.
    rounding: Rounding = Rounding.DOWN


@dataclass(frozen=True)
class FeeQuote:
    """What a rule charges on one amount, and what is left."""

    rule_key: str
    mode: FeeMode
    #: The amount the caller asked about.
    amount: int
    fee: int
    #: What the payer's account is debited in total.
    payer_pays: int
    #: What the recipient's account is credited.
    recipient_receives: int

    @property
    def free(self) -> bool:
        """True when the rule charged nothing."""
        return self.fee == 0


def create_tier(threshold: int, basis_points: int) -> FeeTier:
    """Build a validated fee tier."""
    assert_whole_amount(threshold)
    if threshold < 0:
        raise ConfigurationError("A tier threshold cannot be negative", threshold=threshold)
    if not isinstance(basis_points, int) or isinstance(basis_points, bool) or basis_points < 0:
        raise ConfigurationError(
            "A tier rate must be a non-negative integer number of basis points",
            basis_points=basis_points,
        )
    if basis_points > MAX_FEE_BASIS_POINTS:
        raise ConfigurationError(
            f"A tier rate is capped at {MAX_FEE_BASIS_POINTS} basis points",
            basis_points=basis_points,
            limit=MAX_FEE_BASIS_POINTS,
        )
    return FeeTier(threshold=threshold, basis_points=basis_points)


def create_fee_rule(
    key: str,
    mode: FeeMode = FeeMode.ON_TOP,
    flat: int = 0,
    basis_points: int = 0,
    tiers: Sequence[FeeTier] = (),
    minimum: int = 0,
    maximum: int | None = None,
    rounding: Rounding = Rounding.DOWN,
) -> FeeRule:
    """Build a validated fee rule.

    Tiers must ascend and the first must start at zero, so that every amount
    falls in exactly one band and none is left uncovered. A rule whose tiers
    began at 100 would silently charge nothing on the first hundred, which is
    a decision that should be written as a tier of zero rather than implied by
    an omission.
    """
    if not isinstance(key, str) or not key:
        raise ConfigurationError("A fee rule needs a non-empty key", key=key)
    assert_whole_amount(flat)
    if flat < 0:
        raise ConfigurationError("A flat fee cannot be negative", flat=flat)
    if not isinstance(basis_points, int) or isinstance(basis_points, bool) or basis_points < 0:
        raise ConfigurationError(
            "A fee rate must be a non-negative integer number of basis points",
            basis_points=basis_points,
        )
    if basis_points > MAX_FEE_BASIS_POINTS:
        raise ConfigurationError(
            f"A fee rate is capped at {MAX_FEE_BASIS_POINTS} basis points",
            basis_points=basis_points,
            limit=MAX_FEE_BASIS_POINTS,
        )
    assert_whole_amount(minimum)
    if minimum < 0:
        raise ConfigurationError("A minimum fee cannot be negative", minimum=minimum)
    if maximum is not None:
        assert_whole_amount(maximum)
        if maximum < 0:
            raise ConfigurationError("A maximum fee cannot be negative", maximum=maximum)
        if maximum < minimum:
            raise ConfigurationError(
                "The maximum fee is below the minimum", minimum=minimum, maximum=maximum
            )

    ordered = tuple(tiers)
    if ordered:
        if ordered[0].threshold != 0:
            raise ConfigurationError(
                "The first tier must start at zero, or amounts below it are "
                "charged nothing by accident",
                first_threshold=ordered[0].threshold,
            )
        for previous, current in zip(ordered, ordered[1:], strict=False):
            if current.threshold <= previous.threshold:
                raise ConfigurationError(
                    "Tiers must ascend",
                    previous=previous.threshold,
                    current=current.threshold,
                )

    return FeeRule(
        key=key,
        mode=mode,
        flat=flat,
        basis_points=basis_points,
        tiers=ordered,
        minimum=minimum,
        maximum=maximum,
        rounding=rounding,
    )


def quote_fee(rule: FeeRule, amount: int) -> FeeQuote:
    """What ``rule`` charges on ``amount``. Books nothing.

    The number to show a member before they confirm. Computed the same way
    :func:`charge_fee` computes it, because it is the same function -- a quote
    that could differ from the charge would be worse than no quote.

        >>> from economyworld import FeeMode, create_fee_rule, quote_fee
        >>> rule = create_fee_rule("transfer", basis_points=250, minimum=1)
        >>> quote = quote_fee(rule, 1_000)
        >>> quote.fee, quote.payer_pays, quote.recipient_receives
        (25, 1025, 1000)
    """
    assert_whole_amount(amount)
    if amount < 0:
        raise ValidationError("A fee cannot be quoted on a negative amount", amount=amount)

    fee = rule.flat
    if rule.basis_points:
        fee += apply_basis_points(amount, rule.basis_points, rule.rounding)
    if rule.tiers:
        fee += _tiered(amount, rule)

    fee = max(fee, rule.minimum)
    if rule.maximum is not None:
        fee = min(fee, rule.maximum)

    if rule.mode is FeeMode.ON_TOP:
        payer_pays = amount + fee
        recipient_receives = amount
    else:
        # An inclusive fee can never take more than the amount: a payment of 10
        # with a flat fee of 50 leaves the recipient nothing, not minus forty.
        fee = min(fee, amount)
        payer_pays = amount
        recipient_receives = amount - fee

    assert_whole_amount(payer_pays)
    return FeeQuote(
        rule_key=rule.key,
        mode=rule.mode,
        amount=amount,
        fee=fee,
        payer_pays=payer_pays,
        recipient_receives=recipient_receives,
    )


def _tiered(amount: int, rule: FeeRule) -> int:
    """The tiered part of a fee: each band charged on the slice inside it."""
    total = 0
    for index, tier in enumerate(rule.tiers):
        upper = rule.tiers[index + 1].threshold if index + 1 < len(rule.tiers) else None
        if amount <= tier.threshold:
            break
        top = amount if upper is None else min(amount, upper)
        slice_amount = top - tier.threshold
        total += apply_basis_points(slice_amount, tier.basis_points, rule.rounding)
    return total


def charge_fee(
    engine: EconomyEngine,
    payer: Account,
    quote: FeeQuote,
    now: int,
    operation_id: str,
    reason: str,
    fee_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> BookingResult | None:
    """Book a fee to the scope's fee account.

    ``None`` comes back when the fee was zero, which is an ordinary outcome for
    a rule with a threshold and not worth an exception.

    This books *only the fee*. The payment it was charged on is the caller's own
    booking, and the two belong in the same database transaction -- a fee that
    was collected for a transfer that never happened is money taken for nothing.
    """
    if quote.fee == 0:
        return None
    return engine.transfer(
        source=payer,
        target=fee_account
        or empty_account(
            system_account(payer.ref.scope, payer.ref.currency, SystemAccount.FEE)
        ),
        amount=quote.fee,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.FEE,
        metadata=metadata,
    )


def split_fee(fee: int, weights: Sequence[int]) -> list[int]:
    """Divide a collected fee between several recipients, exactly.

    For a community that shares a market commission between the platform, the
    seller's guild and a charity pot. The shares add up to the fee, always --
    see :func:`~economyworld.money.distribute` for why that is not automatic.
    """
    return distribute(fee, weights)


def total_of(quotes: Sequence[FeeQuote]) -> int:
    """What a list of quotes charges in total.

    For a basket, or for a caller applying several rules to one transaction --
    a platform fee and a sales tax, say. The rules are applied independently to
    the same amount rather than to each other's output, which is the
    conventional reading and the one that does not depend on their order.
    """
    return sum(quote.fee for quote in quotes)
