export const MAX_SPONSOR_SLOT_COUNT = 256;

export function assertSponsorSlotCount(count: number, label: string): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SPONSOR_SLOT_COUNT) {
    throw new Error(
      `${label} supports 1..${MAX_SPONSOR_SLOT_COUNT} sponsor slots; got ${String(count)}`,
    );
  }
}
