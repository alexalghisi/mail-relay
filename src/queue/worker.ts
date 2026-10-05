import { hostname } from "node:os";
import { silentLogger, type Logger } from "../log.ts";
import type { Sender } from "../smtp/sender.ts";
import { ClaimLoop } from "./claim-loop.ts";
import type { ClaimedDelivery, DeliveryQueue } from "./deliveries.ts";

export interface WorkerOptions {
    queue: DeliveryQueue;
    sender: Sender;
    /** Sends in flight at once in this process. */
    concurrency: number;
    idleMs?: number;
    workerId?: string;
    logger?: Logger;
}

/** Claims deliveries, sends them over SMTP and records the outcome. */
export class DeliveryWorker {
    readonly id: string;
    private readonly queue: DeliveryQueue;
    private readonly sender: Sender;
    private readonly log: Logger;
    private readonly loop: ClaimLoop<ClaimedDelivery>;

    constructor(options: WorkerOptions) {
        this.queue = options.queue;
        this.sender = options.sender;
        this.id = options.workerId ?? `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
        this.log = options.logger ?? silentLogger;
        this.loop = new ClaimLoop({
            claim: (limit) => this.queue.claim(this.id, limit),
            handle: (delivery) => this.process(delivery),
            concurrency: options.concurrency,
            logger: this.log,
            ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
        });
    }

    start(): void {
        this.loop.start();
    }

    stop(timeoutMs?: number): Promise<void> {
        return this.loop.stop(timeoutMs);
    }

    private async process(delivery: ClaimedDelivery): Promise<void> {
        const started = performance.now();
        const outcome = await this.sender.send(delivery);
        try {
            const settled = await this.queue.settle(delivery, outcome);
            const fields = {
                id: delivery.id,
                to: delivery.recipient,
                attempt: delivery.attempt,
                smtp: outcome.response.split("\n")[0],
                ms: Math.round(performance.now() - started),
            };
            if (settled === "delivered") this.log.info("delivered", fields);
            else if (settled === "queued") this.log.warn("deferred, will retry", fields);
            else if (settled === "lease_lost") this.log.warn("lease lost, outcome discarded", fields);
            else this.log.warn(settled, fields);
        } catch (error) {
            // Not recorded: the lease expires and the delivery is retried.
            this.log.error("could not record outcome", { id: delivery.id, err: error instanceof Error ? error.message : String(error) });
        }
    }
}
