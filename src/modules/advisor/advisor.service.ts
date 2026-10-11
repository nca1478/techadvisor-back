import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiProviderError, AiRateLimitError } from '../ai/ai-provider.error.js';
import type { LlmProvider } from '../ai/interfaces/llm-provider.interface.js';
import { LLM_PROVIDER } from '../ai/interfaces/llm-provider.interface.js';
import { resolveLocale } from '../catalog/catalog.service.js';
import { toAvailability } from '../inventory/inventory.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { RetrievalService, type RetrievalHit } from '../retrieval/retrieval.service.js';
import type { FeedbackInput, ProductQaInput } from './advisor.schemas.js';
import { buildCitations } from './citations.js';
import { ChatSessionsService, type ChatSessionOwner } from './chat-sessions.service.js';
import type { AdvisorFeedbackResponseDto, ProductQaResponseDto } from './dto/advisor.dto.js';
import {
  buildProductQaUserMessage,
  loadProductQaSystemPrompt,
  renderProductQaSystemPrompt,
} from './prompts/product-qa.prompt.js';

/** Evidence chunks kept for the prompt (product + general, deduplicated). */
export const ADVISOR_TOP_N = 8;
/** Oversampling of the unfiltered search before keeping product-less hits. */
export const ADVISOR_GENERAL_TOP_N = 30;

type AdvisorProductRow = Prisma.ProductGetPayload<{ include: { prices: true } }>;

/**
 * Product-QA advisor (see ADR 0025): answers questions about ONE product
 * using only retrieved evidence, with citations and abstention.
 *
 * Flow: ACTIVE product check → owned-session check when `sessionId` is set
 * (cross-user ids 404 before any retrieval or LLM cost) → hybrid retrieval
 * (product-scoped + general product-less chunks, merged) → abstain below
 * `ADVISOR_ABSTAIN_MIN_SCORE` WITHOUT calling the LLM (recording
 * `unanswered_queries` with the session id) → prompt with numbered chunks +
 * SQL-hydrated PRODUCT FACTS → `LlmProvider.generate` → invented `[n]`
 * citations discarded → USER + ASSISTANT turns appended to the session.
 * Price, stock, specs and warranty never come from the LLM; no personal data
 * is ever sent to it, and the full prompt is never logged.
 */
