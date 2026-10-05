import { z } from "zod";

const env = z.object({
    DATABASE_URL: z.string().default("postgres://synckit:synckit@localhost:5432/mailrelay_dev"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    PORT: z.coerce.number().int().default(3000),
    SMTP_HOST: z.string().default("127.0.0.1"),
    SMTP_PORT: z.coerce.number().int().default(2525),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(32),
    DOMAIN_CONCURRENCY: z.coerce.number().int().positive().default(8),
    LEASE_SECONDS: z.coerce.number().int().positive().default(60),
    RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
    RETRY_CAP_MS: z.coerce.number().int().positive().default(3_600_000),
});

export type Config = z.infer<typeof env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
    return env.parse(source);
}
