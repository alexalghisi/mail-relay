import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from "smtp-server";
import type { AddressInfo } from "node:net";
import { silentLogger, type Logger } from "../log.ts";

export interface FakeMtaOptions {
    /** Extra time spent before answering DATA, per recipient domain. */
    slowDomains?: Record<string, number>;
    logger?: Logger;
}

export interface ReceivedMessage {
    deliveryId: string | undefined;
    messageId: string | undefined;
    from: string;
    to: string[];
    raw: string;
}

class SmtpReply extends Error {
    readonly responseCode: number;

    constructor(code: number, message: string) {
        super(message);
        this.responseCode = code;
    }
}

/**
 * A local MTA for tests, demos and benchmarks. The recipient's local part
 * picks the behaviour:
 *
 *   bounce...@    550 5.1.1 at RCPT TO, a permanent failure
 *   tempfail...@  451 4.7.1 at RCPT TO, every time
 *   flaky...@     451 4.7.1 on the first attempt for that address, then accepted
 *
 * Domains listed in `slowDomains` accept mail but take their time over it.
 */
export class FakeMta {
    readonly received: ReceivedMessage[] = [];
    readonly rejected: { to: string; code: number }[] = [];
    /** Highest number of concurrent DATA phases seen per recipient domain. */
    readonly peakConcurrency = new Map<string, number>();
    private readonly active = new Map<string, number>();
    private readonly seen = new Set<string>();
    private readonly server: SMTPServer;
    private readonly options: FakeMtaOptions;
    private readonly log: Logger;

    constructor(options: FakeMtaOptions = {}) {
        this.options = options;
        this.log = options.logger ?? silentLogger;
        this.server = new SMTPServer({
            authOptional: true,
            disableReverseLookup: true,
            disabledCommands: ["AUTH", "STARTTLS"],
            logger: false,
            banner: "fake-mta ready",
            size: 10 * 1024 * 1024,
            onRcptTo: (address, _session, callback) => callback(this.checkRecipient(address)),
            onData: (stream, session, callback) => {
                const chunks: Buffer[] = [];
                stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                stream.on("end", () => {
                    this.accept(session, Buffer.concat(chunks).toString("utf8")).then(
                        () => callback(null, "Message queued"),
                        (error: Error) => callback(error),
                    );
                });
            },
        });
        this.server.on("error", (error) => this.log.error("smtp error", { err: error.message }));
    }

    async listen(port = 0, host = "127.0.0.1"): Promise<number> {
        await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
        return (this.server.server.address() as AddressInfo).port;
    }

    close(): Promise<void> {
        return new Promise((resolve) => this.server.close(() => resolve()));
    }

    countFor(deliveryId: number): number {
        return this.received.filter((m) => m.deliveryId === String(deliveryId)).length;
    }

    private checkRecipient(address: SMTPServerAddress): SmtpReply | null {
        const to = address.address.toLowerCase();
        const local = to.slice(0, to.indexOf("@"));
        let reply: SmtpReply | null = null;
        if (local.startsWith("bounce")) reply = new SmtpReply(550, "5.1.1 <" + to + ">: Recipient address rejected: user unknown");
        else if (local.startsWith("tempfail")) reply = new SmtpReply(451, "4.7.1 <" + to + ">: Try again later");
        else if (local.startsWith("flaky") && !this.seen.has(to)) reply = new SmtpReply(451, "4.7.1 <" + to + ">: Greylisted, try again later");
        this.seen.add(to);
        if (reply) {
            this.rejected.push({ to, code: reply.responseCode });
            this.log.warn(`RCPT ${to}`, { reply: `${reply.responseCode} ${reply.message.split(" ")[0]}` });
        }
        return reply;
    }

    private async accept(session: SMTPServerSession, raw: string): Promise<void> {
        const to = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
        const domain = to[0]?.split("@")[1] ?? "";
        const running = (this.active.get(domain) ?? 0) + 1;
        this.active.set(domain, running);
        this.peakConcurrency.set(domain, Math.max(this.peakConcurrency.get(domain) ?? 0, running));
        try {
            const delay = this.options.slowDomains?.[domain];
            if (delay) await new Promise((r) => setTimeout(r, delay));
            const message: ReceivedMessage = {
                deliveryId: header(raw, "X-Delivery-Id"),
                messageId: header(raw, "Message-ID"),
                from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
                to,
                raw,
            };
            this.received.push(message);
            this.log.info(`accepted for ${to.join(",")}`, { delivery: message.deliveryId });
        } finally {
            this.active.set(domain, (this.active.get(domain) ?? 1) - 1);
        }
    }
}

function header(raw: string, name: string): string | undefined {
    const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(raw.split(/\r?\n\r?\n/)[0] ?? "");
    return match?.[1]?.trim();
}
