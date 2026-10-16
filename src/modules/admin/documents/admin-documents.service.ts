import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { IngestionService } from '../../ingestion/ingestion.service.js';
import { MANUAL_SOURCE } from '../../ingestion/ingestion.constants.js';
import type { AdminDocumentDto, AdminDocumentListDto } from './dto/admin-document.dto.js';
import { DocumentStorageService } from './document-storage.service.js';
import { UploadValidationError, validateUpload } from './validate-upload.js';
import type {
  CreateDocumentFromUrlInput,
  DocumentListQuery,
  UploadDocumentFields,
} from './admin-documents.schemas.js';

type DocumentRow = Prisma.DocumentGetPayload<{
  include: { _count: { select: { chunks: true } } };
}>;

/** Minimal structural shape of a multer memory-storage file (no new types dep). */
export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Back-office RAG corpus management (see ADR 0020). Every route using this
 * service sits behind `JwtAuthGuard + @Roles('ADMIN')`.
 *
 * - Uploads are validated strictly (real type via magic bytes, size cap)
 *   and stored on local disk under an internal UUID key; no filesystem
 *   path ever leaves the server.
 * - File bytes are treated as untrusted data: they are only text-extracted
 *   by the ingestion pipeline, never executed or interpreted.
 * - Deletion is soft (`deleted_at`) plus physical chunk removal, so the
 *   document stops matching every search immediately while the row stays
 *   for audit. List/detail exclude soft-deleted rows.
 */
