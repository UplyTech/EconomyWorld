"""The economy engine: balances in, a complete booking out.

Every method is pure with respect to its arguments. Nothing is stored, nothing
is logged, no clock is read. What comes back is a
:class:`~economyworld.ledger.Posting` that the caller must write **in a single
database transaction** -- see the module docstring of
:mod:`economyworld.ledger`.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .accounts import (
    Account,
    AccountRef,
    SystemAccount,
    account_key,
    empty_account,
    is_system_account,
    system_account,
)
from .constants import DEFAULT_PERIOD_SECONDS, MIN_BALANCE
from .errors import (
    BalanceOverflowError,
    ConfigurationError,
    CurrencyMismatchError,
    InsufficientFundsError,
    ReversalError,
    UnknownReferenceError,
    ValidationError,
)
from .ledger import (
    Posting,
    PostingKind,
    PostingLine,
    create_posting,
    resulting_balances,
)
from .money import Currency, assert_positive_amount, create_currency
from .types import (
    BookingResult,
    DecayResult,
    DecayRule,
    EarnOutcome,
    EarnResult,
    EarnRule,
    EarnState,
)

__all__ = [
    "EconomyEngine",
    "EconomyConfig",
    "create_earn_rule",
    "create_earn_state",
    "clone_earn_state",
    "serialize_earn_state",
    "deserialize_earn_state",
]


@dataclass(frozen=True)
class EconomyConfig:
    """The frozen, validated configuration of an :class:`EconomyEngine`."""

    currencies: Mapping[str, Currency]
    earn_rules: Mapping[str, EarnRule]
    allow_negative: bool
    shop_account_owner: str


class EconomyEngine:
    """Computes bookings against a set of currencies and earning rules."""

    def __init__(
        self,
        currencies: Iterable[Currency | str],
        earn_rules: Iterable[EarnRule] | None = None,
        allow_negative: bool = False,
        shop_account_owner: str = SystemAccount.SHOP.value,
    ) -> None:
        self.config = _freeze_config(
            currencies=currencies,
            earn_rules=earn_rules,
            allow_negative=allow_negative,
            shop_account_owner=shop_account_owner,
        )

    # -- queries ----------------------------------------------------------

    def currency(self, code: str) -> Currency:
        """A configured currency, or a raised :class:`UnknownReferenceError`."""
        found = self.config.currencies.get(code)
        if found is None:
            raise UnknownReferenceError("currency", code)
        return found

    def earn_rule(self, key: str) -> EarnRule | None:
        """An earning rule, or ``None``."""
        return self.config.earn_rules.get(key)

    # -- the three primitive bookings -------------------------------------

    def credit(
        self,
        target: Account,
        amount: int,
        now: int,
        operation_id: str,
        reason: str,
        source: Account | None = None,
        metadata: Mapping[str, str] | None = None,
    ) -> BookingResult:
        """Issue new currency into an account.

        The counter-line is the scope's mint, which goes negative by exactly the
        amount issued. That is not an accident of the design -- it is what lets
        you ask "how much currency exists in this scope?" and get an answer that
        is checkable rather than assumed.
        """
        assert_positive_amount(amount)
        _assert_timestamp(now)
        currency = self.currency(target.ref.currency)
        self._assert_headroom(target, amount, currency)

        resolved_source = source or empty_account(
            system_account(target.ref.scope, target.ref.currency, SystemAccount.MINT)
        )
        _assert_same_currency(resolved_source.ref, target.ref)

        return self._book(
            kind=PostingKind.CREDIT,
            source=resolved_source,
            target=target,
            amount=amount,
            now=now,
            operation_id=operation_id,
            reason=reason,
            metadata=metadata,
        )

    def debit(
        self,
        source: Account,
        amount: int,
        now: int,
        operation_id: str,
        reason: str,
        target: Account | None = None,
        allow_negative: bool | None = None,
        metadata: Mapping[str, str] | None = None,
    ) -> BookingResult:
        """Take currency out of an account and out of circulation.

        The counter-line is the scope's sink. Use this for fees, fines and
        anything else that should reduce the money supply rather than move it to
        someone.
        """
        assert_positive_amount(amount)
        _assert_timestamp(now)
        self.currency(source.ref.currency)
        self._assert_funds(source, amount, allow_negative)

        resolved_target = target or empty_account(
            system_account(source.ref.scope, source.ref.currency, SystemAccount.SINK)
        )
        _assert_same_currency(source.ref, resolved_target.ref)

        return self._book(
            kind=PostingKind.DEBIT,
            source=source,
            target=resolved_target,
            amount=amount,
            now=now,
            operation_id=operation_id,
            reason=reason,
            metadata=metadata,
        )

    def transfer(
        self,
        source: Account,
        target: Account,
        amount: int,
        now: int,
        operation_id: str,
        reason: str,
        allow_negative: bool | None = None,
        metadata: Mapping[str, str] | None = None,
        kind: PostingKind = PostingKind.TRANSFER,
    ) -> BookingResult:
        """Move currency between two accounts.

        The most common booking after earning and spending, and the one the
        concept singles out: a transfer is two changes that must both happen or
        neither. The posting you get back expresses exactly that; writing it
        atomically is your side of the bargain.

        ``kind`` labels the posting. It defaults to ``TRANSFER`` and exists so
        that the subsystems built on top of this one -- a deposit, an
        instalment, a fee -- produce postings an audit trail can tell apart.
        Two members paying each other and a loan being disbursed are both money
        moving between accounts, and only the label says which is which.
        """
        assert_positive_amount(amount)
        _assert_timestamp(now)
        _assert_same_currency(source.ref, target.ref)
        if source.ref.scope != target.ref.scope:
            raise ValidationError(
                "A transfer cannot cross scopes",
                source=source.ref.scope,
                target=target.ref.scope,
            )
        if source.ref == target.ref:
            raise ValidationError(
                "An account cannot transfer to itself", account=account_key(source.ref)
            )

        currency = self.currency(source.ref.currency)
        self._assert_funds(source, amount, allow_negative)
        self._assert_headroom(target, amount, currency)

        return self._book(
            kind=kind,
            source=source,
            target=target,
            amount=amount,
            now=now,
            operation_id=operation_id,
            reason=reason,
            metadata=metadata,
        )

    # -- earning ----------------------------------------------------------

    def earn(
        self,
        target: Account,
        rule_key: str,
        state: EarnState,
        now: int,
        operation_id: str,
        reason: str,
        source: Account | None = None,
        metadata: Mapping[str, str] | None = None,
    ) -> EarnResult:
        """Pay a member for an activity, subject to cooldown and daily ceiling.

        The order of checks is fixed and part of the public contract:

        1. find the rule -- an unknown key pays nothing
        2. rule disabled -- pays nothing
        3. cooldown -- pays nothing, and does **not** restart the cooldown
        4. take the rule's fixed amount (never random -- see :class:`EarnRule`)
        5. trim to what is left of the period ceiling
        6. trim to the account's headroom under the currency ceiling

        Steps 3, 5 and 6 produce an outcome rather than an exception: an
        exhausted cooldown is normal operation, not a fault.

        Without limits, a community economy is worthless within days -- which is
        why the cooldown and the ceiling are core parameters of the rule rather
        than something bolted on later.
        """
        _assert_timestamp(now)
        rule = self.earn_rule(rule_key)
        previous_balance = target.balance

        if rule is None:
            return _nothing_earned(
                EarnOutcome.UNKNOWN_RULE, None, previous_balance, state, 0, None
            )
        if not rule.enabled:
            return _nothing_earned(
                EarnOutcome.RULE_DISABLED, rule, previous_balance, state, 0, None
            )
        if rule.currency != target.ref.currency:
            raise CurrencyMismatchError(
                expected=rule.currency,
                received=target.ref.currency,
                account=account_key(target.ref),
            )

        cooldown_remaining = self.earn_cooldown_remaining_ms(state, rule_key, now)
        if cooldown_remaining > 0:
            return _nothing_earned(
                EarnOutcome.COOLDOWN,
                rule,
                previous_balance,
                state,
                cooldown_remaining,
                self.earn_period_remaining(state, rule_key, now),
            )

        currency = self.currency(rule.currency)
        if previous_balance >= currency.max_balance:
            return _nothing_earned(
                EarnOutcome.MAX_BALANCE_REACHED, rule, previous_balance, state, 0, None
            )

        gross_amount = rule.amount
        amount = gross_amount

        period_remaining = self.earn_period_remaining(state, rule_key, now)
        if period_remaining is not None:
            if period_remaining <= 0:
                return _nothing_earned(
                    EarnOutcome.PERIOD_CAP,
                    rule,
                    previous_balance,
                    state,
                    0,
                    period_remaining,
                )
            amount = min(amount, period_remaining)

        amount = min(amount, currency.max_balance - previous_balance)

        if amount <= 0:
            return _nothing_earned(
                EarnOutcome.NO_AMOUNT, rule, previous_balance, state, 0, period_remaining
            )

        resolved_source = source or empty_account(
            system_account(target.ref.scope, target.ref.currency, SystemAccount.MINT)
        )
        booking = self._book(
            kind=PostingKind.EARN,
            source=resolved_source,
            target=target,
            amount=amount,
            now=now,
            operation_id=operation_id,
            reason=reason,
            metadata={**dict(metadata or {}), "earnRule": rule_key},
        )

        next_state = clone_earn_state(state)
        if rule.cooldown_seconds > 0:
            next_state.last_earned_at[rule_key] = now
        if rule.period_cap_amount is not None:
            _record_in_period(next_state, rule_key, amount, rule.period_seconds, now)

        return EarnResult(
            outcome=EarnOutcome.EARNED,
            posting=booking.posting,
            amount=amount,
            gross_amount=gross_amount,
            previous_balance=previous_balance,
            new_balance=previous_balance + amount,
            cooldown_remaining_ms=rule.cooldown_seconds * 1000,
            period_remaining=self.earn_period_remaining(next_state, rule_key, now),
            rule=rule,
            state=next_state,
        )

    def earn_cooldown_remaining_ms(self, state: EarnState, rule_key: str, now: int) -> int:
        """Milliseconds until the member may earn from this rule again."""
        rule = self.earn_rule(rule_key)
        if rule is None or rule.cooldown_seconds <= 0:
            return 0
        last = state.last_earned_at.get(rule_key)
        if last is None:
            return 0
        remaining = rule.cooldown_seconds * 1000 - (now - last)
        return remaining if remaining > 0 else 0

    def earn_period_remaining(self, state: EarnState, rule_key: str, now: int) -> int | None:
        """What is left of the rule's period ceiling, or ``None`` when uncapped."""
        rule = self.earn_rule(rule_key)
        if rule is None or rule.period_cap_amount is None:
            return None
        start = state.period_start_at.get(rule_key)
        if start is None or now - start >= rule.period_seconds * 1000:
            return rule.period_cap_amount
        used = state.period_earned.get(rule_key, 0)
        remaining = rule.period_cap_amount - used
        return remaining if remaining > 0 else 0

    def can_earn(self, state: EarnState, rule_key: str, now: int) -> bool:
        """True when the member could earn from this rule right now."""
        rule = self.earn_rule(rule_key)
        if rule is None or not rule.enabled:
            return False
        if self.earn_cooldown_remaining_ms(state, rule_key, now) > 0:
            return False
        remaining = self.earn_period_remaining(state, rule_key, now)
        return remaining is None or remaining > 0

    # -- reversal ---------------------------------------------------------

    def reverse(
        self,
        original: Posting,
        balances: Mapping[str, int],
        now: int,
        operation_id: str,
        reason: str,
        allow_negative: bool | None = None,
        metadata: Mapping[str, str] | None = None,
    ) -> BookingResult:
        """Undo an earlier posting by booking its exact inverse.

        Moderation needs a counterpart to every action, and an economy needs it
        to leave a trace: the original booking stays, and a second one cancels
        it. Deleting the first would leave an audit trail that lies about what
        happened.

        ``balances`` must carry the *current* balance of every account the
        original posting touched -- not the balance at the time, which may have
        moved on.
        """
        _assert_timestamp(now)
        if original.kind is PostingKind.REVERSAL:
            raise ReversalError(
                "A reversal cannot itself be reversed",
                operation_id=original.operation_id,
            )
        if original.operation_id == operation_id:
            raise ReversalError(
                "A reversal needs its own operation id", operation_id=operation_id
            )

        permitted = (
            allow_negative if allow_negative is not None else self.config.allow_negative
        )

        lines: list[PostingLine] = []
        for line in original.lines:
            key = account_key(line.account)
            if key not in balances:
                raise ReversalError(
                    "The current balance of every account in the original posting is required",
                    account=key,
                )
            current = balances[key]
            delta = -line.delta
            after = current + delta
            if (
                delta < 0
                and after < 0
                and not is_system_account(line.account)
                and not permitted
            ):
                raise InsufficientFundsError(
                    account=key,
                    balance=current,
                    required=-delta,
                    currency=line.account.currency,
                )
            lines.append(
                PostingLine(
                    account=line.account,
                    delta=delta,
                    balance_before=current,
                    balance_after=after,
                )
            )

        posting = create_posting(
            operation_id=operation_id,
            kind=PostingKind.REVERSAL,
            scope=original.scope,
            currency=original.currency,
            amount=original.amount,
            reason=reason,
            occurred_at=now,
            lines=lines,
            reverses=original.operation_id,
            metadata={**dict(metadata or {}), "reversedKind": original.kind.value},
        )
        return BookingResult(posting=posting, balances=resulting_balances(posting))

    # -- decay ------------------------------------------------------------

    def apply_decay(
        self,
        target: Account,
        rule: DecayRule,
        now: int,
        operation_id: str,
        reason: str,
        last_activity_at: int,
        last_applied_at: int | None = None,
        sink: Account | None = None,
        metadata: Mapping[str, str] | None = None,
    ) -> DecayResult:
        """Shrink an idle balance, so hoarding does not freeze the economy.

        Charged per whole elapsed period, so running it nightly and running it
        once a month cost the same. The flat amount is taken first, then the
        permille share of what remains, once per period.

        Two timestamps, and the difference between them matters:

        - ``last_activity_at`` is when the member last did something. The grace
          window is measured from here.
        - ``last_applied_at`` is the ``applied_up_to`` of the previous decay run,
          or ``None`` if decay has never run for this account.

        They are separate on purpose. Measuring the grace window from the last
        *decay run* would push it forward every time decay ran, so a nightly job
        would charge less than a monthly one -- and an idle balance would never
        shrink at all.
        """
        _assert_timestamp(now)
        _assert_timestamp(last_activity_at)
        _assert_decay_rule(rule)
        previous_balance = target.balance

        grace_end = last_activity_at + rule.grace_seconds * 1000
        decay_start = grace_end if last_applied_at is None else max(last_applied_at, grace_end)
        period_ms = rule.period_seconds * 1000

        def unchanged() -> DecayResult:
            return DecayResult(
                posting=None,
                amount=0,
                periods=0,
                previous_balance=previous_balance,
                new_balance=previous_balance,
                applied_up_to=last_applied_at if last_applied_at is not None else decay_start,
            )

        if now <= decay_start:
            return unchanged()

        periods = (now - decay_start) // period_ms
        if periods <= 0:
            return unchanged()

        balance = previous_balance
        for _period in range(periods):
            if balance <= rule.floor:
                break
            balance -= rule.amount_per_period
            if rule.permille_per_period > 0 and balance > 0:
                balance -= (balance * rule.permille_per_period) // 1000
            if balance < rule.floor:
                balance = rule.floor

        amount = previous_balance - balance
        applied_up_to = decay_start + periods * period_ms

        if amount <= 0:
            return DecayResult(
                posting=None,
                amount=0,
                periods=periods,
                previous_balance=previous_balance,
                new_balance=previous_balance,
                applied_up_to=applied_up_to,
            )

        resolved_sink = sink or empty_account(
            system_account(target.ref.scope, target.ref.currency, SystemAccount.SINK)
        )
        booking = self._book(
            kind=PostingKind.DECAY,
            source=target,
            target=resolved_sink,
            amount=amount,
            now=now,
            operation_id=operation_id,
            reason=reason,
            metadata={**dict(metadata or {}), "periods": str(periods)},
        )

        return DecayResult(
            posting=booking.posting,
            amount=amount,
            periods=periods,
            previous_balance=previous_balance,
            new_balance=balance,
            applied_up_to=applied_up_to,
        )

    # -- internals --------------------------------------------------------

    def _book(
        self,
        kind: PostingKind,
        source: Account,
        target: Account,
        amount: int,
        now: int,
        operation_id: str,
        reason: str,
        metadata: Mapping[str, str] | None,
    ) -> BookingResult:
        """Build the two-line posting every primitive booking comes down to."""
        lines = [
            PostingLine(
                account=source.ref,
                delta=-amount,
                balance_before=source.balance,
                balance_after=source.balance - amount,
            ),
            PostingLine(
                account=target.ref,
                delta=amount,
                balance_before=target.balance,
                balance_after=target.balance + amount,
            ),
        ]
        posting = create_posting(
            operation_id=operation_id,
            kind=kind,
            scope=source.ref.scope,
            currency=source.ref.currency,
            amount=amount,
            reason=reason,
            occurred_at=now,
            lines=lines,
            metadata=metadata,
        )
        return BookingResult(posting=posting, balances=resulting_balances(posting))

    def _assert_funds(self, source: Account, amount: int, allow_negative: bool | None) -> None:
        if is_system_account(source.ref):
            # The mint and the sink are allowed to go arbitrarily negative --
            # that is what they are for.
            return
        permitted = (
            allow_negative if allow_negative is not None else self.config.allow_negative
        )
        if not permitted and source.balance < amount:
            raise InsufficientFundsError(
                account=account_key(source.ref),
                balance=source.balance,
                required=amount,
                currency=source.ref.currency,
            )
        if permitted and source.balance - amount < MIN_BALANCE:
            raise InsufficientFundsError(
                account=account_key(source.ref),
                balance=source.balance,
                required=amount,
                currency=source.ref.currency,
            )

    def _assert_headroom(self, target: Account, amount: int, currency: Currency) -> None:
        if is_system_account(target.ref):
            return
        if target.balance + amount > currency.max_balance:
            raise BalanceOverflowError(
                account=account_key(target.ref),
                balance=target.balance,
                amount=amount,
                max_balance=currency.max_balance,
            )


