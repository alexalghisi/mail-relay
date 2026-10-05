/**
 * A webhook endpoint for local runs: verifies each request with the same
 * verify() a customer would use and prints what arrived.
 *
 *   WEBHOOK_SECRET=whsec_... node scripts/webhook-receiver.ts [port]
 */
import { createServer } from "node:http";
import { createLogger } from "../src/log.ts";
import { verify } from "../src/webhooks/signing.ts";

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error("WEBHOOK_SECRET is required");
const port = Number(process.argv[2] ?? 4000);
const log = createLogger("hook");
const seen = new Set<string>();

createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const id = String(req.headers["webhook-id"]);
        try {
            const event = verify(secret, req.headers, body) as { type: string; data: { to?: string | string[] } };
            const duplicate = seen.has(id);
            seen.add(id);
            log.info(`verified ${event.type}`, { to: String(event.data.to ?? ""), id, duplicate });
            res.writeHead(204).end();
        } catch (error) {
            log.warn("rejected", { id, err: error instanceof Error ? error.message : String(error) });
            res.writeHead(401).end();
        }
    });
}).listen(port, "127.0.0.1", () => log.info(`listening on ${port}`));
