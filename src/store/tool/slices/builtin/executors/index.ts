/**
 * Builtin Tool Executor Registry
 *
 * Lightweight registry shell for builtin tool executors. Executor
 * implementations live behind one asynchronous catalog boundary so importing
 * the store does not pull every tool runtime into the initial SPA graph.
 */

import type { BuiltinToolContext, BuiltinToolResult, IBuiltinToolExecutor } from '../types';
import { stashBuiltinToolWorkIntent } from './workRegistration';

/**
 * Registry structure: Map<identifier, executor instance>
 */
const executorRegistry = new Map<string, IBuiltinToolExecutor>();
let executorsRegistered = false;
let registrationPromise: Promise<void> | undefined;

/**
 * Get a builtin tool executor by identifier
 *
 * @param identifier - The tool identifier
 * @returns The executor instance or undefined if not found
 */
export const getExecutor = (identifier: string): IBuiltinToolExecutor | undefined => {
  return executorRegistry.get(identifier);
};

/**
 * Check if an executor exists for the given identifier and apiName
 *
 * @param identifier - The tool identifier
 * @param apiName - The API name
 * @returns Whether the executor exists and supports the API
 */
export const hasExecutor = async (identifier: string, apiName: string): Promise<boolean> => {
  const executor = await getOrLoadExecutor(identifier);
  return executor?.hasApi(apiName) ?? false;
};

/**
 * Get all registered identifiers
 *
 * @returns Array of registered identifiers
 */
export const getRegisteredIdentifiers = (): string[] => {
  return Array.from(executorRegistry.keys());
};

/**
 * Get all API names for a given identifier
 *
 * @param identifier - The tool identifier
 * @returns Array of API names or empty array if identifier not found
 */
export const getApiNamesForIdentifier = (identifier: string): string[] => {
  const executor = executorRegistry.get(identifier);
  return executor?.getApiNames() ?? [];
};

/**
 * Invoke a builtin tool executor
 *
 * @param identifier - The tool identifier
 * @param apiName - The API name
 * @param params - The parameters
 * @param ctx - The execution context
 * @returns The execution result
 */
export const invokeExecutor = async (
  identifier: string,
  apiName: string,
  params: any,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> => {
  const executor = await getOrLoadExecutor(identifier);

  if (!executor) {
    return {
      error: {
        message: `Executor not found: ${identifier}`,
        type: 'ExecutorNotFound',
      },
      success: false,
    };
  }

  if (!executor.hasApi(apiName)) {
    return {
      error: {
        message: `API not found: ${identifier}/${apiName}`,
        type: 'ApiNotFound',
      },
      success: false,
    };
  }

  const result = await executor.invoke(apiName, params, ctx);

  // Manifest-driven Work registration (best-effort; a no-op unless the API
  // declares a `work` config). Only STASH the intent here — `call_tool` drains
  // it and writes the Work version once the tool call's cumulative cost is known
  // (write-once instead of register-then-backfill).
  stashBuiltinToolWorkIntent(identifier, apiName, params, ctx, result);

  return result;
};

/**
 * Register builtin tool executor instances
 *
 * @param executors - Array of executor instances to register
 */
const registerExecutors = (executors: IBuiltinToolExecutor[]): void => {
  for (const executor of executors) {
    executorRegistry.set(executor.identifier, executor);
  }
};

type ExecutorLoader = () => Promise<IBuiltinToolExecutor>;

// High-frequency browser executors can be split out safely one identifier at a
// time. Unknown/unlisted identifiers retain the complete catalog fallback, so
// adding this fast path cannot make an existing executor unavailable.
const targetedExecutorLoaders: Record<string, ExecutorLoader> = {
  'lobe-web-onboarding': () =>
    import('./lobe-web-onboarding').then(({ webOnboardingExecutor }) => webOnboardingExecutor),
};
const targetedExecutorPromises = new Map<string, Promise<IBuiltinToolExecutor>>();

/** Load one split executor, falling back to the legacy complete catalog. */
export const getOrLoadExecutor = async (
  identifier: string,
): Promise<IBuiltinToolExecutor | undefined> => {
  const registered = executorRegistry.get(identifier);
  if (registered) return registered;

  const loader = targetedExecutorLoaders[identifier];
  if (loader) {
    let promise = targetedExecutorPromises.get(identifier);
    if (!promise) {
      promise = loader();
      targetedExecutorPromises.set(identifier, promise);
    }
    try {
      const executor = await promise;
      executorRegistry.set(executor.identifier, executor);
      return executor.identifier === identifier ? executor : executorRegistry.get(identifier);
    } catch (error) {
      targetedExecutorPromises.delete(identifier);
      throw error;
    }
  }

  await registerBuiltinToolExecutors();
  return executorRegistry.get(identifier);
};

export const registerBuiltinToolExecutors = async (): Promise<void> => {
  if (executorsRegistered) return;

  registrationPromise ??= import('./catalog').then(({ builtinToolExecutors }) => {
    registerExecutors(builtinToolExecutors);
    executorsRegistered = true;
  });

  try {
    await registrationPromise;
  } catch (error) {
    registrationPromise = undefined;
    throw error;
  }
};
