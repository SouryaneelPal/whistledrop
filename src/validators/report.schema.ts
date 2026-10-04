import { z } from 'zod';
import { CATEGORIES } from '../domain/statusWorkflow';

export const categorySchema = z.enum(CATEGORIES, { error: `Must be one of ${CATEGORIES.join(', ')}` });

// Strict so that no extra data (contact details, device info) can be stored alongside a report.
export const reportSchema = z.strictObject({
  category: categorySchema,
  description: z
    .string({ error: 'Must be a string' })
    .trim()
    .min(10, 'Must be at least 10 characters')
    .max(5000, 'Must be at most 5000 characters'),
  evidenceUrl: z
    .url({ protocol: /^https?$/, error: 'Must be a valid http or https URL' })
    .max(2048, 'Must be at most 2048 characters')
    .optional(),
});

export const checkSchema = z.strictObject({
  description: z.string({ error: 'Must be a string' }).max(5000, 'Must be at most 5000 characters'),
});

export type ReportInput = z.infer<typeof reportSchema>;
