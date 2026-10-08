import { ApiProperty } from '@nestjs/swagger';

/**
 * Admin view of a RAG source document. Deliberately exposes no filesystem
 * information: `storageKey` and the absolute directory never leave the
 * server (see ADR 0020). `fileName` is the original client name for
 * display only; `sourceUrl` is the registered URL (if any).
 */
export class AdminDocumentDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({
    example: 'MANUAL',
    enum: ['SPEC_SHEET', 'MANUAL', 'FAQ', 'WARRANTY', 'REVIEW', 'POLICY'],
  })
  type!: string;

  @ApiProperty({ example: 'Laptop X1 setup manual' })
  title!: string;

  @ApiProperty({ example: 'en' })
  locale!: string;

  @ApiProperty({ type: String, nullable: true, example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  categoryId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'https://example.com/manual.pdf' })
  sourceUrl!: string | null;

  @ApiProperty({ example: 'manual' })
  source!: string;

  @ApiProperty({ example: 'PENDING', enum: ['PENDING', 'PROCESSING', 'READY', 'FAILED'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  error!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'manual.pdf' })
  fileName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'application/pdf' })
  mimeType!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 48213 })
  sizeBytes!: number | null;

  @ApiProperty({ example: 12, description: 'Chunks stored for this document.' })
  chunkCount!: number;

  @ApiProperty({ example: '2026-10-08T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-08T12:00:00.000Z' })
  updatedAt!: Date;
}

export class AdminDocumentListDto {
  @ApiProperty({ type: [AdminDocumentDto] })
  data!: AdminDocumentDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 7 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}
