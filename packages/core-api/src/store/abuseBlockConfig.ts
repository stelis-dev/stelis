import type { AbuseBlockerConfig } from './abuseBlockTypes.js';

export function validateAbuseBlockerConfig(config: AbuseBlockerConfig): AbuseBlockerConfig {
  const positiveFields: Array<keyof AbuseBlockerConfig> = [
    'ipFailureWindowMs',
    'ipBlockDurationMs',
    'addressDryRunWindowMs',
    'addressBlockDurationMs',
    'manipulationBlockDurationMs',
    'addressOnchainRevertWindowMs',
  ];
  const nonNegativeFields: Array<keyof AbuseBlockerConfig> = [
    'ipFailureThreshold',
    'addressDryRunThreshold',
    'addressOnchainRevertThreshold',
  ];

  for (const field of positiveFields) {
    const value = config[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`AbuseBlockerConfig.${field} must be a positive safe integer`);
    }
  }

  for (const field of nonNegativeFields) {
    const value = config[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`AbuseBlockerConfig.${field} must be a non-negative safe integer`);
    }
  }

  return config;
}