def create_earn_rule(
    key: str,
    amount: int,
    currency: str,
    cooldown_seconds: int = 0,
    period_cap_amount: int | None = None,
    period_seconds: int = DEFAULT_PERIOD_SECONDS,
    enabled: bool = True,
) -> EarnRule:
    """Build a validated :class:`~economyworld.types.EarnRule`."""
    if not isinstance(key, str) or not key:
        raise ConfigurationError("An earn rule needs a non-empty key", key=key)
    if not isinstance(currency, str) or not currency:
        raise ConfigurationError("An earn rule needs a currency", key=key)
    _require_non_negative_int(amount, "amount")
    _require_non_negative_int(cooldown_seconds, "cooldown_seconds")
    if period_cap_amount is not None:
        _require_non_negative_int(period_cap_amount, "period_cap_amount")
    if (
        not isinstance(period_seconds, int)
        or isinstance(period_seconds, bool)
        or period_seconds <= 0
    ):
        raise ConfigurationError(
            "period_seconds must be a positive integer", period_seconds=period_seconds
        )

    return EarnRule(
        key=key,
        amount=amount,
        currency=currency,
        cooldown_seconds=cooldown_seconds,
        period_cap_amount=period_cap_amount,
        period_seconds=period_seconds,
        enabled=enabled,
    )


