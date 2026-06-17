const DECIMAL_MIST_RE = /^(?:0|[1-9]\d*)$/;

export function parseChainBalanceMist(value: string, label: string): bigint {
  if (!DECIMAL_MIST_RE.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}
