import { describe, expect, it } from "vitest";
import { classifyReply, classifyTransportError } from "../src/smtp/classify.ts";

describe("classifyReply", () => {
    it.each([
        [250, "250 2.0.0 OK queued as 1234", "delivered"],
        [421, "421 4.7.0 Too many connections", "temporary"],
        [451, "451 4.7.1 Greylisted", "temporary"],
        [452, "452 Insufficient storage", "temporary"],
        [550, "550 5.1.1 User unknown", "permanent"],
        [552, "552 Message size exceeds limit", "permanent"],
        [554, "554 5.7.1 Rejected by policy", "permanent"],
    ])("%i is %s", (code, response, kind) => {
        expect(classifyReply(code, response).kind).toBe(kind);
    });

    it("lets the enhanced status code override the basic code", () => {
        expect(classifyReply(550, "550 4.2.1 Mailbox temporarily rate limited").kind).toBe("temporary");
        expect(classifyReply(451, "451-5.7.1 Message rejected").kind).toBe("permanent");
    });

    it("ignores things that only look like enhanced codes", () => {
        expect(classifyReply(450, "450 mailbox 5.1.1x busy").kind).toBe("temporary");
    });
});

describe("classifyTransportError", () => {
    it("retries connection failures", () => {
        expect(classifyTransportError("connect ECONNREFUSED 127.0.0.1:2525")).toEqual({
            kind: "temporary",
            code: null,
            response: "connect ECONNREFUSED 127.0.0.1:2525",
        });
    });
});