@Injectable()
export class AdvisorService {
  private readonly logger = new Logger(AdvisorService.name);
  private readonly systemTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: RetrievalService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly inventory: InventoryService,
    private readonly chatSessions: ChatSessionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // Fail fast at boot when the versioned prompt is missing.
    this.systemTemplate = loadProductQaSystemPrompt();
  }

  /**
   * Answers one product question, optionally recording the turn in an owned
   * chat session (see ADR 0030). `owner` identifies the caller (user or guest
   * `sid`) exactly like the sessions endpoints do.
   */
  async answerProductQuestion(
    input: ProductQaInput,
    owner: ChatSessionOwner,
  ): Promise<ProductQaResponseDto> {
    const product = await this.findActiveProduct(input.productId);
    if (input.sessionId !== undefined) {
      await this.chatSessions.assertSessionOwned(input.sessionId, owner);
    }
    const locale = resolveLocale(
      input.locale,
      this.config.SUPPORTED_LOCALES,
      this.config.DEFAULT_LOCALE,
    );

    const hits = await this.retrieveEvidence(input.question, input.productId, locale);
    const best = hits.length > 0 ? (hits[0]?.score ?? 0) : 0;
    if (hits.length === 0 || best < this.config.ADVISOR_ABSTAIN_MIN_SCORE) {
      const reason = hits.length === 0 ? 'no_evidence' : 'below_threshold';
      await this.prisma.unansweredQuery.create({
        data: {
          query: input.question,
          productId: product.id,
          sessionId: input.sessionId ?? null,
          reason,
        },
      });
      await this.recordUserTurn(input.sessionId, owner, input.question);
      // Never log the question text: it may contain personal data.
      this.logger.debug(
        `advisor product-qa: abstained reason=${reason} hits=${String(hits.length)}`,
      );
      return { answer: abstentionMessage(locale), citations: [], abstained: true };
    }

    const available = await this.inventory.getAvailable(product.id);
    const availability = toAvailability(available);
    const userMessage = buildProductQaUserMessage({
      question: input.question,
      facts: {
        name: product.name,
        priceAmount: product.priceAmount,
        currency: product.currency,
        priceOverrides: product.prices.map((row) => ({
          currency: row.currency,
          amount: row.amount,
        })),
        inStock: availability.inStock,
        availableQuantity: availability.availableQuantity,
        specs: (product.specs ?? {}) as Record<string, unknown>,
      },
      hits,
    });

    const result = await this.generateAnswer(userMessage, locale);

    const citations = buildCitations(result.text, hits);

    await this.recordUserTurn(input.sessionId, owner, input.question);
    if (input.sessionId !== undefined) {
      // Product cards stay empty here: Fase 4 fills them with SQL-hydrated
      // recommendations, while product-QA cites document evidence only.
      await this.chatSessions.addMessage(input.sessionId, owner, {
        role: 'ASSISTANT',
        content: result.text,
        citations,
        products: [],
      });
    }

    // Metadata only: never the prompt, the question or the answer.
    this.logger.debug(
      `advisor product-qa: answered hits=${String(hits.length)} citations=${String(citations.length)} abstained=false provider=${this.llm.providerName} latencyMs=${String(result.latencyMs)}`,
    );
    return { answer: result.text, citations, abstained: false };
  }

  /**
   * Appends the user question to the session when the caller passed one.
   * History limits (`ADVISOR_SESSION_MAX_MESSAGES`, `ADVISOR_MESSAGE_MAX_LENGTH`)
   * apply here exactly like `POST /sessions/:id/messages`: a full session
   * rejects the QA call with a 400 so the UI can rotate the session instead
   * of silently dropping history.
   */
  private async recordUserTurn(
    sessionId: string | undefined,
    owner: ChatSessionOwner,
    question: string,
  ): Promise<void> {
    if (sessionId === undefined) {
      return;
    }
    await this.chatSessions.addMessage(sessionId, owner, { role: 'USER', content: question });
  }

  /**
   * Records a thumbs up/down vote on a product-QA answer (Fase 3, P3.3
   * stub). Append-only INSERT into `advisor_feedback` for later review —
   * no aggregation, no auth, no LLM involved. Only metadata reaches the
   * logs: `query`/`answer` may contain user text and are never logged.
   */
  async recordFeedback(input: FeedbackInput): Promise<AdvisorFeedbackResponseDto> {
    await this.prisma.advisorFeedback.create({
      data: {
        productId: input.productId ?? null,
        query: input.question,
        answer: input.answer,
        abstained: input.abstained,
        value: input.value,
        sessionId: input.sessionId ?? null,
      },
    });
    this.logger.debug(
      `advisor feedback: recorded value=${input.value} abstained=${String(input.abstained)}`,
    );
    return { ok: true };
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
        system: renderProductQaSystemPrompt(this.systemTemplate, locale),
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (error) {
      if (error instanceof AiRateLimitError) {
        this.logger.warn(`advisor product-qa: provider rate limited provider=${error.provider}`);
        throw new HttpException(
          { message: 'Advisor provider rate limited, try again later' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof AiProviderError) {
        this.logger.warn(
          `advisor product-qa: provider failed code=${error.code} provider=${error.provider}`,
        );
        throw new ServiceUnavailableException({
          message: 'Advisor provider unavailable, try again later',
        });
      }
      throw error;
    }
  }

  /**
   * ACTIVE products only. DRAFT/ARCHIVED/unknown ids 404 identically so the
   * endpoint never reveals non-active products. Throws before any retrieval
   * or LLM call.
   */
  private async findActiveProduct(productId: string): Promise<AdvisorProductRow> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, status: 'ACTIVE' },
      include: { prices: true },
    });
    if (!product) {
      throw new NotFoundException({ message: 'Product not found' });
    }
    return product;
  }

  /**
   * Product evidence (hard `productId` filter) plus general evidence: the
   * unfiltered search restricted afterwards to product-less chunks (category
   * documents and general policies). Merged, deduplicated by chunk id,
   * best score first, cut at `ADVISOR_TOP_N`.
   */
  private async retrieveEvidence(
    query: string,
    productId: string,
    locale: string,
  ): Promise<RetrievalHit[]> {
    const [productHits, generalHits] = await Promise.all([
      this.retrieval.search({ query, filters: { productId }, locale, topN: ADVISOR_TOP_N }),
      this.retrieval.search({ query, locale, topN: ADVISOR_GENERAL_TOP_N }),
    ]);
    return mergeEvidence(productHits, generalHits, ADVISOR_TOP_N);
  }
}

/**
 * Merges product-scoped hits with the product-less subset of the general
 * search (category/policy documents). Product hits win ties on chunk id.
 * Pure helper, unit-tested in isolation.
 */
export function mergeEvidence(
  productHits: RetrievalHit[],
  generalHits: RetrievalHit[],
  topN: number = ADVISOR_TOP_N,
): RetrievalHit[] {
  const byId = new Map<string, RetrievalHit>();
  for (const hit of generalHits) {
    if (hit.productId === null) {
      byId.set(hit.chunkId, hit);
    }
  }
  for (const hit of productHits) {
    byId.set(hit.chunkId, hit);
  }
  return [...byId.values()].sort((left, right) => right.score - left.score).slice(0, topN);
}

/**
 * Localized abstention message (backend-side, no LLM involved). Spanish for
 * `es*` locales, English otherwise — matching the two UI languages.
 */
export function abstentionMessage(locale: string): string {
  if (locale.toLowerCase().startsWith('es')) {
    return 'No tengo esa información en este momento. Puedes contactar con soporte para más ayuda.';
  }
  return "I don't have that information right now. You can contact support for further help.";
}
