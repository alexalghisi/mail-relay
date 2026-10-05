import { z } from "zod";

export interface Mailbox {
    /** The address as the caller wrote it, display name included. */
    header: string;
    email: string;
    domain: string;
}

const NAME_ADDR = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/;
const emailSchema = z.string().email();

/** Parses `hello@acme.com` or `Acme <hello@acme.com>`. */
export function parseMailbox(input: string): Mailbox | undefined {
    const match = NAME_ADDR.exec(input);
    const raw = (match ? match[2] : input.trim()) ?? "";
    if (!emailSchema.safeParse(raw).success) return undefined;
    const email = raw.toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    return { header: input.trim(), email, domain };
}
