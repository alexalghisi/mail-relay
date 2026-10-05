import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "mr_";

export function generateApiToken(): string {
    return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiToken(token: string): Buffer {
    return createHash("sha256").update(token).digest();
}

export function displayPrefix(token: string): string {
    return token.slice(0, TOKEN_PREFIX.length + 6);
}
