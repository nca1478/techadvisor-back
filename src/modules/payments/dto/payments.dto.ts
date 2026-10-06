import { ApiProperty } from '@nestjs/swagger';

/** Body for POST /payments/checkout: the order to pay (money comes from the DB). */
export class CreateCheckoutDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  orderId!: string;
}

export class CheckoutResponseDto {
  @ApiProperty({ example: 'stripe', description: 'Provider key (payments.provider).' })
  provider!: string;

  @ApiProperty({ example: 'cs_test_a1b2c3', description: 'Provider-side session id.' })
  sessionId!: string;

  @ApiProperty({
    example: 'https://checkout.stripe.com/pay/cs_test_a1b2c3',
    description: 'Hosted checkout URL for the frontend redirect.',
    nullable: true,
  })
  checkoutUrl!: string | null;
}

export class WebhookAckDto {
  @ApiProperty({ example: true })
  received!: boolean;
}
