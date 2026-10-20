import { ForbiddenException } from '@nestjs/common';
import { AiEnabledGuard } from './ai-enabled.guard.js';

function buildGuard(aiEnabled: boolean): AiEnabledGuard {
  return new AiEnabledGuard({ AI_ENABLED: aiEnabled } as never);
}

describe('AiEnabledGuard', () => {
  it('allows the request when AI_ENABLED is true', () => {
    expect(buildGuard(true).canActivate()).toBe(true);
  });

  it('throws 403 when AI_ENABLED is false', () => {
    expect(() => buildGuard(false).canActivate()).toThrow(ForbiddenException);
  });
});
