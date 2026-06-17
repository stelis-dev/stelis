const SAFE_NUMBER_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_BIGINT_RE = /^(?:0|[1-9]\d*)$/;

export function parseDecimalBigInt(value: string, label: string): bigint {
  if (!DECIMAL_BIGINT_RE.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

export function bigintToSafeNumberOrNull(value: bigint): number | null {
  if (value < 0n || value > SAFE_NUMBER_MAX) return null;
  return Number(value);
}

export function formatSmallestUnitDecimal(
  amount: bigint,
  decimals: number,
  fractionDigits: number,
): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error('formatSmallestUnitDecimal: decimals must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > decimals) {
    throw new Error(
      'formatSmallestUnitDecimal: fractionDigits must be a safe integer in [0, decimals]',
    );
  }
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').slice(0, fractionDigits);
  return `${negative ? '-' : ''}${whole.toString()}${fractionDigits > 0 ? `.${frac}` : ''}`;
}

export function formatRatioDecimal(
  numerator: bigint,
  denominator: bigint,
  fractionDigits: number,
): string {
  if (denominator <= 0n) {
    throw new Error('formatRatioDecimal: denominator must be positive');
  }
  if (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0) {
    throw new Error('formatRatioDecimal: fractionDigits must be a non-negative safe integer');
  }

  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const scale = 10n ** BigInt(fractionDigits);
  const scaled = (abs * scale + denominator / 2n) / denominator;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(fractionDigits, '0');
  return `${negative ? '-' : ''}${whole.toString()}${fractionDigits > 0 ? `.${frac}` : ''}`;
}
