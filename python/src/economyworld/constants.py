"""Values both language editions must agree on, byte for byte.

A change in here changes the balances of existing members and is therefore
always a major version -- see CHANGELOG.md.
"""

from __future__ import annotations

#: Largest balance EconomyWorld will ever produce.
#:
#: ``2**53 - 1``, the largest integer JavaScript can represent exactly. Python
#: could go further, but a balance only one edition can hold would break the
#: "identical results in both editions" guarantee, so both clamp here.
MAX_BALANCE = 9007199254740991

#: Smallest balance, for accounts that are allowed to go negative.
MIN_BALANCE = -9007199254740991

#: ``1000`` permille = factor 1.0. Every factor is an integer to stay exact.
PERMILLE_ONE = 1000

#: ``10000`` basis points = factor 1.0.
#:
#: The unit interest rates and fees come in, because permille cannot express
#: 2.5 % without losing the half. One basis point is a hundredth of a percent.
BASIS_POINTS_ONE = 10000

#: Default length of an earning period: 24 hours.
DEFAULT_PERIOD_SECONDS = 86400

#: Largest quantity a single inventory slot can hold.
MAX_ITEM_QUANTITY = 1000000000

#: How long a proposed trade stays open by default: 5 minutes.
DEFAULT_TRADE_TTL_SECONDS = 300

#: Owner prefix that marks an account as belonging to the system, not a person.
SYSTEM_OWNER_PREFIX = "system:"

__all__ = [
    "MAX_BALANCE",
    "MIN_BALANCE",
    "PERMILLE_ONE",
    "BASIS_POINTS_ONE",
    "DEFAULT_PERIOD_SECONDS",
    "MAX_ITEM_QUANTITY",
    "DEFAULT_TRADE_TTL_SECONDS",
    "SYSTEM_OWNER_PREFIX",
]
