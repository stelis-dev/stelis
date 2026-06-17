import type {
  StaticPoolDescriptor,
  StaticPoolDescriptorMap,
  StaticPoolDescriptorSource,
} from './types.js';

export function createStaticPoolDescriptor(
  source: StaticPoolDescriptorSource,
): StaticPoolDescriptor {
  return {
    paymentTokenType: source.paymentTokenType,
    paymentTokenSymbol: source.paymentTokenSymbol,
    paymentTokenDecimals: source.paymentTokenDecimals,
    effectiveFeeRateBps: source.effectiveFeeRateBps,
    settlementSwapDirection: source.settlementSwapDirection,
    hops: source.hops.map((hop) => ({ ...hop })),
    lotSize: source.lotSize,
    minSize: source.minSize,
  };
}

export function createStaticPoolDescriptorMap(
  sources: readonly StaticPoolDescriptorSource[],
): StaticPoolDescriptorMap {
  const map: StaticPoolDescriptorMap = new Map();
  for (const source of sources) {
    map.set(source.paymentTokenType, createStaticPoolDescriptor(source));
  }
  return map;
}
