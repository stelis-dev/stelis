/**
 * Shared DeepBook query error categories.
 *
 * Raised when a DeepBook view-call cannot be evaluated due to RPC transport
 * failure, malformed BCS, or unexpected response shape.
 */
export class SlippageQueryError extends Error {
  override readonly name = 'SlippageQueryError';

  constructor(message: string) {
    super(message);
  }
}
