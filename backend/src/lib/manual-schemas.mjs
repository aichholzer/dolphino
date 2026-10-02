import { z } from 'zod';
import { minor as exactMinor } from './engine.mjs';
import { tagsSchema } from './category-catalog.mjs';

const text = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
export const manualMoney = z
  .string()
  .regex(/^-?\d{1,19}$/)
  .transform((value) => exactMinor(value).toString());

export const manualDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value && value >= '1900-01-01';
  }, 'Choose a valid date from 1900 onward');

const requestId = z.string().uuid();
const revision = z.number().int().min(1).max(2147483647);
const accountId = text(200);
export const manualAccountSchema = z
  .object({
    requestId,
    name: text(100),
    description: z.string().trim().max(500).default(''),
    currency: z.string().regex(/^[A-Z]{3}$/),
    openingDate: manualDate,
    openingBalanceMinor: manualMoney
  })
  .strict();

const details = {
  description: text(500),
  category: text(100),
  tags: tagsSchema.default([]),
  note: z.string().max(1000).default(''),
  splits: z
    .array(z.object({ category: text(100), amountMinor: manualMoney }).strict())
    .max(50)
    .default([])
};
const activity = z
  .object({
    requestId,
    accountId,
    type: z.literal('activity'),
    kind: z.enum(['income', 'expense', 'refund']),
    date: manualDate,
    amountMinor: manualMoney,
    ...details
  })
  .strict();
const transfer = z
  .object({
    requestId,
    accountId,
    type: z.literal('transfer'),
    toAccountId: accountId,
    date: manualDate,
    amountMinor: manualMoney,
    receivedMinor: manualMoney
  })
  .strict();
const adjustment = z
  .object({
    requestId,
    accountId,
    type: z.literal('adjustment'),
    date: manualDate,
    targetBalanceMinor: manualMoney,
    accountRevision: revision,
    reason: text(500)
  })
  .strict();
export const manualEntrySchema = z.discriminatedUnion('type', [activity, transfer, adjustment]);

export const manualEditSchema = z.discriminatedUnion('type', [
  activity.extend({ revision }),
  transfer.extend({ revision }),
  z
    .object({
      requestId,
      accountId,
      type: z.literal('adjustment'),
      revision,
      date: manualDate,
      amountMinor: manualMoney,
      reason: text(500)
    })
    .strict(),
  z
    .object({
      requestId,
      accountId,
      type: z.literal('opening'),
      revision,
      date: manualDate,
      amountMinor: manualMoney,
      reason: text(500)
    })
    .strict()
]);

export const manualVoidSchema = z.object({ requestId, revision, reason: text(500) }).strict();

export const accountLifecycleSchema = z
  .object({
    requestId,
    revision: z.number().int().min(0).max(2147483647),
    action: z.enum(['freeze', 'unfreeze', 'delete', 'restore']),
    reason: text(500)
  })
  .strict();

export const accountPurgeSelection = z
  .object({
    accountIds: z
      .array(accountId.refine((value) => !value.includes(',')))
      .min(1)
      .max(100)
  })
  .strict();

export const accountPurgeSchema = accountPurgeSelection
  .extend({ requestId, previewToken: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.string() })
  .strict();
