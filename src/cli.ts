import { Redis } from "ioredis";
import { addDomain, createApiKey, createTeam, createWebhookEndpoint } from "./accounts/repository.ts";
import { buildApp } from "./api/app.ts";
import { deleteExpiredKeys } from "./api/idempotency.ts";
import { FailOpenRateLimiter, RedisTokenBucket } from "./api/rate-limit.ts";
import { loadConfig, type Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { createLogger } from "./log.ts";

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
