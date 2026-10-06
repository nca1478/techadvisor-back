import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InventoryService, toAvailability } from '../inventory/inventory.service.js';
import { InsufficientStockException } from '../inventory/inventory.errors.js';
import { pickLocalizedText, resolveLocale, resolvePrice } from '../catalog/catalog.service.js';
import type { CartItemDto, CartResponseDto } from './dto/cart.dto.js';

export type CartOwner = { kind: 'user'; userId: string } | { kind: 'guest'; sessionId: string };

/** Joined line data the pure assembler needs (no Prisma dependency). */
export interface CartLineInput {
  productId: string;
  qty: number;
  /** Null only when the product row is gone (FK cascade normally prevents it). */
  product: {
    name: string;
    slug: string;
    status: string;
    priceAmount: number;
    currency: string;
    translations: { locale: string; name: string }[];
    images: { url: string }[];
    prices: { currency: string; amount: number }[];
  } | null;
  /** Exact available units (`stock - reserved`), never negative. */
  available: number;
}

/**
 * Pure cart-response assembler (no database access): money always comes from
 * the joined product rows, totals are plain integer arithmetic over minor
 * units. Exported for unit tests.
 */
export function assembleCartResponse(input: {
  cartId: string;
  lines: CartLineInput[];
  locale: string;
  currency: string;
}): CartResponseDto {
  const items: CartItemDto[] = input.lines.map((line): CartItemDto => {
    const product = line.product;
    const active = product !== null && product.status === 'ACTIVE';
    const primaryImage =
      product !== null && product.images.length > 0 ? product.images[0] : undefined;
    const price =
      product !== null
        ? resolvePrice(
            { amount: product.priceAmount, currency: product.currency },
            product.prices,
            input.currency,
          )
        : { amount: 0, currency: input.currency };
    const availability = toAvailability(active ? line.available : 0);
    const sufficient = active && line.available >= line.qty;
    return {
      productId: line.productId,
      name:
        product !== null
          ? pickLocalizedText(product.translations, input.locale, (row) => row.name, product.name)
          : 'Unavailable product',
      slug: product?.slug ?? 'unavailable',
      imageUrl: primaryImage?.url ?? null,
      unitPriceAmount: price.amount,
      qty: line.qty,
      lineTotalAmount: price.amount * line.qty,
      inStock: active && availability.inStock,
      sufficientStock: sufficient,
      availableQuantity: availability.availableQuantity,
    };
  });
  return {
    id: input.cartId,
    currency: input.currency,
    locale: input.locale,
    items,
    totalAmount: items.reduce((sum, item) => sum + item.lineTotalAmount, 0),
    itemCount: items.reduce((sum, item) => sum + item.qty, 0),
  };
}

/**
 * Merge policy (see ADR 0010): guest + user quantities are summed but capped
 * at the available stock; lines with zero availability resolve to 0 (dropped
 * by the caller). Pure, unit-tested.
 */
export function capMergedQty(userQty: number, guestQty: number, available: number): number {
  return Math.max(0, Math.min(userQty + guestQty, Math.max(0, available)));
}

type CartWithItems = Prisma.CartGetPayload<{ include: { items: true } }>;

