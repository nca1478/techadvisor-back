import {
  Body,
  Controller,
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
import { getOptionalUser, OptionalJwtAuthGuard } from '../cart/optional-jwt-auth.guard.js';
import { newSignedSid, readGuestSessionId, setGuestSessionCookie } from '../cart/guest-session.js';
import {
  chatMessageBodySchema,
  chatSessionParamsSchema,
  type ChatMessageInput,
  type ChatSessionParams,
} from './chat-sessions.schemas.js';
import { ChatSessionsService, type ChatSessionOwner } from './chat-sessions.service.js';
import {
  ChatMessageResponseDto,
  ChatSessionHistoryResponseDto,
  ChatSessionResponseDto,
  ChatSessionsCleanupResponseDto,
  CreateChatMessageRequestDto,
} from './dto/chat-sessions.dto.js';

/**
 * Chat-session history (see ADR 0029).
 *
 * Sessions belong either to the Bearer-authenticated user or to the anonymous
 * guest identified by the signed httpOnly `sid` cookie (same scheme as carts,
 * ADR 0010; a fresh cookie is issued on first use). Every session-scoped
 * route re-checks ownership in the service: unknown ids and ids owned by
 * another user 404 identically, so a session is never accessible by another
 * user. `GET /` lists only the caller's own authenticated sessions;
 * anonymous history is reachable solely through its own cookie.
 */
@ApiTags('advisor')
@Controller('advisor/sessions')
@UseGuards(ThrottlerGuard, OptionalJwtAuthGuard)
@SkipThrottle({ auth: true, search: true })
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'Rate limit exceeded.' })
export class ChatSessionsController {
  constructor(
    private readonly sessions: ChatSessionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
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
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "List the caller's own chat sessions (newest first)" })
  @ApiOkResponse({ type: [ChatSessionResponseDto] })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  listSessions(@CurrentUser() user: RequestUser): Promise<ChatSessionResponseDto[]> {
    return this.sessions.listUserSessions(user.id);
  }

  @Get(':id')
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

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append one message to an owned session (bounded history)' })
  @ApiBody({ type: CreateChatMessageRequestDto })
  @ApiOkResponse({ type: ChatMessageResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Unknown session (or owned by another user).',
  })
  addMessage(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param(new ZodValidationPipe(chatSessionParamsSchema)) params: ChatSessionParams,
    @Body(new ZodValidationPipe(chatMessageBodySchema)) body: ChatMessageInput,
  ): Promise<ChatMessageResponseDto> {
    const owner = this.resolveOwner(req, res);
    return this.sessions.addMessage(params.id, owner, body);
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

  /**
   * Authenticated requests resolve to the user; anonymous ones to the guest
   * session, issuing a fresh signed `sid` cookie when needed (same as carts).
   */
  private resolveOwner(req: Request, res: Response): ChatSessionOwner {
    const user = getOptionalUser(req as unknown as Record<string, unknown>);
    if (user !== null) {
      return { kind: 'user', userId: user.id };
    }
    const sessionId = readGuestSessionId(req, this.config.JWT_SECRET);
    if (sessionId !== null) {
      return { kind: 'guest', anonSessionId: sessionId };
    }
    const fresh = newSignedSid(this.config.JWT_SECRET);
    setGuestSessionCookie(res, fresh.signed);
    return { kind: 'guest', anonSessionId: fresh.sessionId };
  }
}
