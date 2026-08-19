import { chainRewriteGenerationPrompt, chainTranslate } from '@lobechat/prompts';
import { useCallback, useState } from 'react';

import { chatService } from '@/services/chat';
import { useUserStore } from '@/store/user';
import { systemAgentSelectors } from '@/store/user/selectors';
import { merge } from '@/utils/merge';

interface UsePromptTransformParams {
  getPrompt?: () => string | null | undefined;
  hasPrompt?: boolean;
  mode: 'image' | 'video' | 'text';
  onPromptChange: (prompt: string) => void;
  prompt?: string | null;
}

type PromptTransformAction = 'rewrite' | 'translate';

export const usePromptTransform = ({
  getPrompt,
  hasPrompt,
  mode,
  prompt,
  onPromptChange,
}: UsePromptTransformParams) => {
  const [isTransforming, setIsTransforming] = useState(false);
  const [transformAction, setTransformAction] = useState<PromptTransformAction>('rewrite');

  const rewriteConfig = useUserStore(systemAgentSelectors.promptRewrite);
  const translateConfig = useUserStore(systemAgentSelectors.translation);
  const isRewriteActionEnabled = rewriteConfig?.enabled ?? false;

  const getConfigByAction = useCallback(
    (action: PromptTransformAction) => {
      // Strip config-only fields (enabled, customPrompt); strict upstreams reject unknown OpenAI params.
      const config = action === 'rewrite' ? rewriteConfig : translateConfig;
      if (!config) return {};
      return { model: config.model, provider: config.provider };
    },
    [rewriteConfig, translateConfig],
  );

  const runTransform = useCallback(
    async (action: PromptTransformAction) => {
      const currentPrompt = getPrompt?.() ?? prompt;
      if (isTransforming || !currentPrompt?.trim()) return;
      if (action === 'rewrite' && !isRewriteActionEnabled) return;

      let transformedPrompt = '';
      setTransformAction(action);

      try {
        await chatService.fetchPresetTaskResult({
          onError: () => {
            setIsTransforming(false);
          },
          onFinish: async (text) => {
            const nextPrompt = text.trim() || transformedPrompt.trim();
            if (nextPrompt) onPromptChange(nextPrompt);
          },
          onLoadingChange: setIsTransforming,
          onMessageHandle: (chunk) => {
            if (chunk.type === 'text') transformedPrompt += chunk.text;
          },
          params: merge(
            getConfigByAction(action),
            action === 'rewrite'
              ? chainRewriteGenerationPrompt({
                  mode,
                  prompt: currentPrompt,
                })
              : chainTranslate(currentPrompt, 'English'),
          ),
        });
      } finally {
        setIsTransforming(false);
        setTransformAction('rewrite');
      }
    },
    [
      getConfigByAction,
      getPrompt,
      isRewriteActionEnabled,
      isTransforming,
      mode,
      onPromptChange,
      prompt,
    ],
  );

  const rewritePrompt = useCallback(async () => {
    await runTransform('rewrite');
  }, [runTransform]);

  const translatePrompt = useCallback(async () => {
    await runTransform('translate');
  }, [runTransform]);

  return {
    isRewriteEnabled: isRewriteActionEnabled,
    isTransformDisabled: !(hasPrompt ?? Boolean(prompt?.trim())),
    isTransforming,
    rewritePrompt,
    transformAction,
    translatePrompt,
  };
};
