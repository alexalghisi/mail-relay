import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ApiKeyRecord } from "../accounts/repository.ts";
import { findApiKey } from "../accounts/repository.ts";
import { withTransaction, type Pool } from "../db/pool.ts";
import { findEmail } from "../emails/repository.ts";
import { queueEmails } from "../emails/service.ts";
import { silentLogger, type Logger } from "../log.ts";
import { ApiError } from "./errors.ts";
import { hashRequest, runIdempotent, type StoredResponse } from "./idempotency.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { z } from "zod";
import { batchSchema, describeZodError, idempotencyKeySchema, sendEmailSchema, type SendEmailInput } from "./schemas.ts";

export interface AppDeps {
    pool: Pool;
    rateLimiter: RateLimiter;
    logger?: Logger;
    idempotencyTtlSeconds?: number;
}

declare module "fastify" {
    interface FastifyRequest {
        apiKey: ApiKeyRecord | null;
    }
}

export function buildApp(deps: AppDeps): FastifyInstance {
    const { pool, rateLimiter } = deps;
    const logger = deps.logger ?? silentLogger;
    const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

    app.decorateRequest("apiKey", null);

    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof ApiError) return reply.status(error.statusCode).send(error.toJSON());
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as { statusCode?: unknown }).statusCode;
        if (typeof status === "number" && status >= 400 && status < 500) {
            return reply.status(status).send(new ApiError(status, "invalid_request", message).toJSON());
        }
        logger.error("unhandled error", { err: message });
        return reply.status(500).send(new ApiError(500, "internal_server_error", "Something went wrong.").toJSON());
    });

    app.addHook("onResponse", async (request, reply) => {
        logger.info(`${request.method} ${request.url}`, { status: reply.statusCode, ms: reply.elapsedTime.toFixed(1) });
    });

    app.get("/health", async () => ({ ok: true }));

    app.register(async (authed) => {
        authed.addHook("onRequest", async (request, reply) => {
            const apiKey = await authenticate(pool, request);
            request.apiKey = apiKey;
            const decision = await rateLimiter.take(apiKey.id, apiKey.rateBurst, apiKey.ratePerSec);
            reply.header("ratelimit-limit", decision.limit);
            reply.header("ratelimit-remaining", decision.remaining);
            if (!decision.allowed) {
                reply.header("retry-after", Math.ceil(decision.retryAfterMs / 1000));
                throw new ApiError(429, "rate_limit_exceeded", "Too many requests. Slow down and retry after the Retry-After interval.");
            }
        });

        authed.post("/emails", async (request, reply) => {
            const input = parse(sendEmailSchema, request.body);
            return send(request, reply, async (client) => {
                const [id] = await queueEmails(client, requireKey(request), [input]);
                return { status: 200, body: { id } };
            });
        });

        authed.post("/emails/batch", async (request, reply) => {
            const inputs: SendEmailInput[] = parse(batchSchema, request.body);
            return send(request, reply, async (client) => {
                const ids = await queueEmails(client, requireKey(request), inputs);
                return { status: 200, body: { data: ids.map((id) => ({ id })) } };
            });
        });

        authed.get<{ Params: { id: string } }>("/emails/:id", async (request) => {
            const id = request.params.id;
            const email = UUID.test(id) ? await findEmail(pool, requireKey(request).teamId, id) : undefined;
            if (!email) throw new ApiError(404, "not_found", "Email not found.");
            return email;
        });
    });

    async function send(
        request: FastifyRequest,
        reply: FastifyReply,
        handler: Parameters<typeof runIdempotent>[2],
    ): Promise<unknown> {
        const header = request.headers["idempotency-key"];
        let result: StoredResponse;
        if (header === undefined) {
            result = await withTransaction(pool, handler);
        } else {
            const key = parse(idempotencyKeySchema, header, "Idempotency-Key");
            const outcome = await runIdempotent(
                pool,
                {
                    teamId: requireKey(request).teamId,
                    key,
                    requestHash: hashRequest(request.routeOptions.url ?? request.url, request.body),
                    ...(deps.idempotencyTtlSeconds !== undefined && { ttlSeconds: deps.idempotencyTtlSeconds }),
                },
                handler,
            );
            if (outcome.replayed) reply.header("idempotent-replayed", "true");
            result = outcome;
        }
        return reply.status(result.status).send(result.body);
    }

    return app;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authenticate(pool: Pool, request: FastifyRequest): Promise<ApiKeyRecord> {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    if (!token) throw new ApiError(401, "missing_api_key", "Missing API key in the Authorization header.");
    const apiKey = await findApiKey(pool, token);
    if (!apiKey) throw new ApiError(403, "invalid_api_key", "API key is invalid.");
    return apiKey;
}

function requireKey(request: FastifyRequest): ApiKeyRecord {
    if (!request.apiKey) throw new ApiError(401, "missing_api_key", "Missing API key in the Authorization header.");
    return request.apiKey;
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, label?: string): z.output<S> {
    const result = schema.safeParse(value);
    if (!result.success) {
        const detail = describeZodError(result.error);
        throw new ApiError(422, "validation_error", label ? `${label}: ${detail}` : detail);
    }
    return result.data;
}
