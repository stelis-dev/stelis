import { describe, expect, test } from 'vitest';
import {
  HOST_ERROR_HTTP_STATUS,
  HOST_ERROR_META_POLICY,
  hostErrorPublicMessage,
  PAYMENT_INPUT_INTEGRITY_SUBCODES,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
  SPONSOR_FAILURE_SUBCODES,
  parseAdminSponsoredLogsQuery,
  parseAdminSponsoredLogsResponse,
  parseHostErrorResponse,
  type HostErrorCode,
} from '@stelis/contracts';

const ALL_HOST_ERROR_CODES = Object.keys(HOST_ERROR_HTTP_STATUS) as HostErrorCode[];

function currentSponsoredLogsResponse() {
  return {
    summary: {
      mode: 'all',
      sponsoredExecutions: '1',
      lossCount: '0',
      cumulativeHostNetMist: '0',
      cumulativeLossMist: '0',
    },
    entries: [
      {
        createdAt: '2026-07-15T00:00:00.000Z',
        mode: 'generic',
        outcome: 'success',
        receiptId: 'receipt-1',
        digest: 'digest-1',
        senderAddress: '0x1',
        sponsorAddress: '0x2',
        executionPathKey: 'generic',
        orderIdHash: null,
        promotionId: null,
        userId: null,
        economicsStatus: 'known',
        recoveredGasMist: '1',
        hostPaidGasMist: '1',
        hostNetMist: '0',
        hostFeeMist: '0',
        protocolFeeMist: null,
        grossGasMist: '1',
        storageRebateMist: '0',
        failureReason: null,
      },
    ],
  };
}

describe('contracts-owned Host wire authority', () => {
  test('owns the sponsored-log query defaults and bounds', () => {
    expect(parseAdminSponsoredLogsQuery({})).toEqual({ mode: 'all', limit: 50 });
    expect(parseAdminSponsoredLogsQuery({ mode: 'promotion', limit: '200' })).toEqual({
      mode: 'promotion',
      limit: 200,
    });
    expect(() => parseAdminSponsoredLogsQuery({ mode: 'unsupported' })).toThrow(
      /mode is not current/,
    );
    expect(() => parseAdminSponsoredLogsQuery({ limit: '0' })).toThrow(
      /canonical positive decimal/,
    );
    expect(() => parseAdminSponsoredLogsQuery({ limit: '201' })).toThrow(/at most 200/);
    expect(() => parseAdminSponsoredLogsQuery({ limit: '50', cursor: 'unsupported' })).toThrow(
      /non-current field/,
    );
  });

  test('rejects loose Admin log rows instead of accepting valid-looking fragments', () => {
    const looseTimestamp = currentSponsoredLogsResponse();
    looseTimestamp.entries[0]!.createdAt = 'July 15, 2026';
    expect(() => parseAdminSponsoredLogsResponse(looseTimestamp)).toThrow(/ISO-8601 timestamp/);

    const impossibleTimestamp = currentSponsoredLogsResponse();
    impossibleTimestamp.entries[0]!.createdAt = '2026-02-30T00:00:00.000Z';
    expect(() => parseAdminSponsoredLogsResponse(impossibleTimestamp)).toThrow(
      /ISO-8601 timestamp/,
    );

    const emptyDigest = currentSponsoredLogsResponse();
    emptyDigest.entries[0]!.digest = '';
    expect(() => parseAdminSponsoredLogsResponse(emptyDigest)).toThrow(/non-empty string/);

    const outOfRangeMist = currentSponsoredLogsResponse();
    outOfRangeMist.entries[0]!.hostPaidGasMist = '18446744073709551616';
    expect(() => parseAdminSponsoredLogsResponse(outOfRangeMist)).toThrow(/fit in u64/);

    const genericWithPromotionIdentity = currentSponsoredLogsResponse();
    Reflect.set(genericWithPromotionIdentity.entries[0]!, 'promotionId', 'promotion-1');
    expect(() => parseAdminSponsoredLogsResponse(genericWithPromotionIdentity)).toThrow(
      /generic mode cannot carry Promotion identity/,
    );

    const unknownEconomicsWithAmount = currentSponsoredLogsResponse();
    unknownEconomicsWithAmount.entries[0]!.economicsStatus = 'unknown';
    expect(() => parseAdminSponsoredLogsResponse(unknownEconomicsWithAmount)).toThrow(
      /unknown economics requires null numeric fields/,
    );
  });

  test('binds every current error code to one status, message, and metadata policy', () => {
    for (const code of ALL_HOST_ERROR_CODES) {
      const policy = HOST_ERROR_META_POLICY[code];
      const required = policy?.required ?? [];
      const body = {
        error: hostErrorPublicMessage(code),
        code,
        ...(required.includes('digest') ? { digest: '0xdigest' } : {}),
        ...(required.includes('retryAfterMs') ? { retryAfterMs: 1 } : {}),
        ...(required.includes('operationId') ? { operationId: 'operation-1' } : {}),
      };
      const status = HOST_ERROR_HTTP_STATUS[code];
      expect(parseHostErrorResponse(body, ALL_HOST_ERROR_CODES, status)).toEqual(body);

      const wrongStatus = status === 400 ? 422 : 400;
      expect(() => parseHostErrorResponse(body, ALL_HOST_ERROR_CODES, wrongStatus)).toThrow(
        /code does not match the HTTP status/,
      );
      expect(() =>
        parseHostErrorResponse(
          { ...body, error: 'Arbitrary producer message' },
          ALL_HOST_ERROR_CODES,
          status,
        ),
      ).toThrow(/error does not match the current code/);

      const disallowedField = policy?.allowed.includes('operationId')
        ? 'isEstimate'
        : 'operationId';
      expect(() =>
        parseHostErrorResponse(
          { ...body, [disallowedField]: disallowedField === 'isEstimate' ? true : 'unexpected' },
          ALL_HOST_ERROR_CODES,
          status,
        ),
      ).toThrow(/metadata not allowed/);
    }
  });

  test('rejects uncoded errors and keeps subcode vocabularies closed', () => {
    expect(() =>
      parseHostErrorResponse(
        { error: hostErrorPublicMessage('INTERNAL_ERROR') },
        ['INTERNAL_ERROR'],
        500,
      ),
    ).toThrow(/code must be a string/);
    expect(() =>
      parseHostErrorResponse(
        {
          error: hostErrorPublicMessage('SPONSOR_PREFLIGHT_FAILED'),
          code: 'SPONSOR_PREFLIGHT_FAILED',
          subcode: 'invented_subcode',
        },
        RELAY_SPONSOR_ERROR_CODES,
        422,
      ),
    ).toThrow(/subcode/);
    expect(() =>
      parseHostErrorResponse(
        {
          error: hostErrorPublicMessage('L2_EXTRACT_FAILED'),
          code: 'L2_EXTRACT_FAILED',
          subcode: SPONSOR_FAILURE_SUBCODES[0],
        },
        RELAY_PREPARE_ERROR_CODES,
        422,
      ),
    ).toThrow(/wrong subcode kind/);
    expect(new Set(SPONSOR_FAILURE_SUBCODES).size).toBe(SPONSOR_FAILURE_SUBCODES.length);
    expect(new Set(PAYMENT_INPUT_INTEGRITY_SUBCODES).size).toBe(
      PAYMENT_INPUT_INTEGRITY_SUBCODES.length,
    );
  });
});