def create_earn_state() -> EarnState:
    """A fresh earning state for a member who has not earned anything yet."""
    return EarnState()


def clone_earn_state(state: EarnState) -> EarnState:
    """Deep copy. The engine never mutates the state it is handed."""
    return EarnState(
        last_earned_at=dict(state.last_earned_at),
        period_start_at=dict(state.period_start_at),
        period_earned=dict(state.period_earned),
    )


def serialize_earn_state(state: EarnState) -> dict[str, Any]:
    """Plain-dict form, ready for :func:`json.dumps`.

    The field names are the JSON ones, shared with the TypeScript edition, so a
    bot ported between them keeps its data.
    """
    return {
        "lastEarnedAt": dict(state.last_earned_at),
        "periodStartAt": dict(state.period_start_at),
        "periodEarned": dict(state.period_earned),
    }


def deserialize_earn_state(raw: Mapping[str, Any]) -> EarnState:
    """Rebuild an earning state from stored data, filling in missing fields."""
    if not isinstance(raw, Mapping):
        raise ValidationError("An earn state must be a mapping")
    return EarnState(
        last_earned_at=_read_int_map(
            _pick(raw, "lastEarnedAt", "last_earned_at"), "lastEarnedAt"
        ),
        period_start_at=_read_int_map(
            _pick(raw, "periodStartAt", "period_start_at"), "periodStartAt"
        ),
        period_earned=_read_int_map(
            _pick(raw, "periodEarned", "period_earned"), "periodEarned"
        ),
    )


