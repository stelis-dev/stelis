/**
 * Exact decimal parsing helpers for sandbox user-entered amounts.
 *
 * These helpers intentionally avoid Number arithmetic so payment amounts and
 * slippage BPS cannot drift through floating-point rounding.
 */

const DECIMAL_AMOUNT_RE = /^\d+(?:\.\d+)?$/;
const DECIMAL_INTEGER_RE = /^(?:0|[1-9]\d*)$/;

export function parseDecimalIntegerToBigInt(value: string, label: string): bigint {
  if (!DECIMAL_INTEGER_RE.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

export function parseDecimalToSmallestUnit(value: string, decimals: number, label: string): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`${label} decimals must be a non-negative integer`);
  }

  const trimmed = value.trim();
  if (!DECIMAL_AMOUNT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }

  const [wholePart, fracPart = ''] = trimmed.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`${label} cannot have more than ${decimals} decimal places`);
  }

  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholePart);
  const frac = fracPart.length === 0 ? 0n : BigInt(fracPart.padEnd(decimals, '0'));
  return whole * scale + frac;
}

export function parsePercentToBps(value: string, maxBps: number, label: string): number {
  if (!Number.isSafeInteger(maxBps) || maxBps < 0 || maxBps > 10_000) {
    throw new Error(`${label} maxBps must be a safe integer in [0, 10000]`);
  }
  const bps = parseDecimalToSmallestUnit(value, 2, label);
  if (bps > BigInt(maxBps)) {
    throw new Error(`${label} must be between 0 and ${maxBps / 100}%`);
  }
  return Number(bps);
}

export function formatSmallestUnitDecimal(
  amount: bigint,
  decimals: number,
  fractionDigits: number,
): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('decimals must be a non-negative integer');
  }
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > decimals) {
    throw new Error('fractionDigits must be an integer between 0 and decimals');
  }

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').slice(0, fractionDigits);
  return `${negative ? '-' : ''}${whole.toString()}${fractionDigits > 0 ? `.${frac}` : ''}`;
}
