import type { ApiKeyRecord } from "../accounts/repository.ts";
import { verifiedDomains } from "../accounts/repository.ts";
import { ApiError } from "../api/errors.ts";
import type { SendEmailInput } from "../api/schemas.ts";
import type { Queryable } from "../db/pool.ts";
import { parseMailbox } from "./address.ts";
import { insertEmail, type NewEmail } from "./repository.ts";

/**
 * Queues a list of already validated emails. Either every email is accepted
 * or none is: all sender domains are checked before the first insert, and the
 * caller runs this inside a transaction.
 */
export async function queueEmails(db: Queryable, apiKey: ApiKeyRecord, inputs: SendEmailInput[]): Promise<string[]> {
    const emails = inputs.map((input) => toNewEmail(apiKey, input));
    const verified = await verifiedDomains(db, apiKey.teamId, [...new Set(emails.map((e) => e.from.domain))]);

    emails.forEach((email, index) => {
        if (!verified.has(email.from.domain)) {
            const where = inputs.length > 1 ? ` (email ${index})` : "";
            throw new ApiError(403, "validation_error", `The ${email.from.domain} domain is not verified${where}.`);
        }
    });

    const ids: string[] = [];
    for (const email of emails) ids.push(await insertEmail(db, email));
    return ids;
}

function toNewEmail(apiKey: ApiKeyRecord, input: SendEmailInput): NewEmail {
    // The schema already rejected unparsable addresses.
    const from = parseMailbox(input.from)!;
    const recipients = [...new Set(input.to.map((to) => parseMailbox(to)!.email))];
    return {
        teamId: apiKey.teamId,
        apiKeyId: apiKey.id,
        from,
        recipients,
        subject: input.subject,
        html: input.html,
        text: input.text,
        tags: input.tags,
    };
}
