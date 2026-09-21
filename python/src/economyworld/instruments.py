"""Things a member can hold besides currency: bonds, shares, units in a fund.

# This package has no prices, and that is the design

**Every price here is an argument.** There is no market model, no volatility, no
drift, no random walk. When a member buys, the caller says what a unit costs;
when a portfolio is valued, the caller says what a unit is worth today.

That is not a gap to be filled in a later version. A holding whose value moves
by chance is a wager, and several EU jurisdictions treat a wager as gambling
whether or not real money is involved -- the same reason this package has no
loot boxes and no random payouts. A product that wants prices to move builds and
legally reviews that mechanism itself; what it gets from here is the arithmetic
of holding, valuing and settling, which is the part that is easy to get subtly
wrong.

A **bond** is the exception that proves it: its coupon is fixed in its terms, so
its return is knowable in advance. That is why it is the one instrument this
module can pay out on by itself.

# Cost is averaged, and a part sale takes its share exactly

A member who bought 100 units at 10 and 100 more at 20 holds 200 units that cost
3000. Selling 50 removes ``3000 * 50 / 200`` of the cost -- computed exactly,
with the remainder staying on the position, so a series of part sales can never
leave a cost basis that does not match the units held.

Average cost rather than FIFO because it needs no lot history: a caller storing
one row per position can compute a correct gain, and one storing every purchase
separately can still do FIFO itself on top.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from enum import Enum

from .accounts import (
    Account,
    AccountRef,
    SystemAccount,
    account_key,
    empty_account,
    system_account,
)
from .engine import EconomyEngine
from .errors import (
    ConfigurationError,
    CurrencyMismatchError,
    InstrumentError,
    ValidationError,
)
from .ledger import PostingKind
from .money import apply_basis_points, apply_rate, assert_whole_amount, distribute
from .rounding import Rounding
from .types import BookingResult

__all__ = [
    "InstrumentKind",
    "Instrument",
    "Position",
    "Valuation",
    "TradeOutcome",
    "MAX_UNITS",
    "create_instrument",
    "open_position",
    "buy_units",
    "sell_units",
    "value_position",
    "value_portfolio",
    "unrealised_gain",
    "average_cost",
    "coupon_due",
    "pay_coupon",
    "distribute_dividend",
]

#: Most units of one instrument a single position may hold.
#:
#: Well inside the range where ``units * price`` stays exact, so a valuation
#: cannot overflow through quantity alone.
MAX_UNITS = 1_000_000_000


class InstrumentKind(str, Enum):
    """What sort of thing is being held."""

    #: Pays a fixed coupon and returns its face value at maturity. The only
    #: kind this module can pay out on unaided, because its return is written
    #: into its terms rather than discovered in a market.
    BOND = "BOND"
    #: A share in something. Worth what the caller says it is worth, and may
    #: receive a dividend the caller declares.
    SHARE = "SHARE"
    #: A quantity of a good. Same rule: the price is the caller's.
    COMMODITY = "COMMODITY"
    #: A unit in a pooled holding.
    FUND = "FUND"


@dataclass(frozen=True)
class Instrument:
    """Something that can be held, priced and settled."""

    instrument_id: str
    kind: InstrumentKind
    name: str
    #: What it is priced and settled in. A position and its instrument must
    #: agree, or a sale would credit the wrong currency.
    currency: str
    #: For a bond: what one unit repays at maturity. Zero for everything else.
    face_value: int = 0
    #: For a bond: what one unit pays each coupon period, in basis points of
    #: the face value. Zero for everything else.
    coupon_basis_points: int = 0
    #: Free-form context for the caller's own display.
    metadata: Mapping[str, str] | None = None


@dataclass(frozen=True)
class Position:
    """What one member holds of one instrument."""

    holder: AccountRef
    instrument_id: str
    units: int
    #: Everything paid for the units still held, less what part sales took with
    #: them. Divided by ``units`` it is the average cost.
    cost_basis: int
    #: Gains and losses already crystallised by selling. Kept so a statement can
    #: show performance without replaying every trade.
    realised_gain: int = 0


@dataclass(frozen=True)
class Valuation:
    """What a holding is worth at a price the caller supplied."""

    instrument_id: str
    units: int
    unit_price: int
    market_value: int
    cost_basis: int
    #: Market value less cost. Negative is a loss.
    unrealised_gain: int


#: A grant, an airdrop of founder shares, a bond handed out as a prize: units
#: really can change hands for nothing. There is no posting to make when they
#: do -- a zero-amount posting is not a thing this ledger will write -- so the
#: booking comes back as ``None``, exactly as a zero fee does.
@dataclass(frozen=True)
class TradeOutcome:
    """What buying or selling did. Write both parts in one transaction."""

    booking: BookingResult | None
    position: Position
    units: int
    unit_price: int
    consideration: int
    #: What this sale crystallised. Zero for a purchase.
    realised_gain: int = 0


def create_instrument(
    instrument_id: str,
    kind: InstrumentKind,
    currency: str,
    name: str | None = None,
    face_value: int = 0,
    coupon_basis_points: int = 0,
    metadata: Mapping[str, str] | None = None,
) -> Instrument:
    """Build a validated instrument."""
    if not isinstance(instrument_id, str) or not instrument_id:
        raise ConfigurationError(
            "An instrument needs a non-empty id", instrument_id=instrument_id
        )
    if not isinstance(currency, str) or not currency:
        raise ConfigurationError("An instrument needs a currency", currency=currency)
    assert_whole_amount(face_value)
    if face_value < 0:
        raise ConfigurationError("A face value cannot be negative", face_value=face_value)
    if (
        not isinstance(coupon_basis_points, int)
        or isinstance(coupon_basis_points, bool)
        or coupon_basis_points < 0
    ):
        raise ConfigurationError(
            "A coupon must be a non-negative integer number of basis points",
            coupon_basis_points=coupon_basis_points,
        )
    if kind is not InstrumentKind.BOND and (face_value or coupon_basis_points):
        raise ConfigurationError(
            "Only a bond has a face value and a coupon: for anything else the "
            "price is the caller's to supply",
            kind=kind.value,
        )
    if kind is InstrumentKind.BOND and face_value <= 0:
        raise ConfigurationError(
            "A bond needs a positive face value", instrument_id=instrument_id
        )
    return Instrument(
        instrument_id=instrument_id,
        kind=kind,
        name=name if name is not None else instrument_id,
        currency=currency,
        face_value=face_value,
        coupon_basis_points=coupon_basis_points,
        metadata=metadata,
    )


def open_position(holder: AccountRef, instrument: Instrument) -> Position:
    """An empty holding, before anything has been bought."""
    if holder.currency != instrument.currency:
        raise CurrencyMismatchError(expected=instrument.currency, received=holder.currency)
    return Position(
        holder=holder,
        instrument_id=instrument.instrument_id,
        units=0,
        cost_basis=0,
        realised_gain=0,
    )


def buy_units(
    engine: EconomyEngine,
    instrument: Instrument,
    position: Position,
    buyer: Account,
    units: int,
    unit_price: int,
    now: int,
    operation_id: str,
    reason: str,
    counterparty: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> TradeOutcome:
    """Buy units at a price the caller supplies.

    ``unit_price`` is an argument and always will be. See this module's opening
    note for why.

    The currency goes to ``counterparty`` if one is given -- another member, in
    a peer-to-peer sale -- and otherwise to the scope's market account, which is
    where an issuance from the community itself is paid.
    """
    _assert_units(units)
    _assert_price(unit_price)
    _assert_position(position, instrument, buyer)
    _assert_timestamp(now)

    if position.units + units > MAX_UNITS:
        raise InstrumentError(
            "That would take the position past the unit ceiling",
            units=position.units,
            buying=units,
            limit=MAX_UNITS,
        )

    consideration = _consideration(units, unit_price)
    booking = (
        None
        if consideration == 0
        else engine.transfer(
            source=buyer,
            target=counterparty
            or empty_account(
                system_account(buyer.ref.scope, instrument.currency, SystemAccount.MARKET)
            ),
            amount=consideration,
            now=now,
            operation_id=operation_id,
            reason=reason,
            kind=PostingKind.EXCHANGE,
            # The source here is the buyer. Whoever they are buying from, they pay
            # with currency they hold: no overdraft, no buying on margin.
            allow_negative=False,
            metadata=metadata,
        )
    )

    updated = replace(
        position,
        units=position.units + units,
        cost_basis=position.cost_basis + consideration,
    )
    return TradeOutcome(
        booking=booking,
        position=updated,
        units=units,
        unit_price=unit_price,
        consideration=consideration,
    )


def sell_units(
    engine: EconomyEngine,
    instrument: Instrument,
    position: Position,
    seller: Account,
    units: int,
    unit_price: int,
    now: int,
    operation_id: str,
    reason: str,
    counterparty: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> TradeOutcome:
    """Sell units at a price the caller supplies.

    The cost that leaves with the units is their exact share of the position's
    cost basis, so selling everything always leaves a cost basis of zero and a
    realised gain equal to every gain and loss along the way. Rounding cannot
    strand a few units of cost on an empty position.
    """
    _assert_units(units)
    _assert_price(unit_price)
    _assert_position(position, instrument, seller)
    _assert_timestamp(now)

    if units > position.units:
        raise InstrumentError(
            "That position does not hold that many units",
            held=position.units,
            selling=units,
        )

    consideration = _consideration(units, unit_price)
    # The exact share of the cost, so a full sale always clears the basis.
    cost_released = (
        position.cost_basis
        if units == position.units
        else apply_rate(position.cost_basis, units, position.units, Rounding.DOWN)
    )
    gain = consideration - cost_released

    booking = (
        None
        if consideration == 0
        else engine.transfer(
            source=counterparty
            or empty_account(
                system_account(seller.ref.scope, instrument.currency, SystemAccount.MARKET)
            ),
            target=seller,
            amount=consideration,
            now=now,
            operation_id=operation_id,
            reason=reason,
            kind=PostingKind.EXCHANGE,
            allow_negative=counterparty is None,
            metadata=metadata,
        )
    )

    updated = replace(
        position,
        units=position.units - units,
        cost_basis=position.cost_basis - cost_released,
        realised_gain=position.realised_gain + gain,
    )
    return TradeOutcome(
        booking=booking,
        position=updated,
        units=units,
        unit_price=unit_price,
        consideration=consideration,
        realised_gain=gain,
    )


def average_cost(position: Position) -> int:
    """What one unit cost on average. Zero for an empty position."""
    if position.units == 0:
        return 0
    return apply_rate(position.cost_basis, 1, position.units, Rounding.DOWN)


def value_position(position: Position, unit_price: int) -> Valuation:
    """What a holding is worth at a price the caller supplies."""
    _assert_price(unit_price)
    market_value = _consideration(position.units, unit_price) if position.units else 0
    return Valuation(
        instrument_id=position.instrument_id,
        units=position.units,
        unit_price=unit_price,
        market_value=market_value,
        cost_basis=position.cost_basis,
        unrealised_gain=market_value - position.cost_basis,
    )


def value_portfolio(
    positions: Sequence[Position], prices: Mapping[str, int]
) -> list[Valuation]:
    """Value every holding a member has, at prices the caller supplies.

    A position whose instrument has no price is an error rather than a zero: a
    portfolio total that quietly omitted a holding would be a number a member
    makes decisions on and that is wrong.
    """
    valuations = []
    for position in positions:
        price = prices.get(position.instrument_id)
        if price is None:
            raise InstrumentError(
                "No price was supplied for a held instrument",
                instrument_id=position.instrument_id,
            )
        valuations.append(value_position(position, price))
    return valuations


def unrealised_gain(positions: Sequence[Position], prices: Mapping[str, int]) -> int:
    """What a portfolio is up or down, before anything is sold."""
    return sum(v.unrealised_gain for v in value_portfolio(positions, prices))


def coupon_due(instrument: Instrument, units: int, periods: int = 1) -> int:
    """What a bond pays its holder over ``periods`` coupon dates.

    Fixed by the bond's terms and knowable in advance, which is what separates
    it from every other instrument here.
    """
    if instrument.kind is not InstrumentKind.BOND:
        raise InstrumentError(
            "Only a bond pays a coupon", instrument_id=instrument.instrument_id
        )
    _assert_units(units, allow_zero=True)
    if not isinstance(periods, int) or isinstance(periods, bool) or periods < 0:
        raise ValidationError("periods must be a non-negative integer", periods=periods)
    if units == 0 or periods == 0:
        return 0
    per_unit = apply_basis_points(
        instrument.face_value, instrument.coupon_basis_points, Rounding.DOWN
    )
    total = per_unit * units * periods
    assert_whole_amount(total)
    return total


def pay_coupon(
    engine: EconomyEngine,
    instrument: Instrument,
    position: Position,
    holder: Account,
    now: int,
    operation_id: str,
    reason: str,
    periods: int = 1,
    source: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> BookingResult | None:
    """Pay a bond's coupon to its holder.

    Issued from the mint unless the caller names another source, exactly like
    interest on a deposit and for the same reason: in a closed economy a
    payment that is not funded by somebody is new currency, and the posting
    should say so.

    ``None`` when there is nothing to pay -- no units, or a coupon too small to
    round to a whole unit.
    """
    _assert_timestamp(now)
    _assert_position(position, instrument, holder)
    amount = coupon_due(instrument, position.units, periods)
    if amount == 0:
        return None
    return engine.transfer(
        source=source
        or empty_account(
            system_account(holder.ref.scope, instrument.currency, SystemAccount.MINT)
        ),
        target=holder,
        amount=amount,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.DISTRIBUTION,
        # The mint issues; a named payer pays out of its own balance.
        allow_negative=source is None,
        metadata=metadata,
    )


def distribute_dividend(
    positions: Sequence[Position], total: int
) -> list[tuple[AccountRef, int]]:
    """Split a declared dividend between holders, by units held, exactly.

    The amount is the caller's to declare -- this module has no notion of
    profit and will not invent one. What it guarantees is that the shares add up
    to the declared total, so a community that declares 1000 pays out 1000 and
    not 999 with a unit lost to three-way rounding.

    Comes back as pairs rather than as postings: the caller books them, and
    which account funds a dividend is a decision this module should not make.
    """
    assert_whole_amount(total)
    if total < 0:
        raise ValidationError("A dividend cannot be negative", total=total)
    holding = [p for p in positions if p.units > 0]
    if not holding:
        raise InstrumentError("There is nobody holding units to pay a dividend to")
    shares = distribute(total, [p.units for p in holding])
    return [(p.holder, share) for p, share in zip(holding, shares, strict=True)]


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _consideration(units: int, unit_price: int) -> int:
    total = units * unit_price
    assert_whole_amount(total)
    return total


def _assert_units(units: int, allow_zero: bool = False) -> None:
    if not isinstance(units, int) or isinstance(units, bool):
        raise ValidationError("units must be an integer", units=units)
    if units < 0 or (units == 0 and not allow_zero):
        raise ValidationError("units must be positive", units=units)
    if units > MAX_UNITS:
        raise InstrumentError(
            "units is past the ceiling a position may hold", units=units, limit=MAX_UNITS
        )


def _assert_price(unit_price: int) -> None:
    assert_whole_amount(unit_price)
    if unit_price < 0:
        raise ValidationError("A price cannot be negative", unit_price=unit_price)


def _assert_position(position: Position, instrument: Instrument, account: Account) -> None:
    if position.instrument_id != instrument.instrument_id:
        raise InstrumentError(
            "The position and the instrument do not match",
            position=position.instrument_id,
            instrument=instrument.instrument_id,
        )
    if account.ref != position.holder:
        raise InstrumentError(
            "That account does not hold this position",
            holder=account_key(position.holder),
            given=account_key(account.ref),
        )
    if account.ref.currency != instrument.currency:
        raise CurrencyMismatchError(
            expected=instrument.currency, received=account.ref.currency
        )


def _assert_timestamp(now: int) -> None:
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError("Timestamps are epoch milliseconds as integers", timestamp=now)
