import { z } from 'zod';

export const minor = z.string().regex(/^-?\d{1,18}$/);

export const category = z.string().trim().min(1).max(100);

export const kind = z.enum(['expense', 'income', 'transfer', 'refund']);
