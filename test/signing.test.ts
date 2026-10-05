import { describe, expect, it } from "vitest";
import { sign, signedHeaders, verify, WebhookVerificationError } from "../src/webhooks/signing.ts";

const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
const now = new Date("2026-10-01T12:00:00Z");

describe("sign", () => {
    it("matches the published Standard Webhooks test vector", () => {
        expect(sign(secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}')).toBe(
            "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        );
    });
});

describe("verify", () => {
    const headers = signedHeaders(secret, "msg_1", body, now);

    it("accepts a correctly signed payload and returns it parsed", () => {
        expect(verify(secret, { ...headers }, body, { now })).toEqual(JSON.parse(body));
    });

    it("rejects a modified body", () => {
        expect(() => verify(secret, { ...headers }, body.replace("e1", "e2"), { now })).toThrow(WebhookVerificationError);
    });

    it("rejects a different secret", () => {
        expect(() => verify("whsec_" + Buffer.from("another key").toString("base64"), { ...headers }, body, { now })).toThrow(
            "No matching signature",
        );
    });

    it("rejects a swapped message id", () => {
        expect(() => verify(secret, { ...headers, "webhook-id": "msg_2" }, body, { now })).toThrow("No matching signature");
    });

    it("rejects timestamps outside the tolerance in either direction", () => {
        const late = new Date(now.getTime() + 301_000);
        const early = new Date(now.getTime() - 301_000);
        expect(() => verify(secret, { ...headers }, body, { now: late })).toThrow("tolerance");
        expect(() => verify(secret, { ...headers }, body, { now: early })).toThrow("tolerance");
        expect(() => verify(secret, { ...headers }, body, { now: new Date(now.getTime() + 299_000) })).not.toThrow();
    });

    it("rejects a re-signed timestamp without the secret", () => {
        const replayed = { ...headers, "webhook-timestamp": String(Number(headers["webhook-timestamp"]) + 10) };
        expect(() => verify(secret, replayed, body, { now })).toThrow("No matching signature");
    });

    it("accepts any one valid signature among several, as during secret rotation", () => {
        const multi = { ...headers, "webhook-signature": `v1,bm90IGl0 ${headers["webhook-signature"]} v2,ignored` };
        expect(verify(secret, multi, body, { now })).toEqual(JSON.parse(body));
    });

    it("rejects signatures of the wrong length or version", () => {
        const sig = headers["webhook-signature"].slice(3);
        expect(() => verify(secret, { ...headers, "webhook-signature": `v1,${sig.slice(0, 10)}` }, body, { now })).toThrow();
        expect(() => verify(secret, { ...headers, "webhook-signature": `v2,${sig}` }, body, { now })).toThrow();
    });

    it("rejects missing headers and non-numeric timestamps", () => {
        expect(() => verify(secret, {}, body, { now })).toThrow("Missing webhook headers");
        expect(() => verify(secret, { ...headers, "webhook-timestamp": "soon" }, body, { now })).toThrow("Invalid webhook-timestamp");
    });
});
