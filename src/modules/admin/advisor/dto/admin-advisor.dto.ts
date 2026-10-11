import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One abstention row under admin triage (full question: admin-only). */
export class AdminUnansweredQueryDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: '¿Cuánto dura la batería?', description: 'Raw user question.' })
  query!: string;

  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6', nullable: true })
  productId!: string | null;

  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6', nullable: true })
  sessionId!: string | null;

  @ApiProperty({ example: 'no_evidence' })
  reason!: string;

  @ApiProperty({ example: 'NEW', enum: ['NEW', 'IN_REVIEW', 'RESOLVED'] })
  status!: string;

  @ApiProperty({ example: '2026-10-10T12:00:00.000Z' })
  createdAt!: Date;
}

export class AdminUnansweredQueryListDto {
  @ApiProperty({ type: [AdminUnansweredQueryDto] })
  data!: AdminUnansweredQueryDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

/** One frequency bucket of near-duplicate abstentions (ADR 0040). */
export class AdminUnansweredGroupDto {
  @ApiProperty({
    example: 'cuanto dura la bateria',
    description: 'Normalized bucket key (lowercase, no diacritics/punctuation).',
  })
  key!: string;

  @ApiProperty({
    example: '¿Cuánto dura la batería?',
    description: 'First-seen raw question, as the human-readable sample.',
  })
  sample!: string;

  @ApiProperty({ example: 7, description: 'Rows in this bucket within the scan window.' })
  count!: number;

  @ApiProperty({ example: '2026-10-10T12:00:00.000Z' })
  latestAt!: string;

  @ApiProperty({
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    description: 'Row ids in this bucket (newest first), for drill-down.',
    type: [String],
  })
  ids!: string[];
}

export class AdminUnansweredGroupListDto {
  @ApiProperty({ type: [AdminUnansweredGroupDto] })
  data!: AdminUnansweredGroupDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 5 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

/**
 * One feedback vote, minimized: truncated excerpts carry enough context to
 * triage, never the full user/assistant texts (those live behind the
 * detail endpoint).
 */
export class AdminAdvisorFeedbackDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6', nullable: true })
  productId!: string | null;

  @ApiPropertyOptional({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    nullable: true,
    description: 'Chat session of the voted answer; backs the minimized conversation link.',
  })
  sessionId!: string | null;

  @ApiProperty({ example: 'up', enum: ['up', 'down'] })
  value!: string;

  @ApiProperty({ example: false })
  abstained!: boolean;

  @ApiProperty({
    example: '¿Cuánto dura la batería?',
    description: 'First 200 chars of the question.',
  })
  queryExcerpt!: string;

  @ApiProperty({
    example: 'La batería dura hasta 10 horas [1].',
    description: 'First 300 chars of the voted answer.',
  })
  answerExcerpt!: string;

  @ApiProperty({ example: 24, description: 'Full question length (the excerpt may be cut).' })
  queryLength!: number;

  @ApiProperty({ example: 38, description: 'Full answer length (the excerpt may be cut).' })
  answerLength!: number;

  @ApiProperty({ example: '2026-10-10T12:00:00.000Z' })
  createdAt!: Date;
}

export class AdminAdvisorFeedbackListDto {
  @ApiProperty({ type: [AdminAdvisorFeedbackDto] })
  data!: AdminAdvisorFeedbackDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

/** Full feedback vote (admin-only detail, e.g. to draft a corpus document). */
export class AdminAdvisorFeedbackDetailDto extends AdminAdvisorFeedbackDto {
  @ApiProperty({ example: '¿Cuánto dura la batería?' })
  query!: string;

  @ApiProperty({ example: 'La batería dura hasta 10 horas [1].' })
  answer!: string;
}

/**
 * One chat message, minimized for the admin conversation link: role,
 * timestamp and a 200-char excerpt. Full message content is never exposed
 * to back-office reads (see ADR 0040); purged sessions 404 like unknown ids.
 */
export class AdminAdvisorSessionMessageDto {
  @ApiProperty({ example: 'USER', enum: ['USER', 'ASSISTANT'] })
  role!: string;

  @ApiProperty({ example: 'Portátil para…', description: 'First 200 chars of the message.' })
  excerpt!: string;

  @ApiProperty({ example: 42, description: 'Full message length (the excerpt may be cut).' })
  length!: number;

  @ApiProperty({ example: '2026-10-10T12:00:00.000Z' })
  createdAt!: Date;
}

export class AdminAdvisorSessionDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  sessionId!: string;

  @ApiProperty({ example: 4, description: 'Messages kept in this session.' })
  messageCount!: number;

  @ApiProperty({ type: [AdminAdvisorSessionMessageDto] })
  messages!: AdminAdvisorSessionMessageDto[];

  @ApiProperty({ example: '2026-10-10T12:00:00.000Z' })
  createdAt!: Date;
}

export class AdminAdvisorCountDto {
  @ApiProperty({ example: 'NEW' })
  key!: string;

  @ApiProperty({ example: 12 })
  count!: number;
}

export class AdminAdvisorTopQueryDto {
  @ApiProperty({ example: 'cuanto dura la bateria' })
  key!: string;

  @ApiProperty({ example: '¿Cuánto dura la batería?' })
  sample!: string;

  @ApiProperty({ example: 7 })
  count!: number;
}

/** Improvement-loop summary: abstention, satisfaction, frequent gaps. */
export class AdminAdvisorMetricsDto {
  @ApiProperty({ example: 25, description: 'Open (NEW + IN_REVIEW) abstentions.' })
  openUnanswered!: number;

  @ApiProperty({ type: [AdminAdvisorCountDto], description: 'Abstentions by triage status.' })
  unansweredByStatus!: AdminAdvisorCountDto[];

  @ApiProperty({ type: [AdminAdvisorCountDto], description: 'Abstentions by advisor reason.' })
  unansweredByReason!: AdminAdvisorCountDto[];

  @ApiProperty({ example: 40, description: 'Feedback votes recorded.' })
  feedbackTotal!: number;

  @ApiProperty({ example: 30 })
  feedbackUp!: number;

  @ApiProperty({ example: 10 })
  feedbackDown!: number;

  @ApiProperty({
    example: 0.75,
    nullable: true,
    type: Number,
    description: 'up / total, null while no votes exist.',
  })
  satisfactionRate!: number | null;

  @ApiProperty({
    type: [AdminAdvisorTopQueryDto],
    description: 'Top normalized open questions (max 10) by frequency.',
  })
  topQueries!: AdminAdvisorTopQueryDto[];
}