def _pick(raw: Mapping[str, Any], json_key: str, python_key: str) -> Any:
    if raw.get(json_key) is not None:
        return raw[json_key]
    if raw.get(python_key) is not None:
        return raw[python_key]
    return None


def _read_int_map(value: Any, field: str) -> dict[str, int]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValidationError(f"{field} must be a mapping", field=field)
    result: dict[str, int] = {}
    for key, entry in value.items():
        if not isinstance(entry, int) or isinstance(entry, bool):
            raise ValidationError(
                f"{field} contains a non-integer value", key=key, entry=entry
            )
        result[str(key)] = entry
    return result


def _nothing_earned(
    outcome: EarnOutcome,
    rule: EarnRule | None,
    balance: int,
    state: EarnState,
    cooldown_remaining_ms: int,
    period_remaining: int | None,
) -> EarnResult:
    return EarnResult(
        outcome=outcome,
        posting=None,
        amount=0,
        gross_amount=rule.amount if rule is not None else 0,
        previous_balance=balance,
        new_balance=balance,
        cooldown_remaining_ms=cooldown_remaining_ms,
        period_remaining=period_remaining,
        rule=rule,
        state=clone_earn_state(state),
    )


def _record_in_period(
    state: EarnState, key: str, amount: int, period_seconds: int, now: int
) -> None:
    start = state.period_start_at.get(key)
    if start is None or now - start >= period_seconds * 1000:
        state.period_start_at[key] = now
        state.period_earned[key] = amount
        return
    state.period_earned[key] = state.period_earned.get(key, 0) + amount


