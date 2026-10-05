import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures in the Standard Webhooks / Svix scheme, so receivers can
 * use any existing verifier:
 *
 *   webhook-id:        msg_...
 *   webhook-timestamp: unix seconds
 *   webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">
 *
 * Secrets look like `whsec_<base64 key>`.
 */

export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {}

export interface WebhookHeaders {
    "webhook-id": string;
    "webhook-timestamp": string;
    "webhook-signature": string;
}

export function sign(secret: string, id: string, timestamp: number, body: string): string {
    const mac = createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
    return `v1,${mac}`;
}

export function signedHeaders(secret: string, id: string, body: string, now = new Date()): WebhookHeaders {
    const timestamp = Math.floor(now.getTime() / 1000);
    return { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": sign(secret, id, timestamp, body) };
}

/**
 * Checks the signature and timestamp of a received webhook and returns the
 * parsed payload. `body` must be the raw request body, byte for byte.
 * The signature header may hold several space-separated signatures (sent
 * while a secret is being rotated); one valid match is enough.
 */
export function verify(
    secret: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
    options: { toleranceSeconds?: number; now?: Date } = {},
): unknown {
    const id = single(headers["webhook-id"]);
    const timestampHeader = single(headers["webhook-timestamp"]);
    const signatures = single(headers["webhook-signature"]);
    if (!id || !timestampHeader || !signatures) throw new WebhookVerificationError("Missing webhook headers");

    const timestamp = Number(timestampHeader);
    if (!Number.isInteger(timestamp)) throw new WebhookVerificationError("Invalid webhook-timestamp");
    const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
    const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    if (Math.abs(now - timestamp) > tolerance) throw new WebhookVerificationError("Timestamp outside the tolerance window");

    const expected = Buffer.from(sign(secret, id, timestamp, body).slice(3), "base64");
    const matches = signatures.split(" ").some((candidate) => {
        const [version, value] = candidate.split(",", 2);
        if (version !== "v1" || !value) return false;
        const received = Buffer.from(value, "base64");
        // timingSafeEqual throws on a length mismatch; the length of an HMAC is public anyway.
        return received.length === expected.length && timingSafeEqual(received, expected);
    });
    if (!matches) throw new WebhookVerificationError("No matching signature");

    return JSON.parse(body);
}

function secretKey(secret: string): Buffer {
    return Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
}

function single(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}
