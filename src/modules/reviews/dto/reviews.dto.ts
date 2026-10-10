import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReviewDto {
  @ApiProperty({ description: 'Review id (UUID).' })
  id!: string;

  @ApiProperty({ description: 'Reviewed product id (UUID).' })
  productId!: string;

  @ApiProperty({ description: 'Star rating (1-5).', minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ description: 'Short headline (no author data).' })
  title!: string;

  @ApiProperty({ description: 'Review text (public, moderated).' })
  body!: string;

  @ApiProperty({ description: 'True when the author bought this product.' })
  verifiedPurchase!: boolean;

  @ApiProperty({ description: 'Creation date (ISO 8601).' })
  createdAt!: string;
}

export class ReviewListDto {
  @ApiProperty({ type: [ReviewDto] })
  data!: ReviewDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty({
    description: 'Mean rating over published reviews (null when none).',
    nullable: true,
  })
  averageRating!: number | null;
}

export class AdminReviewDto extends ReviewDto {
  @ApiProperty({ enum: ['PENDING', 'PUBLISHED', 'REJECTED'] })
  status!: 'PENDING' | 'PUBLISHED' | 'REJECTED';

  @ApiProperty({ description: 'Author user id (admin only, never public).' })
  userId!: string;
}

export class AdminReviewListDto {
  @ApiProperty({ type: [AdminReviewDto] })
  data!: AdminReviewDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class CreateReviewRequestDto {
  @ApiProperty({ description: 'Reviewed product id (UUID).' })
  productId!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ maxLength: 120 })
  title!: string;

  @ApiProperty({ maxLength: 2000 })
  body!: string;
}

export class ModerateReviewRequestDto {
  @ApiProperty({ enum: ['PUBLISHED', 'REJECTED'] })
  status!: 'PUBLISHED' | 'REJECTED';
}

export class ReviewSummaryDto {
  @ApiProperty({ description: 'Reviewed product id (UUID).' })
  productId!: string;

  @ApiProperty({
    type: [String],
    description: 'Short pro bullets (paraphrased, never long quotes).',
  })
  pros!: string[];

  @ApiProperty({
    type: [String],
    description: 'Short con bullets (paraphrased, never long quotes).',
  })
  cons!: string[];

  @ApiProperty({ description: 'Published reviews the summary was generated from.' })
  basedOnCount!: number;

  @ApiPropertyOptional({ description: 'LLM model id that generated the summary.' })
  model?: string;

  @ApiProperty({ description: 'Last generation date (ISO 8601).' })
  updatedAt!: string;
}

export class ReviewSummaryResponseDto {
  @ApiProperty({
    type: ReviewSummaryDto,
    nullable: true,
    description: 'Cached summary, or null while published reviews are below the minimum.',
  })
  summary!: ReviewSummaryDto | null;
}
