export type Outcome =
    | { kind: "delivered"; code: number; response: string }
    | { kind: "temporary"; code: number | null; response: string }
    | { kind: "permanent"; code: number; response: string };

const ENHANCED_STATUS = /^\d{3}[ -]([245])\.\d{1,3}\.\d{1,3}\b/;

/**
 * Maps an SMTP reply to what the queue should do with the delivery.
 *
 * 2xx is delivered, 4xx is retried and 5xx bounces. When the reply carries an
 * enhanced status code (RFC 3463), its class wins over the basic code: some
 * servers answer "550 4.2.1 rate limited", which is a temporary condition.
 */
export function classifyReply(code: number, response: string): Outcome {
    const enhanced = ENHANCED_STATUS.exec(response)?.[1];
    const klass = enhanced ? Number(enhanced) : Math.floor(code / 100);
    if (klass === 2) return { kind: "delivered", code, response };
    if (klass === 5) return { kind: "permanent", code, response };
    return { kind: "temporary", code, response };
}

/** Connection failures, timeouts and resets never reached a verdict, so they are retried. */
export function classifyTransportError(message: string): Outcome {
    return { kind: "temporary", code: null, response: message };
}
