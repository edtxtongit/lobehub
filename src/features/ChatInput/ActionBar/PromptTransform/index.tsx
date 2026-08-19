'use client';

import { memo, useCallback } from 'react';

import PromptTransformAction from '@/features/PromptTransform/PromptTransformAction';

import { useChatInputStore, useStoreApi } from '../../store';
import { ChatInputAction } from '../components/ChatInputAction';

const PromptTransform = memo(() => {
  const editor = useChatInputStore((s) => s.editor);
  const hasPrompt = useChatInputStore((s) => Boolean(s.markdownContent.trim()));
  const storeApi = useStoreApi();
  const getPrompt = useCallback(() => storeApi.getState().markdownContent, [storeApi]);

  const onPromptChange = useCallback(
    (prompt: string) => {
      if (!editor) return;
      // `keepHistory` prevents setDocument from wiping the undo/redo stacks.
      editor.setDocument('markdown', prompt, { keepHistory: true });
    },
    [editor],
  );

  // Image mode expands vague inputs; text mode forbids expansion.
  return (
    <PromptTransformAction
      ActionComponent={ChatInputAction}
      getPrompt={getPrompt}
      hasPrompt={hasPrompt}
      mode={'image'}
      onPromptChange={onPromptChange}
    />
  );
});

PromptTransform.displayName = 'PromptTransform';

export default PromptTransform;
