import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter.js';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { uuidParamsSchema, type UuidParams } from '../admin.schemas.js';
import { MAX_JOB_BYTES } from '../../ingestion/ingestion.constants.js';
import {
  AdminDocumentsService,
  type UploadedFile as UploadedFileShape,
} from './admin-documents.service.js';
import {
  createDocumentFromUrlSchema,
  documentListQuerySchema,
  uploadDocumentFieldsSchema,
  type CreateDocumentFromUrlInput,
  type DocumentListQuery,
  type UploadDocumentFields,
} from './admin-documents.schemas.js';
import { AdminDocumentDto, AdminDocumentListDto } from './dto/admin-document.dto.js';

/**
 * Maps multer edge failures (e.g. the file-size cap) to the uniform 400
 * payload. Anything else is delegated to a `HttpExceptionFilter` instance
 * — the same normalization the global filter applies.
 */
@Catch()
class UploadExceptionFilter implements ExceptionFilter {
  private readonly fallback = new HttpExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (
      exception !== null &&
      typeof exception === 'object' &&
      (exception as { code?: unknown }).code === 'LIMIT_FILE_SIZE'
    ) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse<{
        status: (code: number) => { json: (body: unknown) => void };
      }>();
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'BAD_REQUEST',
        message: `The file is too large (max ${String(MAX_JOB_BYTES)} bytes).`,
      });
      return;
    }
    this.fallback.catch(exception, host);
  }
}

/**
 * Back-office RAG corpus management (see ADR 0020). Every route requires
 * authentication plus role `ADMIN`. Uploaded bytes are treated as
 * untrusted data (text extraction only, never executed) and no
 * filesystem path is ever returned to clients.
 */
@ApiTags('admin')
@Controller('admin/documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@UseFilters(UploadExceptionFilter)
@ApiUniformErrorResponses(ErrorResponseDto)
export class AdminDocumentsController {
  constructor(private readonly documents: AdminDocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'List corpus documents (soft-deleted excluded) with status filter' })
  @ApiOkResponse({ type: AdminDocumentListDto })
  listDocuments(
    @Query(new ZodValidationPipe(documentListQuerySchema)) query: DocumentListQuery,
  ): Promise<AdminDocumentListDto> {
    return this.documents.listDocuments(query);
  }

  @Post()
  @ApiOperation({ summary: 'Register a document by URL (fetched + ingested server-side)' })
  @ApiCreatedResponse({ type: AdminDocumentDto })
  createFromUrl(
    @Body(new ZodValidationPipe(createDocumentFromUrlSchema)) body: CreateDocumentFromUrlInput,
  ): Promise<AdminDocumentDto> {
    return this.documents.createFromUrl(body);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload a document file (PDF, HTML, Markdown or plain text)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        title: { type: 'string' },
        type: {
          type: 'string',
          enum: ['SPEC_SHEET', 'MANUAL', 'FAQ', 'WARRANTY', 'REVIEW', 'POLICY'],
        },
        locale: { type: 'string', example: 'en' },
        productId: { type: 'string', format: 'uuid' },
        categoryId: { type: 'string', format: 'uuid' },
      },
      required: ['file', 'type', 'locale'],
    },
  })
  @ApiCreatedResponse({ type: AdminDocumentDto })
  @UseInterceptors(
    // No `storage` option: multer defaults to memory storage, which is what
    // the service expects (`file.buffer`). The hard size cap mirrors the
    // queue payload limit; the configured (possibly smaller) cap is
    // enforced with a legible error inside the service.
    FileInterceptor('file', {
      limits: { fileSize: MAX_JOB_BYTES, files: 1 },
    }),
  )
  uploadDocument(
    @UploadedFile() file: UploadedFileShape | undefined,
    @Body(new ZodValidationPipe(uploadDocumentFieldsSchema)) fields: UploadDocumentFields,
  ): Promise<AdminDocumentDto> {
    return this.documents.uploadDocument(file, fields);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a document with chunk count and error detail' })
  @ApiOkResponse({ type: AdminDocumentDto })
  getDocument(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
  ): Promise<AdminDocumentDto> {
    return this.documents.getDocument(params.id);
  }

  @Post(':id/reingest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-run ingestion from the stored source bytes' })
  @ApiOkResponse({ type: AdminDocumentDto })
  reingest(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
  ): Promise<AdminDocumentDto> {
    return this.documents.reingest(params.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a document and remove its chunks from search' })
  @ApiNoContentResponse({ description: 'Document soft-deleted; chunks removed.' })
  async remove(@Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams): Promise<void> {
    await this.documents.remove(params.id);
  }
}