@Injectable()
export class AdminDocumentsService {
  private readonly logger = new Logger(AdminDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly storage: DocumentStorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async listDocuments(query: DocumentListQuery): Promise<AdminDocumentListDto> {
    const where: Prisma.DocumentWhereInput = { deletedAt: null };
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.type !== undefined) {
      where.type = query.type;
    }
    if (query.q !== undefined) {
      where.title = { contains: query.q, mode: 'insensitive' };
    }
    const skip = (query.page - 1) * query.limit;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
        include: { _count: { select: { chunks: true } } },
      }),
    ]);
    return {
      data: rows.map((row) => this.toDto(row)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  async getDocument(id: string): Promise<AdminDocumentDto> {
    return this.toDto(await this.findActiveOrThrow(id));
  }

  /**
   * Registers a document by URL: fetches the bytes (http/https, timeout +
   * size capped, same validation as uploads), stores them on disk and
   * triggers ingestion. The URL is kept as provenance in `sourceUrl`.
   */
  async createFromUrl(input: CreateDocumentFromUrlInput): Promise<AdminDocumentDto> {
    this.assertSupportedLocale(input.locale);
    await this.assertAssociations(input.productId, input.categoryId);
    const { raw, contentType } = await this.fetchUrl(input.sourceUrl);
    const validated = this.validateOrThrow(raw, contentType);
    const document = await this.prisma.document.create({
      data: {
        type: input.type,
        title: input.title,
        locale: input.locale,
        productId: input.productId ?? null,
        categoryId: input.categoryId ?? null,
        sourceUrl: input.sourceUrl,
        source: MANUAL_SOURCE,
        contentHash: 'pending',
        status: 'PENDING',
        fileName: null,
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
        storageKey: null,
      },
      include: { _count: { select: { chunks: true } } },
    });
    const storageKey = await this.storage.save(document.id, raw);
    const stored = await this.prisma.document.update({
      where: { id: document.id },
      data: { storageKey },
      include: { _count: { select: { chunks: true } } },
    });
    await this.triggerIngestion(document.id, raw, validated.mimeType);
    return this.toDto(await this.findActiveOrThrow(stored.id));
  }

  /**
   * Stores an uploaded file and triggers ingestion. `fields` are the
   * validated multipart text fields; the title falls back to the client
   * filename (sanitized to a max length, display-only).
   */
  async uploadDocument(file: UploadedFile | undefined, fields: UploadDocumentFields) {
    if (file === undefined || file.buffer.length === 0) {
      throw new BadRequestException({ message: 'A file is required (multipart field "file")' });
    }
    this.assertSupportedLocale(fields.locale);
    await this.assertAssociations(fields.productId, fields.categoryId);
    const raw = Buffer.from(file.buffer);
    const validated = this.validateOrThrow(raw, file.mimetype);
    const title = fields.title ?? sanitizeTitle(file.originalname);
    const document = await this.prisma.document.create({
      data: {
        type: fields.type,
        title,
        locale: fields.locale,
        productId: fields.productId ?? null,
        categoryId: fields.categoryId ?? null,
        source: MANUAL_SOURCE,
        contentHash: 'pending',
        status: 'PENDING',
        fileName: sanitizeTitle(file.originalname),
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
        storageKey: null,
      },
      include: { _count: { select: { chunks: true } } },
    });
    const storageKey = await this.storage.save(document.id, raw);
    await this.prisma.document.update({ where: { id: document.id }, data: { storageKey } });
    await this.triggerIngestion(document.id, raw, validated.mimeType);
    return this.toDto(await this.findActiveOrThrow(document.id));
  }

  /**
   * Re-runs ingestion from the stored bytes (disk copy, or the registered
   * URL when the disk copy is gone). READY documents whose content is
   * unchanged are a no-op in the pipeline (same chunk count, no provider
   * call); FAILED documents are retried.
   */
  async reingest(id: string): Promise<AdminDocumentDto> {
    const document = await this.findActiveOrThrow(id);
    let raw: Buffer | null = null;
    let contentType = document.mimeType ?? 'text/plain';
    if (document.storageKey !== null) {
      raw = await this.storage.read(document.storageKey);
    }
    if (raw === null && document.sourceUrl !== null) {
      const fetched = await this.fetchUrl(document.sourceUrl);
      raw = fetched.raw;
      contentType = fetched.contentType;
    }
    if (raw === null) {
      throw new ConflictException({
        message:
          'No source bytes available for this document (upload a new file or register a URL instead)',
      });
    }
    const validated = this.validateOrThrow(raw, contentType);
    const storageKey = await this.storage.save(document.id, raw);
    await this.prisma.document.update({
      where: { id },
      data: {
        status: 'PENDING',
        error: null,
        storageKey,
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
      },
    });
    await this.triggerIngestion(id, raw, validated.mimeType);
    return this.toDto(await this.findActiveOrThrow(id));
  }

  /**
   * Soft-deletes a document: stamps `deletedAt` and removes its chunks in
   * the same transaction, so its content stops matching every search
   * immediately. The row stays for audit; the source file is kept on disk.
   */
  async remove(id: string): Promise<void> {
    await this.findActiveOrThrow(id);
    await this.prisma.$transaction([
      this.prisma.chunk.deleteMany({ where: { documentId: id } }),
      this.prisma.document.update({ where: { id }, data: { deletedAt: new Date() } }),
    ]);
  }

  // --- Helpers -----------------------------------------------------------

  /**
   * Enqueues background ingestion; when Redis is unreachable the document
   * is ingested inline instead, so single-process dev/test setups still
   * reach READY without a worker. Never throws: failures land on the
   * document row as FAILED + legible error (owned by IngestionService).
   */
  private async triggerIngestion(
    documentId: string,
    raw: Buffer,
    contentType: string,
  ): Promise<void> {
    try {
      const result = await this.ingestion.enqueueDocument(documentId, raw, contentType);
      if (result.enqueued || result.reason === 'duplicate') {
        return;
      }
    } catch (error) {
      this.logger.warn(
        `Enqueue failed for document ${documentId}, ingesting inline: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    try {
      await this.ingestion.ingestDocument(documentId, raw, contentType);
    } catch (error) {
      this.logger.warn(
        `Inline ingestion failed for document ${documentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** Fetches a registered URL with timeout + size caps (bytes stay untrusted). */
  private async fetchUrl(sourceUrl: string): Promise<{ raw: Buffer; contentType: string }> {
    let response: Response;
    try {
      response = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      throw new BadRequestException({
        message: `Could not fetch sourceUrl: ${error instanceof Error ? error.message : 'request failed'}`,
      });
    }
    if (!response.ok) {
      throw new BadRequestException({
        message: `Could not fetch sourceUrl (HTTP ${String(response.status)})`,
      });
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > this.config.DOCUMENTS_MAX_BYTES) {
      throw new BadRequestException({
        message: `Remote file is too large (${declaredLength} bytes, max ${String(this.config.DOCUMENTS_MAX_BYTES)} bytes)`,
      });
    }
    const raw = Buffer.from(await response.arrayBuffer());
    return { raw, contentType: response.headers.get('content-type') ?? '' };
  }

  private validateOrThrow(raw: Buffer, contentType: string | undefined) {
    try {
      return validateUpload(raw, contentType, this.config.DOCUMENTS_MAX_BYTES);
    } catch (error) {
      if (error instanceof UploadValidationError) {
        throw new BadRequestException({ message: error.message });
      }
      throw error;
    }
  }

  private assertSupportedLocale(locale: string): void {
    if (!this.config.SUPPORTED_LOCALES.includes(locale)) {
      throw new BadRequestException({
        message: `Unsupported locale "${locale}". Supported: ${this.config.SUPPORTED_LOCALES.join(', ')}`,
      });
    }
  }

  private async assertAssociations(
    productId: string | undefined,
    categoryId: string | undefined,
  ): Promise<void> {
    if (productId !== undefined) {
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (product === null) {
        throw new NotFoundException({ message: `Product "${productId}" not found` });
      }
    }
    if (categoryId !== undefined) {
      const category = await this.prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      });
      if (category === null) {
        throw new NotFoundException({ message: `Category "${categoryId}" not found` });
      }
    }
  }

  private async findActiveOrThrow(id: string): Promise<DocumentRow> {
    const row = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { chunks: true } } },
    });
    if (row === null) {
      throw new NotFoundException({ message: 'Document not found' });
    }
    return row;
  }

  private toDto(row: DocumentRow): AdminDocumentDto {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      locale: row.locale,
      productId: row.productId,
      categoryId: row.categoryId,
      sourceUrl: row.sourceUrl,
      source: row.source,
      status: row.status,
      error: row.error,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      chunkCount: row._count.chunks,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Display-only title fallback: basename-ish, capped, never a path. */
function sanitizeTitle(originalname: string): string {
  const base = originalname.split(/[\\/]/).pop() ?? originalname;
  const trimmed = base.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : 'Uploaded document';
}
