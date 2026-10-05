import { silentLogger, type Logger } from "../log.ts";

export interface ClaimLoopOptions<T> {
    /** Claims up to `limit` items and leases them to this process. */
    claim(limit: number): Promise<T[]>;
    handle(item: T): Promise<void>;
    concurrency: number;
    /** How long to sleep when there was nothing to claim. */
    idleMs?: number;
    logger?: Logger;
}

/**
 * Polls a leased queue with bounded concurrency.
 *
 * It only claims as many items as it has free slots, so everything it holds a
 * lease on is actively being worked on. That keeps shutdown simple: stop
 * claiming, let in-flight work finish, and nothing is left leased.
 */
export class ClaimLoop<T> {
    private readonly options: ClaimLoopOptions<T>;
    private readonly log: Logger;
    private readonly inFlight = new Set<Promise<void>>();
    private running = false;
    private loop: Promise<void> | undefined;
    private wake: (() => void) | undefined;

    constructor(options: ClaimLoopOptions<T>) {
        this.options = options;
        this.log = options.logger ?? silentLogger;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = this.run();
    }

    /** Stops claiming and waits for in-flight work, up to `timeoutMs`. */
    async stop(timeoutMs = 30_000): Promise<void> {
        if (!this.running) return;
        this.running = false;
        this.wake?.();
        await this.loop;
        const drained = Promise.all(this.inFlight).then(() => true);
        const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
        if (!(await Promise.race([drained, timedOut]))) {
            // The leases on whatever is still running expire and another
            // process picks those items up.
            this.log.warn("shutdown timed out with work in flight", { in_flight: this.inFlight.size });
        }
    }

    private async run(): Promise<void> {
        while (this.running) {
            const free = this.options.concurrency - this.inFlight.size;
            if (free === 0) {
                await Promise.race(this.inFlight);
                continue;
            }
            let claimed: T[] = [];
            try {
                claimed = await this.options.claim(free);
            } catch (error) {
                this.log.error("claim failed", { err: error instanceof Error ? error.message : String(error) });
            }
            for (const item of claimed) this.track(this.options.handle(item));
            if (claimed.length === 0) await this.idle();
        }
    }

    private track(task: Promise<void>): void {
        const tracked: Promise<void> = task
            .catch((error: unknown) => this.log.error("handler failed", { err: error instanceof Error ? error.message : String(error) }))
            .finally(() => {
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
            const timer = setTimeout(done, this.options.idleMs ?? 250);
            this.wake = done;
        });
    }
}
