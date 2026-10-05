import type { Redis } from "ioredis";

export interface RateLimitDecision {
    allowed: boolean;
    limit: number;
    remaining: number;
    /** Milliseconds until the next token is available; 0 when allowed. */
    retryAfterMs: number;
}

export interface RateLimiter {
    take(key: string, burst: number, perSecond: number): Promise<RateLimitDecision>;
}

// Token bucket, evaluated atomically inside Redis. The clock is Redis's own
// (TIME), so API nodes with skewed clocks still share one consistent bucket.
const TOKEN_BUCKET = `
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)
local allowed = 0
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
local retry = 0
if allowed == 0 then
    retry = math.ceil((1 - tokens) * 1000 / rate)
end
return { allowed, math.floor(tokens), retry }
`;

export class RedisTokenBucket implements RateLimiter {
    private readonly redis: Redis;
    private readonly prefix: string;

    constructor(redis: Redis, prefix = "ratelimit:") {
        this.redis = redis;
        this.prefix = prefix;
    }

    async take(key: string, burst: number, perSecond: number): Promise<RateLimitDecision> {
        const result = (await this.redis.eval(TOKEN_BUCKET, 1, this.prefix + key, burst, perSecond)) as [number, number, number];
        const [allowed, remaining, retryAfterMs] = result;
        return { allowed: allowed === 1, limit: burst, remaining, retryAfterMs };
    }
}

/**
 * Lets requests through when Redis is unavailable. Losing rate limiting for a
 * few seconds is better than refusing every send while Redis fails over.
 */
export class FailOpenRateLimiter implements RateLimiter {
    private readonly inner: RateLimiter;
    private readonly onError: (error: unknown) => void;

    constructor(inner: RateLimiter, onError: (error: unknown) => void) {
        this.inner = inner;
        this.onError = onError;
    }

    async take(key: string, burst: number, perSecond: number): Promise<RateLimitDecision> {
        try {
            return await this.inner.take(key, burst, perSecond);
        } catch (error) {
            this.onError(error);
            return { allowed: true, limit: burst, remaining: burst, retryAfterMs: 0 };
        }
    }
}
