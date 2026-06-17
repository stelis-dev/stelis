/**
 * Admin Operations Audit Log — records administrative operations.
 *
 * Framework-agnostic: Redis client is injected via parameter,
 * NOT obtained from process.env (core-api boundary policy).
 *
 * Used by app-api for withdrawal operations and promotion operations.
 */
import type { AdminRedisClient } from './adminRedis.js';

const ADMIN_OPERATION_LOG_KEY = 'stelis:admin:operation_log';
const ADMIN_OPERATION_LOG_MAX_ENTRIES = 200;

export interface AdminOperationLogEntry {
  event: string;
  ts: string;
  ip: string;
  detail?: string;
}

/**
 * Push an audit log entry.
 * @param redis — AdminRedisClient (injected by host).
 * @param entry — Log entry to record.
 */
export async function pushAdminOperationLog(
  redis: AdminRedisClient,
  entry: AdminOperationLogEntry,
): Promise<void> {
  await redis.lpush(ADMIN_OPERATION_LOG_KEY, JSON.stringify(entry));
  await redis.ltrim(ADMIN_OPERATION_LOG_KEY, 0, ADMIN_OPERATION_LOG_MAX_ENTRIES - 1);
}
