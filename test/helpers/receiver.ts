import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedWebhook {
    headers: IncomingHttpHeaders;
    body: string;
    status: number;
}

/** A webhook endpoint that answers with the next status from `statuses`, then 200. */
export class WebhookReceiver {
    readonly requests: ReceivedWebhook[] = [];
    private readonly server: Server;
    private readonly statuses: number[];

    constructor(statuses: number[] = []) {
        this.statuses = [...statuses];
        this.server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const status = this.statuses.shift() ?? 200;
                this.requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), status });
                res.writeHead(status).end();
            });
        });
    }

    async listen(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hooks`;
    }

    close(): Promise<void> {
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
}
