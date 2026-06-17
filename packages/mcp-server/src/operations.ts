import type { StelisMcpServerConfig } from './config.js';
import { requestJson } from './http.js';
import type {
  JsonObject,
  PrepareRequest,
  PromotionPrepareRequest,
  PromotionSponsorRequest,
  SponsorRequest,
} from './types.js';

interface RelayScopedInput {
  relayUrl?: string;
  timeoutMs?: number;
}

export async function getRelayConfig(
  config: StelisMcpServerConfig,
  input: RelayScopedInput,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    path: '/config',
  });
}

export async function prepareSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayScopedInput & PrepareRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    method: 'POST',
    path: '/prepare',
    body: omitRelayFields(input),
  });
}

export async function submitSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayScopedInput & SponsorRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    method: 'POST',
    path: '/sponsor',
    body: omitRelayFields(input),
  });
}

export async function listPromotions(
  config: StelisMcpServerConfig,
  input: RelayScopedInput & { developerJwt: string },
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    path: '/studio/promotions',
    headers: bearerHeader(input.developerJwt),
  });
}

export async function getPromotionDetail(
  config: StelisMcpServerConfig,
  input: RelayScopedInput & { developerJwt: string; promotionId: string },
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}`,
    headers: bearerHeader(input.developerJwt),
  });
}

export async function claimPromotion(
  config: StelisMcpServerConfig,
  input: RelayScopedInput & { developerJwt: string; promotionId: string },
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    method: 'POST',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}/claim`,
    headers: bearerHeader(input.developerJwt),
    body: {},
  });
}

export async function preparePromotionSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayScopedInput & { developerJwt: string; promotionId: string } & PromotionPrepareRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    method: 'POST',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}/prepare`,
    headers: bearerHeader(input.developerJwt),
    body: {
      senderAddress: input.senderAddress,
      txKindBytes: input.txKindBytes,
    },
  });
}

export async function submitPromotionSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayScopedInput & { developerJwt: string; promotionId: string } & PromotionSponsorRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayUrl: input.relayUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    method: 'POST',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}/sponsor`,
    headers: bearerHeader(input.developerJwt),
    body: {
      receiptId: input.receiptId,
      txBytes: input.txBytes,
      userSignature: input.userSignature,
    },
  });
}

function bearerHeader(developerJwt: string): Record<string, string> {
  return { Authorization: `Bearer ${developerJwt}` };
}

function omitRelayFields<T extends RelayScopedInput>(input: T): Omit<T, keyof RelayScopedInput> {
  const { relayUrl: _relayUrl, timeoutMs: _timeoutMs, ...rest } = input;
  return rest;
}
