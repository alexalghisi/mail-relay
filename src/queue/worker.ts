import { hostname } from "node:os";
import { silentLogger, type Logger } from "../log.ts";
import type { Sender } from "../smtp/sender.ts";
import type { ClaimedDelivery, DeliveryQueue } from "./deliveries.ts";

export interface WorkerOptions {
    queue: DeliveryQueue;
    sender: Sender;
    /** Sends in flight at once in this process. */
    concurrency: number;
    /** How long to sleep when the queue is empty. */
    idleMs?: number;
    workerId?: string;
    logger?: Logger;
}

/**
 * Claims deliveries, sends them and records the outcome.
 *
 * It only ever claims as many rows as it has free slots, so everything it
 * holds a lease on is actively being sent. That keeps shutdown simple: stop
 * claiming, let the in-flight sends finish, and nothing is left leased.
 */
export class DeliveryWorker {
    readonly id: string;
    private readonly queue: DeliveryQueue;
    private readonly sender: Sender;
    private readonly concurrency: number;
    private readonly idleMs: number;
    private readonly log: Logger;
    private readonly inFlight = new Set<Promise<void>>();
    private running = false;
    private loop: Promise<void> | undefined;
    private wake: (() => void) | undefined;

    constructor(options: WorkerOptions) {
        this.queue = options.queue;
        this.sender = options.sender;
        this.concurrency = options.concurrency;
        this.idleMs = options.idleMs ?? 250;
        this.id = options.workerId ?? `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
        this.log = options.logger ?? silentLogger;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = this.run();
    }

    /** Stops claiming and waits for in-flight sends, up to `timeoutMs`. */
    async stop(timeoutMs = 30_000): Promise<void> {
        if (!this.running) return;
        this.running = false;
        this.wake?.();
        await this.loop;
        const drained = Promise.all(this.inFlight).then(() => true);
        const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
        if (!(await Promise.race([drained, timedOut]))) {
            // The leases on whatever is still running will expire and another
            // worker will pick those deliveries up.
            this.log.warn("shutdown timed out with sends in flight", { in_flight: this.inFlight.size });
        }
    }

    private async run(): Promise<void> {
        while (this.running) {
            const free = this.concurrency - this.inFlight.size;
            if (free === 0) {
                await Promise.race(this.inFlight);
                continue;
            }
            let claimed: ClaimedDelivery[] = [];
            try {
                claimed = await this.queue.claim(this.id, free);
            } catch (error) {
                this.log.error("claim failed", { err: message(error) });
            }
            for (const delivery of claimed) this.track(this.process(delivery));
            if (claimed.length === 0) await this.idle();
        }
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
            // Not recorded: the lease will expire and the delivery is retried.
            this.log.error("could not record outcome", { id: delivery.id, err: message(error) });
        }
    }

    private track(task: Promise<void>): void {
        const tracked: Promise<void> = task.finally(() => {
            this.inFlight.delete(tracked);
            this.wake?.();
        });
        this.inFlight.add(tracked);
    }

    private idle(): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.wake = undefined;
                resolve();
            };
            const timer = setTimeout(done, this.idleMs);
            this.wake = done;
        });
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
