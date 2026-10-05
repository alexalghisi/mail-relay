import { connect } from "node:net";
import nodemailer, { type Transporter } from "nodemailer";
import type { ClaimedDelivery } from "../queue/deliveries.ts";
import { classifyReply, classifyTransportError, type Outcome } from "./classify.ts";

export interface Sender {
    send(delivery: ClaimedDelivery): Promise<Outcome>;
}

export interface SmtpSenderOptions {
    host: string;
    port: number;
    /** Must stay well below the queue lease, or a slow send could outlive its lease. */
    timeoutMs?: number;
    /** HELO/EHLO name. */
    name?: string;
    /** Open connections kept to the relay; match it to the worker's concurrency. */
    maxConnections?: number;
}

interface SmtpError extends Error {
    responseCode?: number;
    response?: string;
}

/**
 * Sends one message per delivery over SMTP. Every recipient domain is routed
 * to the configured relay host; an MX lookup would slot in here.
 */
export class SmtpSender implements Sender {
    private readonly transport: Transporter;

    constructor(options: SmtpSenderOptions) {
        const timeout = options.timeoutMs ?? 30_000;
        this.transport = nodemailer.createTransport({
            host: options.host,
            port: options.port,
            // Connection setup costs a round trip per command plus whatever greeting
            // delay the server applies (100 ms for the fake MTA, often more in the
            // wild), so connections are pooled and reused across messages.
            pool: true,
            maxConnections: options.maxConnections ?? 8,
            maxMessages: Infinity,
            secure: false,
            ignoreTLS: true,
            name: options.name ?? "mail-relay.local",
            connectionTimeout: timeout,
            greetingTimeout: timeout,
            socketTimeout: timeout,
        });
        // The final "." of DATA is a tiny write right after the body. With
        // Nagle's algorithm on, it waits for the server's delayed ACK, which
        // adds about 40 ms to every message.
        this.transport.getSocket = (_options, callback) => {
            const socket = connect({ host: options.host, port: options.port, noDelay: true, timeout });
            const fail = (error: Error) => {
                socket.destroy();
                callback(error);
            };
            socket.once("error", fail);
            socket.once("timeout", () => fail(new Error(`connection to ${options.host}:${options.port} timed out`)));
            socket.once("connect", () => {
                socket.off("error", fail);
                socket.setTimeout(0);
                callback(null, { connection: socket });
            });
        };
    }

    async send(delivery: ClaimedDelivery): Promise<Outcome> {
        try {
            const info = await this.transport.sendMail({
                from: delivery.fromHeader,
                to: delivery.recipient,
                subject: delivery.subject,
                ...(delivery.html !== null && { html: delivery.html }),
                ...(delivery.textBody !== null && { text: delivery.textBody }),
                // Stable across retries, so a receiver that saw an earlier
                // attempt that we never got the reply for can drop the duplicate.
                messageId: `<${delivery.emailId}.${delivery.id}@mail-relay>`,
                headers: { "X-Delivery-Id": String(delivery.id), "X-Email-Id": delivery.emailId },
            });
            const response = String(info.response ?? "250 OK");
            return classifyReply(Number(response.slice(0, 3)) || 250, response);
        } catch (error) {
            const e = error as SmtpError;
            if (typeof e.responseCode === "number") return classifyReply(e.responseCode, e.response ?? e.message);
            return classifyTransportError(e.message);
        }
    }

    close(): void {
        this.transport.close();
    }
}
