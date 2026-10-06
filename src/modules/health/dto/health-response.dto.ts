import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok', description: 'Overall API status.' })
  status!: string;

  @ApiProperty({
    example: 'up',
    enum: ['up', 'down'],
    description: 'Database reachability probed with a trivial query.',
  })
  db!: string;
}
