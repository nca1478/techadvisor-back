import { ApiProperty } from '@nestjs/swagger';

/** Persisted active-model pointer: what retrieval is currently serving. */
export class ActiveEmbeddingDto {
  @ApiProperty({ example: 'text-embedding-3-small' })
  model!: string;

  @ApiProperty({ example: 1536 })
  dim!: number;

  @ApiProperty({ example: 'embedding' })
  column!: string;

  @ApiProperty({ example: 'vector', enum: ['vector', 'halfvec'] })
  cast!: string;
}

/** Created (or rejoined) reindex job. */
export class ReindexStartDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  jobId!: string;

  @ApiProperty({ example: 'started', enum: ['started', 'already-running'] })
  status!: string;

  @ApiProperty({
    example: 'openai/text-embedding-3-small',
    description: 'Model active when the job started.',
  })
  sourceModel!: string;

  @ApiProperty({ example: 'text-embedding-3-small' })
  targetModel!: string;

  @ApiProperty({ example: 1536 })
  targetDim!: number;

  @ApiProperty({ example: 'embedding' })
  targetColumn!: string;

  @ApiProperty({ example: 1200 })
  totalChunks!: number;

  @ApiProperty({ example: 12 })
  batches!: number;
}

/** Progress report: snapshot counters plus the live off-target count. */
export class ReindexProgressDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  jobId!: string;

  @ApiProperty({ example: 'RUNNING', enum: ['RUNNING', 'COMPLETED'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true, example: 'openai/text-embedding-3-small' })
  sourceModel!: string | null;

  @ApiProperty({ example: 'text-embedding-3-small' })
  targetModel!: string;

  @ApiProperty({ example: 1536 })
  targetDim!: number;

  @ApiProperty({ example: 'embedding' })
  targetColumn!: string;

  @ApiProperty({ example: 1200 })
  totalChunks!: number;

  @ApiProperty({ example: 300 })
  processedChunks!: number;

  @ApiProperty({ example: 0 })
  failedChunks!: number;

  @ApiProperty({ example: 25, description: '0–100 over the snapshotted set.' })
  percent!: number;

  @ApiProperty({
    example: 900,
    description:
      'Live chunks still missing vectors in the target column (informational; the activation gate covers the snapshotted set).',
  })
  remainingChunks!: number;

  @ApiProperty({ example: false })
  activatable!: boolean;
}

/** Result of flipping retrieval to the reindexed model. */
export class ReindexActivateDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  jobId!: string;

  @ApiProperty({ example: false })
  alreadyActive!: boolean;

  @ApiProperty({ example: 'text-embedding-3-small' })
  model!: string;

  @ApiProperty({ example: 1536 })
  dim!: number;

  @ApiProperty({ example: 'embedding' })
  column!: string;
}

/** Result of re-enqueuing the chunks still off-target. */
export class ReindexResumeDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  jobId!: string;

  @ApiProperty({ example: 3 })
  enqueuedBatches!: number;

  @ApiProperty({ example: 250 })
  remaining!: number;
}
