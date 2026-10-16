import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export const documentTypeSchema = z.enum([
  'SPEC_SHEET',
  'MANUAL',
  'FAQ',
  'WARRANTY',
  'REVIEW',
  'POLICY',
]);

export type DocumentTypeInput = z.output<typeof documentTypeSchema>;

export const documentStatusSchema = z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']);

export type DocumentStatusInput = z.output<typeof documentStatusSchema>;

const documentTitleSchema = z
  .string({ error: 'title is required' })
  .trim()
  .min(1, { error: 'title must not be empty' })
  .max(200, { error: 'title must be at most 200 characters long' });

const documentLocaleSchema = z
  .string({ error: 'locale is required (BCP 47, e.g. en, es)' })
  .trim()
  .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' });

const optionalUuidSchema = z.uuid({ error: 'must be a valid UUID' }).optional();

const httpsUrlSchema = z
  .url({ error: 'sourceUrl must be a valid URL' })
  .max(2048, { error: 'sourceUrl must be at most 2048 characters long' })
  .refine((url) => url.startsWith('http://') || url.startsWith('https://'), {
    error: 'sourceUrl must use the http:// or https:// scheme',
  });

/**
 * Body for `POST /admin/documents`: registers a document by URL. The
 * backend fetches the bytes (http/https only, timeout + size capped, same
 * type validation as uploads) and ingests them; `sourceUrl` is kept as
 * provenance. Only `manual` provenance can be created here — product
 * SPEC_SHEETs are owned by the catalog hook.
 */
export const createDocumentFromUrlSchema = z.object({
  title: documentTitleSchema,
  type: documentTypeSchema,
  locale: documentLocaleSchema,
  productId: optionalUuidSchema,
  categoryId: optionalUuidSchema,
  sourceUrl: httpsUrlSchema,
});

export type CreateDocumentFromUrlInput = z.output<typeof createDocumentFromUrlSchema>;

/**
 * Multipart text fields for `POST /admin/documents/upload` (everything
 * arrives as strings). `title` defaults to the uploaded filename when
 * omitted; product/category association is optional.
 */
export const uploadDocumentFieldsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, { error: 'title must not be empty' })
    .max(200, { error: 'title must be at most 200 characters long' })
    .optional(),
  type: documentTypeSchema,
  locale: documentLocaleSchema,
  productId: z
    .string()
    .trim()
    .min(1)
    .refine((value) => z.uuid().safeParse(value).success, {
      error: 'productId must be a valid UUID',
    })
    .optional(),
  categoryId: z
    .string()
    .trim()
    .min(1)
    .refine((value) => z.uuid().safeParse(value).success, {
      error: 'categoryId must be a valid UUID',
    })
    .optional(),
});

export type UploadDocumentFields = z.output<typeof uploadDocumentFieldsSchema>;

/** Query for `GET /admin/documents`: optional status/type filters, title search + pagination. */
export const documentListQuerySchema = z.object({
  status: documentStatusSchema.optional(),
  type: documentTypeSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type DocumentListQuery = z.output<typeof documentListQuerySchema>;
