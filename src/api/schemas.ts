import { z } from "zod";
import { parseMailbox } from "../emails/address.ts";

export const MAX_RECIPIENTS = 50;
export const MAX_BATCH = 100;

const mailbox = z.string().refine((s) => parseMailbox(s) !== undefined, { message: "Invalid email address" });

const tag = z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "Tag names may only contain ASCII letters, numbers, underscores and dashes"),
    value: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "Tag values may only contain ASCII letters, numbers, underscores and dashes"),
});

export const sendEmailSchema = z
    .object({
        from: mailbox,
        to: z.union([mailbox, z.array(mailbox).min(1).max(MAX_RECIPIENTS)]).transform((to) => (Array.isArray(to) ? to : [to])),
        subject: z.string().min(1).max(998),
        html: z.string().optional(),
        text: z.string().optional(),
        tags: z.array(tag).max(10).default([]),
    })
    .strict()
    .refine((e) => e.html !== undefined || e.text !== undefined, { message: "Either html or text is required", path: ["html"] });

export type SendEmailInput = z.infer<typeof sendEmailSchema>;

export const batchSchema = z.array(sendEmailSchema).min(1).max(MAX_BATCH);

export const idempotencyKeySchema = z.string().min(1).max(256);

export function describeZodError(error: z.ZodError): string {
    return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}
