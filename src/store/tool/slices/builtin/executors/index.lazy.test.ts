import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  catalogEvaluated: vi.fn(),
  onboardingEvaluated: vi.fn(),
}));

vi.mock('./catalog', () => {
  mocks.catalogEvaluated();
  return { builtinToolExecutors: [] };
});

vi.mock('./lobe-web-onboarding', () => {
  mocks.onboardingEvaluated();
  return {
    webOnboardingExecutor: {
      getApiNames: () => [],
      hasApi: () => true,
      identifier: 'lobe-web-onboarding',
      invoke: vi.fn(),
    },
  };
});

describe('builtin executor catalog loading', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.catalogEvaluated.mockClear();
    mocks.onboardingEvaluated.mockClear();
  });

  it('loads the onboarding executor without evaluating the complete catalog', async () => {
    const { getOrLoadExecutor } = await import('./index');

    await expect(getOrLoadExecutor('lobe-web-onboarding')).resolves.toMatchObject({
      identifier: 'lobe-web-onboarding',
    });
    expect(mocks.onboardingEvaluated).toHaveBeenCalledTimes(1);
    expect(mocks.catalogEvaluated).not.toHaveBeenCalled();
  });

  it('keeps executor implementations out of the registry shell import', async () => {
    const { registerBuiltinToolExecutors } = await import('./index');

    expect(mocks.catalogEvaluated).not.toHaveBeenCalled();

    await registerBuiltinToolExecutors();

    expect(mocks.catalogEvaluated).toHaveBeenCalledTimes(1);
  });
});
