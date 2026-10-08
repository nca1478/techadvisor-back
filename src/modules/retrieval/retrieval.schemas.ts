import { z } from 'zod';
import { documentTypeSchema } from '../admin/documents/admin-documents.schemas.js';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

const localeSchema = z
  .string({ error: 'locale must be BCP 47 (e.g. en, es)' })
  .trim()
  .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' });

/**
 * Input for `RetrievalService.search` (hybrid RAG retrieval, see ADR 0021).
 *
 * `query` is the raw user question (max 1000 chars, matching the advisor
 * input guardrail). `filters` are hard metadata filters applied in SQL before
 * ranking. `locale` is the request locale: it narrows which full-text
 * configurations are queried (see the service for the strategy) but never
 * excludes vector candidates. `topN`/`candidateK`/`rrfK` tune result size and
 * fusion.
 */
export const retrievalSearchSchema = z.object({
  query: z
    .string({ error: 'query is required' })
    .trim()
    .min(1, { error: 'query must not be empty' })
    .max(1000, { error: 'query must be at most 1000 characters long' }),
  filters: z
    .object({
      productId: z.uuid({ error: 'filters.productId must be a valid UUID' }).optional(),
      categoryId: z.uuid({ error: 'filters.categoryId must be a valid UUID' }).optional(),
      docTypes: z.array(documentTypeSchema).min(1).max(6).optional(),
      locales: z.array(localeSchema).min(1).max(10).optional(),
    })
    .default({}),
  locale: localeSchema.optional(),
  topN: z.coerce.number().int().min(1).max(50).default(8),
  candidateK: z.coerce.number().int().min(1).max(100).default(20),
  rrfK: z.coerce.number().min(0).max(1000).default(60),
});

export type RetrievalSearchInput = z.input<typeof retrievalSearchSchema>;
export type RetrievalSearch = z.output<typeof retrievalSearchSchema>;
