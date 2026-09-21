/**
 * Values both language editions must agree on, byte for byte.
 *
 * A change in here changes the balances of existing members and is therefore
 * always a major version — see CHANGELOG.md.
 */

/**
 * Largest balance EconomyWorld will ever produce.
 *
 * `2^53 - 1`, the largest integer JavaScript can represent exactly. Python
 * could go further, but a balance only one edition can hold would break the
 * "identical results in both editions" guarantee, so both clamp here.
 */
/**
 * The version of this package.
 *
 * The Python edition exposes `economyworld.__version__`; a bug report asks for
 * one or the other, and a caller should not have to read package.json at
 * runtime to answer. Kept in step by `.github/scripts/check-versions.mjs`,
 * which fails the build if the four places disagree.
 */
export const VERSION = "2.0.0";

export const MAX_BALANCE = 9007199254740991;

/** Smallest balance, for accounts that are allowed to go negative. */
export const MIN_BALANCE = -9007199254740991;

/** `1000` permille = factor 1.0. Every factor is an integer to stay exact. */
export const PERMILLE_ONE = 1000;

/**
 * `10000` basis points = factor 1.0.
 *
 * The unit interest rates and fees come in, because permille cannot express
 * 2.5 % without losing the half. One basis point is a hundredth of a percent.
 */
export const BASIS_POINTS_ONE = 10000;

/** Default length of an earning period: 24 hours. */
export const DEFAULT_PERIOD_SECONDS = 86400;

/** Largest quantity a single inventory slot can hold. */
export const MAX_ITEM_QUANTITY = 1000000000;

/** How long a proposed trade stays open by default: 5 minutes. */
export const DEFAULT_TRADE_TTL_SECONDS = 300;

/** Owner prefix that marks an account as belonging to the system, not a person. */
export const SYSTEM_OWNER_PREFIX = "system:";
