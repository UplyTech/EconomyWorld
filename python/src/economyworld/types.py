"""Value objects and enumerations exchanged with the caller."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum

from .constants import DEFAULT_PERIOD_SECONDS
from .ledger import Posting

__all__ = [
    "EarnRule",
    "EarnState",
    "EarnOutcome",
    "EarnResult",
    "DecayRule",
    "DecayResult",
    "BookingResult",
]


@dataclass(frozen=True)
class EarnRule:
    """What an activity is worth.

    Note what is *not* here: a random span. RankMode deliberately randomises XP
    awards to make farming pointless, but EconomyWorld does not, and the reason
    is legal rather than technical. Random payouts are the mechanism behind loot
    boxes, and several EU jurisdictions treat those as gambling even without
    real money involved. This package contains no randomness at all -- see the
    "Deliberately absent" section of the README.
    """

    #: Identifier the caller passes to :meth:`EconomyEngine.earn`.
    key: str
    #: How much this activity pays, in minor units. Fixed, never random.
    amount: int
    #: Which currency it pays in.
    currency: str
    #: Minimum distance between two paying events of this kind, per member.
    cooldown_seconds: int = 0
    #: Ceiling per period, or ``None`` for no ceiling.
    period_cap_amount: int | None = None
    #: Length of the capping period.
    period_seconds: int = DEFAULT_PERIOD_SECONDS
    #: A disabled rule pays nothing and reports ``EarnOutcome.RULE_DISABLED``.
    enabled: bool = True


@dataclass
class EarnState:
    """What the caller has to remember about a member's earning.

    Small enough to live in one JSON column next to the balance. The caller owns
    it: load it, hand it in, store the copy that comes back.
    """

    #: rule key -> epoch milliseconds of the last payout.
    last_earned_at: dict[str, int] = field(default_factory=dict)
    #: rule key -> start of the running period.
    period_start_at: dict[str, int] = field(default_factory=dict)
    #: rule key -> how much has been paid inside the running period.
    period_earned: dict[str, int] = field(default_factory=dict)


class EarnOutcome(str, Enum):
    """Why an earning attempt turned out the way it did."""

    #: Currency was paid out.
    EARNED = "EARNED"
    #: The cooldown for this rule has not expired yet.
    COOLDOWN = "COOLDOWN"
    #: The period ceiling for this rule is exhausted.
    PERIOD_CAP = "PERIOD_CAP"
    #: The rule exists but is switched off.
    RULE_DISABLED = "RULE_DISABLED"
    #: No rule matched the key.
    UNKNOWN_RULE = "UNKNOWN_RULE"
    #: The account is already at the currency's ceiling.
    MAX_BALANCE_REACHED = "MAX_BALANCE_REACHED"
    #: The rule matched but the payable amount came to zero.
    NO_AMOUNT = "NO_AMOUNT"


@dataclass(frozen=True)
class BookingResult:
    """The result of a booking that always happens."""

    #: The complete booking.
    #:
    #: **Write every line of it in one database transaction.** See the module
    #: docstring of :mod:`economyworld.ledger` for why this is the caller's
    #: obligation and not the library's.
    posting: Posting
    #: Resulting balance per account key, for convenience.
    balances: Mapping[str, int]


@dataclass(frozen=True)
class EarnResult:
    """The result of an earning attempt, which may legitimately pay nothing."""

    outcome: EarnOutcome
    #: The booking, or ``None`` when nothing was paid.
    posting: Posting | None
    #: What was actually paid, after the ceiling was applied.
    amount: int
    #: What the rule would have paid without ceilings.
    gross_amount: int
    previous_balance: int
    new_balance: int
    #: Milliseconds until the cooldown expires. ``0`` when it is not active.
    cooldown_remaining_ms: int
    #: What is left of the period ceiling, or ``None`` when uncapped.
    period_remaining: int | None
    #: The rule that was applied, or ``None``.
    rule: EarnRule | None
    #: The new earning state. Persist it; the input is left untouched.
    state: EarnState

    @property
    def booked(self) -> bool:
        """True when there is a posting to write."""
        return self.posting is not None


@dataclass(frozen=True)
class DecayRule:
    """Optional shrinkage, so hoarded balances do not freeze an economy."""

    #: A flat amount removed per elapsed period.
    amount_per_period: int = 0
    #: A share of the balance removed per elapsed period, in permille.
    #:
    #: Applied after the flat amount. ``10`` means one percent per period.
    permille_per_period: int = 0
    period_seconds: int = DEFAULT_PERIOD_SECONDS
    #: Decay never pushes a balance below this.
    floor: int = 0
    #: No decay until this much time has passed since the last activity.
    grace_seconds: int = 0


@dataclass(frozen=True)
class DecayResult:
    """The result of a decay run."""

    #: The booking, or ``None`` when nothing was due.
    posting: Posting | None
    amount: int
    periods: int
    previous_balance: int
    new_balance: int
    #: Pass this back as ``last_applied_at`` on the next run.
    applied_up_to: int

    @property
    def booked(self) -> bool:
        """True when there is a posting to write."""
        return self.posting is not None