def _assert_same_currency(a: AccountRef, b: AccountRef) -> None:
    if a.currency != b.currency:
        raise CurrencyMismatchError(expected=a.currency, received=b.currency)


def _assert_timestamp(now: Any) -> None:
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError("Timestamps must be epoch milliseconds as integers", now=now)


def _require_non_negative_int(value: Any, name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ConfigurationError(f"{name} must be a non-negative integer", **{name: value})


def _assert_decay_rule(rule: DecayRule) -> None:
    if (
        not isinstance(rule.amount_per_period, int)
        or isinstance(rule.amount_per_period, bool)
        or rule.amount_per_period < 0
    ):
        raise ConfigurationError(
            "amount_per_period must be a non-negative integer",
            amount_per_period=rule.amount_per_period,
        )
    if (
        not isinstance(rule.permille_per_period, int)
        or isinstance(rule.permille_per_period, bool)
        or rule.permille_per_period < 0
        or rule.permille_per_period > 1000
    ):
        raise ConfigurationError(
            "permille_per_period must be an integer in 0..1000",
            permille_per_period=rule.permille_per_period,
        )
    if (
        not isinstance(rule.period_seconds, int)
        or isinstance(rule.period_seconds, bool)
        or rule.period_seconds <= 0
    ):
        raise ConfigurationError(
            "period_seconds must be a positive integer",
            period_seconds=rule.period_seconds,
        )
    if not isinstance(rule.floor, int) or isinstance(rule.floor, bool):
        raise ConfigurationError("floor must be an integer", floor=rule.floor)
    if (
        not isinstance(rule.grace_seconds, int)
        or isinstance(rule.grace_seconds, bool)
        or rule.grace_seconds < 0
    ):
        raise ConfigurationError(
            "grace_seconds must be a non-negative integer",
            grace_seconds=rule.grace_seconds,
        )
    if rule.amount_per_period == 0 and rule.permille_per_period == 0:
        raise ConfigurationError(
            "A decay rule that removes nothing is a configuration mistake"
        )


def _freeze_config(
    currencies: Iterable[Currency | str],
    earn_rules: Iterable[EarnRule] | None,
    allow_negative: bool,
    shop_account_owner: str,
) -> EconomyConfig:
    resolved: dict[str, Currency] = {}
    for entry in currencies:
        currency = create_currency(entry) if isinstance(entry, str) else entry
        if not isinstance(currency, Currency):
            raise ConfigurationError(
                "currencies must contain Currency instances or currency codes",
                received=type(entry).__name__,
            )
        if currency.code in resolved:
            raise ConfigurationError("Duplicate currency code", code=currency.code)
        resolved[currency.code] = currency

    if not resolved:
        raise ConfigurationError("An economy needs at least one currency")

    rules: dict[str, EarnRule] = {}
    for rule in earn_rules or ():
        if not isinstance(rule, EarnRule):
            raise ConfigurationError(
                "earn_rules must contain EarnRule instances; use create_earn_rule",
                received=type(rule).__name__,
            )
        if rule.key in rules:
            raise ConfigurationError("Duplicate earn rule key", key=rule.key)
        if rule.currency not in resolved:
            raise ConfigurationError(
                "An earn rule references an unknown currency",
                key=rule.key,
                currency=rule.currency,
            )
        rules[rule.key] = rule

    if shop_account_owner not in {kind.value for kind in SystemAccount}:
        # Silently redirecting the takings, or inventing an account no report
        # knows about, both hide the mistake until somebody asks where a
        # scope's shop revenue went.
        raise ConfigurationError(
            "shop_account_owner must name a system account",
            shop_account_owner=shop_account_owner,
            allowed=sorted(kind.value for kind in SystemAccount),
        )

    return EconomyConfig(
        currencies=resolved,
        earn_rules=rules,
        allow_negative=allow_negative,
        shop_account_owner=shop_account_owner,
    )
