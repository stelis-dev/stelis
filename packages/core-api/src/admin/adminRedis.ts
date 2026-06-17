/**
 * Admin Redis client — shared admin panel Redis infrastructure.
 *
 * Framework-agnostic: Redis URL is injected via parameter,
 * NOT read from process.env (core-api boundary policy).
 *
 * Provides the AdminRedisClient interface and factory function
 * for admin session storage, nonce management, rate limiting,
 * audit logging, and promotion pool operations.
 */

interface RawRedisClient {
  isOpen?: boolean;
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: Record<string, unknown>): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  lPush(key: string, ...values: string[]): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<void>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  scan(
    cursor: number,
    options?: { MATCH?: string; COUNT?: number },
  ): Promise<{ cursor: number; keys: string[] }>;
  ttl(key: string): Promise<number>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, field: string, value: string): Promise<number>;
  sAdd(key: string, ...members: string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, ...members: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit(): Promise<void>;
}

/**
 * Superset admin Redis client interface.
 */
export interface AdminRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<void>;
  del(key: string): Promise<number>;
  scan(pattern: string): Promise<string[]>;
  ttl(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

async function loadRedis(): Promise<{ createClient: (o: { url: string }) => RawRedisClient }> {
  return (await import(/* webpackIgnore: true */ 'redis')) as unknown as {
    createClient: (o: { url: string }) => RawRedisClient;
  };
}

let _adminRedis: AdminRedisClient | null = null;

/**
 * Get or create the admin Redis client.
 *
 * @param redisUrl — Redis connection URL (injected by the host / app-api).
 */
export async function getRedisForAdmin(redisUrl: string): Promise<AdminRedisClient> {
  if (_adminRedis) return _adminRedis;

  if (!redisUrl) throw new Error('[admin] redisUrl is required');

  const { createClient } = await loadRedis();
  const client = createClient({ url: redisUrl });
  if (!client.isOpen) await client.connect();

  _adminRedis = {
    get(key) {
      return client.get(key);
    },
    async set(key, value, options) {
      const opts: Record<string, unknown> = {};
      if (options?.ex) opts.EX = options.ex;
      await client.set(key, value, Object.keys(opts).length ? opts : undefined);
    },
    del(key) {
      return client.del(key);
    },
    async scan(pattern) {
      const results: string[] = [];
      let cursor = 0;
      do {
        const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = reply.cursor;
        results.push(...reply.keys);
      } while (cursor !== 0);
      return results;
    },
    ttl(key) {
      return client.ttl(key);
    },
    lrange(key, start, stop) {
      return client.lRange(key, start, stop);
    },
    lpush(key, value) {
      return client.lPush(key, value);
    },
    ltrim(key, start, stop) {
      return client.lTrim(key, start, stop);
    },
    hincrby(key, field, increment) {
      return client.hIncrBy(key, field, increment);
    },
    hgetall(key) {
      return client.hGetAll(key);
    },
    hset(key, field, value) {
      return client.hSet(key, field, value);
    },
    sadd(key, ...members) {
      return client.sAdd(key, ...members);
    },
    smembers(key) {
      return client.sMembers(key);
    },
    srem(key, ...members) {
      return client.sRem(key, ...members);
    },
    incr(key) {
      return client.incr(key);
    },
    async expire(key, seconds) {
      const result = await client.expire(key, seconds);
      return Boolean(result);
    },
    eval(script, keys, args) {
      return client.eval(script, { keys, arguments: args });
    },
  };

  return _adminRedis;
}
