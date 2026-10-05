import { Redis } from "ioredis";
import { addDomain, createApiKey, createTeam, createWebhookEndpoint } from "./accounts/repository.ts";
import { buildApp } from "./api/app.ts";
import { deleteExpiredKeys } from "./api/idempotency.ts";
import { FailOpenRateLimiter, RedisTokenBucket } from "./api/rate-limit.ts";
import { loadConfig, type Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { createLogger } from "./log.ts";
import { FakeMta } from "./mta/fake-mta.ts";
import { DeliveryQueue } from "./queue/deliveries.ts";
import { queueStats, toEmf } from "./queue/stats.ts";
import { DeliveryWorker } from "./queue/worker.ts";
import { SmtpSender } from "./smtp/sender.ts";
import { WebhookDispatcher } from "./webhooks/dispatcher.ts";

type Command = (config: Config, args: string[]) => Promise<void>;

const commands: Record<string, Command> = {
    async migrate(config) {
        const pool = createPool(config.DATABASE_URL, 1);
        const { applied } = await migrate(pool);
        console.log(applied.length ? `applied ${applied.join(", ")}` : "up to date");
        await pool.end();
    },

    async seed(config, args) {
        const pool = createPool(config.DATABASE_URL, 1);
        const teamId = await createTeam(pool, "Acme");
        const key = await createApiKey(pool, teamId, { name: "seed", rateBurst: Number(args[0] ?? 50), ratePerSec: Number(args[1] ?? 20) });
        await addDomain(pool, teamId, "acme.test", true);
        await addDomain(pool, teamId, "unverified.test", false);
        const webhookUrl = process.env.WEBHOOK_URL;
        const endpoint = webhookUrl ? await createWebhookEndpoint(pool, teamId, webhookUrl) : undefined;
        console.log(JSON.stringify({ teamId, apiKey: key.token, webhookSecret: endpoint?.secret }, null, 2));
        await pool.end();
    },

    async api(config) {
        const log = createLogger("api");
        const pool = createPool(config.DATABASE_URL, 20);
        const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
        const rateLimiter = new FailOpenRateLimiter(new RedisTokenBucket(redis), (error) =>
            log.warn("rate limiter unavailable, allowing request", { err: error instanceof Error ? error.message : String(error) }),
        );
        const app = buildApp({ pool, rateLimiter, logger: log });
        const sweep = setInterval(() => void deleteExpiredKeys(pool).catch(() => undefined), 60_000);

        await app.listen({ port: config.PORT, host: "0.0.0.0" });
        log.info("listening", { port: config.PORT });

        onShutdown(async () => {
            clearInterval(sweep);
            await app.close();
            redis.disconnect();
            await pool.end();
        });
    },

    async worker(config) {
        const log = createLogger("worker");
        const pool = createPool(config.DATABASE_URL, 4);
        const sender = new SmtpSender({
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            maxConnections: config.WORKER_CONCURRENCY,
            timeoutMs: Math.min(30_000, (config.LEASE_SECONDS * 1000) / 2),
        });
        const queue = new DeliveryQueue(pool, {
            leaseSeconds: config.LEASE_SECONDS,
            defaultDomainConcurrency: config.DOMAIN_CONCURRENCY,
            retryBaseMs: config.RETRY_BASE_MS,
            retryCapMs: config.RETRY_CAP_MS,
        });
        const worker = new DeliveryWorker({ queue, sender, concurrency: config.WORKER_CONCURRENCY, logger: log });
        worker.start();
        log.info("started", { id: worker.id, concurrency: config.WORKER_CONCURRENCY, smtp: `${config.SMTP_HOST}:${config.SMTP_PORT}` });

        const metrics = setInterval(() => {
            queueStats(pool).then(
                (stats) => (process.env.EMF_METRICS ? console.log(toEmf(stats)) : log.info("queue", { ...stats })),
                () => undefined,
            );
        }, 60_000);

        onShutdown(async () => {
            log.info("draining in-flight sends");
            clearInterval(metrics);
            await worker.stop();
            sender.close();
            await pool.end();
            log.info("stopped");
        });
    },

    async webhooks(config) {
        const log = createLogger("webhooks");
        const pool = createPool(config.DATABASE_URL, 4);
        const dispatcher = new WebhookDispatcher({ db: pool, logger: log });
        dispatcher.start();
        log.info("started");
        onShutdown(async () => {
            await dispatcher.stop();
            await pool.end();
        });
    },

    async mta(config) {
        const slowDomains = Object.fromEntries(
            (process.env.SLOW_DOMAINS ?? "")
                .split(",")
                .filter(Boolean)
                .map((pair) => {
                    const [domain = "", ms = "0"] = pair.split("=");
                    return [domain, Number(ms)];
                }),
        );
        const mta = new FakeMta({ slowDomains, logger: createLogger("mta") });
        const port = await mta.listen(config.SMTP_PORT);
        console.log(`fake MTA listening on ${port}`);
        onShutdown(() => mta.close());
    },
};

function onShutdown(fn: () => Promise<void>): void {
    let stopping = false;
    const handler = () => {
        if (stopping) return;
        stopping = true;
        fn().then(
            () => process.exit(0),
            () => process.exit(1),
        );
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
}

const [name = "", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
    console.error(`usage: node src/cli.ts <${Object.keys(commands).join("|")}>`);
    process.exit(2);
}
await command(loadConfig(), args);
