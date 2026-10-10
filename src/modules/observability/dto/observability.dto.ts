import { ApiProperty } from '@nestjs/swagger';

/** Result of the `ai_call_logs` retention purge. */
export class AiCallLogCleanupResponseDto {
  @ApiProperty({ example: 12, description: 'Rows deleted by this run.' })
  deleted!: number;

  @ApiProperty({ example: 90, description: 'Configured retention window in days.' })
  retentionDays!: number;
}
