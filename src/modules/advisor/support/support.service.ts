import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';
import type { RequestUser } from '../../auth/jwt-auth.guard.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AiProviderError, AiRateLimitError } from '../../ai/ai-provider.error.js';
import type { LlmProvider } from '../../ai/interfaces/llm-provider.interface.js';
import { LLM_PROVIDER } from '../../ai/interfaces/llm-provider.interface.js';
import { resolveLocale } from '../../catalog/catalog.service.js';
import { RetrievalService, type RetrievalHit } from '../../retrieval/retrieval.service.js';
import { buildCitations } from '../citations.js';
import type { SupportResponseDto } from '../dto/support.dto.js';
import {
  buildSupportUserMessage,
  isExceptionRequest,
  loadSupportSystemPrompt,
  renderSupportSystemPrompt,
  type SupportOrderFacts,
} from './support.prompt.js';
import type { SupportInput } from './support.schemas.js';

/** Evidence chunks kept for the prompt (policies, warranty, FAQ). */
export const SUPPORT_TOP_N = 8;

/** Retrieval scope of the support advisor: post-sale document kinds only. */
export const SUPPORT_DOC_TYPES = ['POLICY', 'WARRANTY', 'FAQ'] as const;

/**
 * Post-sale support advisor (see ADR 0036): answers questions about
 * warranty, shipping, returns, payment methods and privacy using only
 * retrieved POLICY/WARRANTY/FAQ evidence, with citations and abstention.
 *
 * Flow: owned-order check when `orderId` is set (anonymous callers 401,
 * other users' orders 404 exactly like unknown ids, before any retrieval or
 * LLM cost) → hybrid retrieval scoped to post-sale doc types → abstain below
 * `ADVISOR_ABSTAIN_MIN_SCORE` WITHOUT calling the LLM (recording
 * `unanswered_queries` with no product) → prompt with numbered chunks plus
 * optional SQL-hydrated ORDER FACTS → `LlmProvider.generate` → invented
 * `[n]` citations discarded. Order state, totals and dates never come from
 * the LLM; no personal data is ever sent to it, and the full prompt is never
 * logged.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);
  private readonly systemTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: RetrievalService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // Fail fast at boot when the versioned prompt is missing.
    this.systemTemplate = loadSupportSystemPrompt();
  }

  /**
   * Answers one post-sale question, optionally grounding it in one of the
   * caller's own orders. `user` is the authenticated caller or null for
   * anonymous requests (order-scoped questions require authentication).
   */
  async answerSupportQuestion(
    input: SupportInput,
    user: RequestUser | null,
  ): Promise<SupportResponseDto> {
    const locale = resolveLocale(
      input.locale,
      this.config.SUPPORTED_LOCALES,
      this.config.DEFAULT_LOCALE,
    );

    const orderFacts = await this.findOwnedOrderFacts(input.orderId, user);
    const hits = await this.retrieval.search({
      query: input.question,
      filters: { docTypes: [...SUPPORT_DOC_TYPES] },
      locale,
      topN: SUPPORT_TOP_N,
    });
    const best = hits.length > 0 ? (hits[0]?.score ?? 0) : 0;
    if (hits.length === 0 || best < this.config.ADVISOR_ABSTAIN_MIN_SCORE) {
      const reason = hits.length === 0 ? 'no_evidence' : 'below_threshold';
      await this.prisma.unansweredQuery.create({
        data: { query: input.question, productId: null, sessionId: null, reason },
      });
      // Never log the question text: it may contain personal data.
      this.logger.debug(
        `advisor support: abstained reason=${reason} hits=${String(hits.length)} withOrder=${String(orderFacts !== undefined)}`,
      );
      return { answer: supportAbstentionMessage(locale), citations: [], abstained: true };
    }

    const userMessage = buildSupportUserMessage({
      question: input.question,
      ...(orderFacts !== undefined ? { orderFacts } : {}),
      hits,
      exceptionRequest: isExceptionRequest(input.question),
    });
    const result = await this.generateAnswer(userMessage, locale);
    const citations = buildCitations(result.text, hits);

    // Metadata only: never the prompt, the question or the answer.
    this.logger.debug(
      `advisor support: answered hits=${String(hits.length)} citations=${String(citations.length)} abstained=false provider=${this.llm.providerName} latencyMs=${String(result.latencyMs)}`,
    );
    return { answer: result.text, citations, abstained: false };
  }

  /**
   * Loads the minimal structured facts of one owned order. Anonymous callers
   * asking about an order 401; orders of other users 404 identically to
   * unknown ids so ownership is never revealed. Only status/total/items/date
   * travel to the prompt — never addresses, emails or payment data.
   */
  private async findOwnedOrderFacts(
    orderId: string | undefined,
    user: RequestUser | null,
  ): Promise<SupportOrderFacts | undefined> {
    if (orderId === undefined) {
      return undefined;
    }
    if (user === null) {
      throw new UnauthorizedException({ message: 'Authentication required' });
    }
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, userId: user.id },
      include: { _count: { select: { items: true } } },
    });
    if (row === null) {
      throw new NotFoundException({ message: 'Order not found' });
    }
    return {
      status: row.status,
      currency: row.currency,
      totalAmount: row.totalAmount,
      itemCount: row._count.items,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * LLM call with provider-failure mapping (see ADR 0026). Provider outages,
   * expired keys and timeouts become uniform 503 (429 when the provider
   * itself rate-limits) so clients can tell "try again later" apart from a
   * real 500. Only metadata reaches the logs — never prompts or keys.
   */
  private async generateAnswer(
    userMessage: string,
    locale: string,
  ): Promise<{ text: string; latencyMs: number }> {
    try {
      return await this.llm.generate({
        system: renderSupportSystemPrompt(this.systemTemplate, locale),
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (error) {
      if (error instanceof AiRateLimitError) {
        this.logger.warn(`advisor support: provider rate limited provider=${error.provider}`);
        throw new HttpException(
          { message: 'Advisor provider rate limited, try again later' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof AiProviderError) {
        this.logger.warn(
          `advisor support: provider failed code=${error.code} provider=${error.provider}`,
        );
        throw new ServiceUnavailableException({
          message: 'Advisor provider unavailable, try again later',
        });
      }
      throw error;
    }
  }
}

/**
 * Localized abstention message (backend-side, no LLM involved): states the
 * lack of evidence and hands the case to the human team. Spanish for `es*`
 * locales, English otherwise — matching the two UI languages.
 */
export function supportAbstentionMessage(locale: string): string {
  if (locale.toLowerCase().startsWith('es')) {
    return 'No tengo esa información en las políticas de la tienda. Te derivo con el equipo humano de soporte, que podrá ayudarte con tu caso.';
  }
  return "I don't have that information in the store policies. I'm handing your case to the human support team, who can help you further.";
}

/** Re-exported for unit tests asserting the retrieval scope in isolation. */
export type { RetrievalHit as SupportRetrievalHit };
