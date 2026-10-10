import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HealthIngestionCountsDto {
  @ApiProperty({ example: 3 })
  waiting!: number;

  @ApiProperty({ example: 1 })
  active!: number;

  @ApiProperty({ example: 0 })
  delayed!: number;

  @ApiProperty({ example: 0 })
  failed!: number;
}

export class HealthAiStateDto {
  @ApiProperty({ example: 'openai-compatible' })
  provider!: string;

  @ApiProperty({ example: 'text-embedding-3-small' })
  model!: string;

  @ApiProperty({ example: 'OK', enum: ['OK', 'ERROR'] })
  status!: string;
}

export class HealthResponseDto {
  @ApiProperty({ example: 'ok', description: 'Overall API status.' })
  status!: string;

  @ApiProperty({
    example: 'up',
    enum: ['up', 'down'],
    description: 'Database reachability probed with a trivial query.',
  })
  db!: string;

  @ApiProperty({
    example: 'up',
    enum: ['up', 'down'],
    description: 'Redis reachability probed with PING (short timeout).',
  })
  redis!: string;

  @ApiProperty({
    example: 'up',
    enum: ['up', 'down', 'unknown'],
    description: 'Ingestion queue readability (down when Redis is unreachable).',
  })
  ingestion!: string;

  @ApiPropertyOptional({
    type: HealthIngestionCountsDto,
    description: 'BullMQ ingestion queue depths; absent when the queue is unreadable.',
  })
  ingestionCounts?: HealthIngestionCountsDto;

  @ApiProperty({
    example: 'up',
    enum: ['up', 'degraded', 'unknown'],
    description:
      'AI availability from the last known instrumented call outcome (never a live provider probe).',
  })
  ai!: string;

  @ApiPropertyOptional({
    type: [HealthAiStateDto],
    description: 'Last known outcome per provider/model (metadata only, no content).',
  })
  aiStates?: HealthAiStateDto[];
}
