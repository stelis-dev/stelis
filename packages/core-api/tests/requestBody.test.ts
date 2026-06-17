import { describe, expect, it } from 'vitest';
import {
  readJsonBodyWithLimit,
  RequestBodyParseError,
  RequestBodyTooLargeError,
} from '../src/requestBody.js';

function requestWithBody(body: string, headers?: Record<string, string>): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers,
    body,
  });
}

describe('readJsonBodyWithLimit', () => {
  it('rejects malformed Content-Length instead of coercing loosely', async () => {
    await expect(
      readJsonBodyWithLimit(requestWithBody('{}', { 'content-length': '1e3' }), 1024),
    ).rejects.toBeInstanceOf(RequestBodyParseError);
  });

  it('rejects unsafe Content-Length values', async () => {
    await expect(
      readJsonBodyWithLimit(requestWithBody('{}', { 'content-length': '9007199254740993' }), 1024),
    ).rejects.toBeInstanceOf(RequestBodyParseError);
  });

  it('throws RequestBodyTooLargeError when Content-Length exceeds the cap', async () => {
    await expect(
      readJsonBodyWithLimit(requestWithBody('{}', { 'content-length': '2048' }), 1024),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