/**
 * Guest + authenticated carts. Totals are always computed from the database
 * (products + per-currency overrides); stock is checked read-only via
 * `InventoryService` — nothing here reserves units (that happens at order
 * creation).
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  requestedCurrency(currency: string | undefined): string {
    const requested = currency ?? this.config.BASE_CURRENCY;
    if (!this.config.SUPPORTED_CURRENCIES.includes(requested)) {
      throw new BadRequestException({
        message: `Unsupported currency "${requested}". Supported: ${this.config.SUPPORTED_CURRENCIES.join(', ')}`,
      });
    }
    return requested;
  }

  resolvedLocale(locale: string | undefined): string {
    return resolveLocale(locale, this.config.SUPPORTED_LOCALES, this.config.DEFAULT_LOCALE);
  }

  async getCart(
    owner: CartOwner,
    localeInput: string | undefined,
    currencyInput: string | undefined,
  ): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(owner);
    return this.toResponse(cart.id, localeInput, currencyInput);
  }

  async addItem(
    owner: CartOwner,
    productId: string,
    qty: number,
    localeInput: string | undefined,
    currencyInput: string | undefined,
  ): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(owner);
    await this.requireActiveProduct(productId);
    const existing = await this.prisma.cartItem.findUnique({
      where: { cartId_productId: { cartId: cart.id, productId } },
      select: { qty: true },
    });
    const nextQty = (existing?.qty ?? 0) + qty;
    await this.requireSufficientStock(productId, nextQty);
    await this.prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId } },
      create: { cartId: cart.id, productId, qty: nextQty },
      update: { qty: nextQty },
    });
    await this.touchCart(cart.id);
    return this.toResponse(cart.id, localeInput, currencyInput);
  }

  async setItemQty(
    owner: CartOwner,
    productId: string,
    qty: number,
    localeInput: string | undefined,
    currencyInput: string | undefined,
  ): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(owner);
    const existing = await this.prisma.cartItem.findUnique({
      where: { cartId_productId: { cartId: cart.id, productId } },
      select: { id: true },
    });
    if (existing === null) {
      throw new NotFoundException({ message: 'Cart item not found' });
    }
    await this.requireActiveProduct(productId);
    await this.requireSufficientStock(productId, qty);
    await this.prisma.cartItem.update({
      where: { cartId_productId: { cartId: cart.id, productId } },
      data: { qty },
    });
    await this.touchCart(cart.id);
    return this.toResponse(cart.id, localeInput, currencyInput);
  }

  async removeItem(
    owner: CartOwner,
    productId: string,
    localeInput: string | undefined,
    currencyInput: string | undefined,
  ): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(owner);
    // Idempotent: removing an absent line is a no-op (still returns the cart).
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, productId } });
    await this.touchCart(cart.id);
    return this.toResponse(cart.id, localeInput, currencyInput);
  }

  /**
   * Merges the guest cart into the user cart (summing lines capped at the
   * available stock), deletes the guest cart and returns the merged cart.
   * Without a guest session (or with an empty/missing guest cart) it simply
   * returns the user cart.
   */
  async mergeGuestIntoUser(
    userId: string,
    sessionId: string | null,
    localeInput: string | undefined,
    currencyInput: string | undefined,
  ): Promise<CartResponseDto> {
    if (sessionId !== null) {
      const guestCart = await this.prisma.cart.findUnique({
        where: { sessionId },
        include: { items: { select: { productId: true, qty: true } } },
      });
      if (guestCart !== null && guestCart.items.length > 0) {
        const availability = await this.inventory.getAvailabilityMap(
          guestCart.items.map((item) => item.productId),
        );
        await this.prisma.$transaction(async (tx) => {
          let userCart = await tx.cart.findUnique({ where: { userId } });
          if (userCart === null) {
            userCart = await tx.cart.create({ data: { userId } });
          }
          const userItems = await tx.cartItem.findMany({
            where: { cartId: userCart.id },
            select: { productId: true, qty: true },
          });
          const userQtyByProduct = new Map(userItems.map((item) => [item.productId, item.qty]));
          for (const guestItem of guestCart.items) {
            const capped = capMergedQty(
              userQtyByProduct.get(guestItem.productId) ?? 0,
              guestItem.qty,
              availability.get(guestItem.productId) ?? 0,
            );
            if (capped <= 0) {
              continue;
            }
            await tx.cartItem.upsert({
              where: {
                cartId_productId: { cartId: userCart.id, productId: guestItem.productId },
              },
              create: { cartId: userCart.id, productId: guestItem.productId, qty: capped },
              update: { qty: capped },
            });
          }
          await tx.cart.delete({ where: { id: guestCart.id } });
        });
      }
    }
    return this.toResponse(
      (await this.getOrCreateCart({ kind: 'user', userId })).id,
      localeInput,
      currencyInput,
    );
  }

  private async getOrCreateCart(owner: CartOwner): Promise<CartWithItems> {
    if (owner.kind === 'user') {
      return this.prisma.cart.upsert({
        where: { userId: owner.userId },
        create: { userId: owner.userId },
        update: {},
        include: { items: true },
      });
    }
    return this.prisma.cart.upsert({
      where: { sessionId: owner.sessionId },
      create: { sessionId: owner.sessionId },
      update: {},
      include: { items: true },
    });
  }

  private async requireActiveProduct(productId: string): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { status: true },
    });
    if (product === null || product.status !== 'ACTIVE') {
      throw new NotFoundException({ message: 'Product not available' });
    }
  }

  private async requireSufficientStock(productId: string, qty: number): Promise<void> {
    const available = await this.inventory.getAvailable(productId);
    if (qty > available) {
      throw new InsufficientStockException([productId]);
    }
  }

  private async touchCart(cartId: string): Promise<void> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
  }

  private async toResponse(
    cartId: string,
    localeInput: string | undefined,
    currencyInput: string | undefined,
  ): Promise<CartResponseDto> {
    const currency = this.requestedCurrency(currencyInput);
    const locale = this.resolvedLocale(localeInput);
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: {
              include: {
                images: { orderBy: { position: 'asc' }, take: 1 },
                prices: { where: { currency } },
                translations: { where: { locale } },
              },
            },
          },
        },
      },
    });
    if (cart === null) {
      // Only reachable if the cart row vanished mid-request (merge race);
      // callers recreate it on the next call.
      throw new NotFoundException({ message: 'Cart not found' });
    }
    const availability = await this.inventory.getAvailabilityMap(
      cart.items.map((item) => item.productId),
    );
    return assembleCartResponse({
      cartId: cart.id,
      locale,
      currency,
      lines: cart.items.map((item): CartLineInput => ({
        productId: item.productId,
        qty: item.qty,
        product: {
          name: item.product.name,
          slug: item.product.slug,
          status: item.product.status,
          priceAmount: item.product.priceAmount,
          currency: item.product.currency,
          translations: item.product.translations,
          images: item.product.images,
          prices: item.product.prices,
        },
        available: availability.get(item.productId) ?? 0,
      })),
    });
  }
}
