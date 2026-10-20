import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CurrentUser, type RequestUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { OptionalJwtAuthGuard } from '../cart/optional-jwt-auth.guard.js';
import { AiEnabledGuard } from './ai-enabled.guard.js';
import {
  chatMessageBodySchema,
  chatSessionParamsSchema,
  type ChatSessionParams,
} from './chat-sessions.schemas.js';
import { ChatSessionsService, type ChatSessionOwner } from './chat-sessions.service.js';
import { recommendBodySchema, type RecommendInput } from './recommend/recommend.schemas.js';
import { RecommendService, type RecommendResponse } from './recommend/recommendation.service.js';
import { resolveSessionOwner } from './session-owner.js';
import {
  ChatMessageResponseDto,
  ChatSessionHistoryResponseDto,
  ChatSessionResponseDto,
  ChatSessionsCleanupResponseDto,
  CreateChatMessageRequestDto,
} from './dto/chat-sessions.dto.js';
import { RecommendRequestDto, RecommendResponseDto } from './dto/recommend.dto.js';

@ApiTags('advisor')
@Controller('advisor/sessions')
@UseGuards(ThrottlerGuard, OptionalJwtAuthGuard)
@SkipThrottle({ auth: true, search: true })
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'Rate limit exceeded.' })
export class ChatSessionsController {
  constructor(
    private readonly sessions: ChatSessionsService,
    private readonly recommendService: RecommendService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @UseGuards(AiEnabledGuard)
  @ApiOperation({ summary: 'Create a chat session (authenticated user, or anonymous guest)' })
  @ApiOkResponse({ type: ChatSessionResponseDto })
  createSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChatSessionResponseDto> {
    const owner = this.resolveOwner(req, res);
    return this.sessions.createSession(owner);
  }

  @Get()
  @UseGuards(JwtAuthGuard, AiEnabledGuard)
  @ApiOperation({ summary: "List the caller's own chat sessions (newest first)" })
  @ApiOkResponse({ type: [ChatSessionResponseDto] })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  listSessions(@CurrentUser() user: RequestUser): Promise<ChatSessionResponseDto[]> {
    return this.sessions.listUserSessions(user.id);
  }

  @Get(':id')
  @UseGuards(AiEnabledGuard)
  @ApiOperation({ summary: 'Read one owned session with its message history' })
  @ApiOkResponse({ type: ChatSessionHistoryResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Unknown session (or owned by another user).',
  })
  getSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param(new ZodValidationPipe(chatSessionParamsSchema)) params: ChatSessionParams,
  ): Promise<ChatSessionHistoryResponseDto> {
    const owner = this.resolveOwner(req, res);
    return this.sessions.getSessionHistory(params.id, owner);
  }

  @Delete(':id')
  @UseGuards(AiEnabledGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Permanently delete one owned session with its messages' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Unknown session (or owned by another user).',
  })
  deleteSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param(new ZodValidationPipe(chatSessionParamsSchema)) params: ChatSessionParams,
  ): Promise<void> {
    const owner = this.resolveOwner(req, res);
    return this.sessions.deleteSession(params.id, owner);
  }

  @Post(':id/messages')
  @UseGuards(AiEnabledGuard)
  @ApiOperation({
    summary:
      'Append one message (legacy role+content, 201) or run the buying advisor (content only: 200 JSON, or SSE with Accept: text/event-stream)',
  })
  @ApiBody({ type: CreateChatMessageRequestDto })
  @ApiBody({ type: RecommendRequestDto })
  @ApiOkResponse({ type: ChatMessageResponseDto })
  @ApiOkResponse({ type: RecommendResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Unknown session (or owned by another user).',
  })
  async postSessionMessage(
    @Req() req: Request,
    @Res() res: Response,
    @Param(new ZodValidationPipe(chatSessionParamsSchema)) params: ChatSessionParams,
    @Body() rawBody: unknown,
  ): Promise<void> {
    const owner = this.resolveOwner(req, res);
    if (isRecordWithRole(rawBody)) {
      const parsed = chatMessageBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        throw toBadRequest(parsed.error.issues);
      }
      const created = await this.sessions.addMessage(params.id, owner, parsed.data);
      res.status(HttpStatus.CREATED).json(created);
      return;
    }
    const parsed = recommendBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw toBadRequest(parsed.error.issues);
    }
    if (wantsServerSentEvents(req)) {
      await this.streamRecommendation(params.id, owner, parsed.data, res);
      return;
    }
    const answer = await this.recommendService.recommend(params.id, owner, parsed.data);
    res.status(HttpStatus.OK).json(answer);
  }

  /**
   * SSE delivery of an already-validated recommendation (see ADR 0032): the
   * full flow runs first (single LLM call, post-validation, SQL hydration),
   * then the validated text is replayed as `event: delta` chunks, followed
   * by `event: products` with the validated cards and `event: done`.
   */
  private async streamRecommendation(
    sessionId: string,
    owner: ChatSessionOwner,
    input: RecommendInput,
    res: Response,
  ): Promise<void> {
    const answer: RecommendResponse = await this.recommendService.recommend(
      sessionId,
      owner,
      input,
    );
    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const chunk of splitIntoDeltas(answer.message)) {
      res.write(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
    }
    res.write(`event: products\ndata: ${JSON.stringify({ products: answer.products })}\n\n`);
    if (answer.clarifyingQuestion !== undefined) {
      res.write(
        `event: clarifyingQuestion\ndata: ${JSON.stringify({ clarifyingQuestion: answer.clarifyingQuestion })}\n\n`,
      );
    }
    res.write('event: done\ndata: {}\n\n');
    res.end();
  }

  @Post('cleanup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Purge anonymous sessions past the retention window (admin job trigger)',
  })
  @ApiOkResponse({ type: ChatSessionsCleanupResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  cleanupSessions(): Promise<ChatSessionsCleanupResponseDto> {
    return this.sessions.cleanupExpiredAnonymousSessions();
  }

  private resolveOwner(req: Request, res: Response): ChatSessionOwner {
    return resolveSessionOwner(req, res, this.config.JWT_SECRET);
  }
}

/** Legacy shape carries `role`; the recommendation shape carries only `content`. */
function isRecordWithRole(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'role' in value;
}

function toBadRequest(
  issues: readonly { path: PropertyKey[]; message: string }[],
): BadRequestException {
  const details = issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
  return new BadRequestException({ message: details.join('; '), details });
}

/** SSE is requested explicitly via `Accept: text/event-stream`. */
function wantsServerSentEvents(req: Request): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('text/event-stream');
}

/** Splits validated text into word-sized SSE deltas (never empty). Pure. */
export function splitIntoDeltas(text: string): string[] {
  const words = text.split(/(\s+)/).filter((part) => part.length > 0);
  return words.length > 0 ? words : [text];
}
