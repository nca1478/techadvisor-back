import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One stored chat session (owner never exposed: the caller owns it by construction). */
export class ChatSessionResponseDto {
  @ApiProperty({ example: 'session-id', description: 'Chat session id (UUID).' })
  id!: string;

  @ApiProperty({ example: 3, description: 'Messages stored in this session.' })
  messageCount!: number;

  @ApiProperty({
    example: '2026-10-09T12:00:00.000Z',
    description: 'Session creation time (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-10-09T12:00:00.000Z',
    description: 'Last session update time (ISO 8601).',
  })
  updatedAt!: Date;

  @ApiPropertyOptional({
    example: 'Busco un portátil para estudiar.',
    description:
      'First user message truncated for list labels; absent when the session has no user message yet.',
  })
  preview?: string;
}

/** One stored chat message. */
export class ChatMessageResponseDto {
  @ApiProperty({ example: 'message-id', description: 'Chat message id (UUID).' })
  id!: string;

  @ApiProperty({ enum: ['USER', 'ASSISTANT'], example: 'USER', description: 'Message author.' })
  role!: 'USER' | 'ASSISTANT';

  @ApiProperty({ example: '¿Cuánto dura la batería?', description: 'Message text.' })
  content!: string;

  @ApiProperty({ example: [], description: 'Validated citations shown with the answer.' })
  citations!: unknown[];

  @ApiProperty({ example: [], description: 'Product cards shown with the answer.' })
  products!: unknown[];

  @ApiProperty({ example: '2026-10-09T12:00:00.000Z', description: 'Creation time (ISO 8601).' })
  createdAt!: Date;
}

/** One session with its full history (oldest message first). */
export class ChatSessionHistoryResponseDto extends ChatSessionResponseDto {
  @ApiProperty({ type: [ChatMessageResponseDto] })
  messages!: ChatMessageResponseDto[];
}

/** Body for `POST /advisor/sessions/:id/messages`. */
export class CreateChatMessageRequestDto {
  @ApiProperty({ enum: ['USER', 'ASSISTANT'], example: 'USER', description: 'Message author.' })
  role!: 'USER' | 'ASSISTANT';

  @ApiProperty({
    example: 'Busco un portátil para estudiar, máx. 800 USD.',
    description: 'Message text (non-empty; max length from ADVISOR_MESSAGE_MAX_LENGTH).',
  })
  content!: string;

  @ApiPropertyOptional({ example: [], description: 'Citations shown with the answer.' })
  citations?: unknown[];

  @ApiPropertyOptional({ example: [], description: 'Product cards shown with the answer.' })
  products?: unknown[];
}

/** Result of the anonymous-session retention purge. */
export class ChatSessionsCleanupResponseDto {
  @ApiProperty({ example: 12, description: 'Anonymous sessions deleted by this run.' })
  deleted!: number;
}
