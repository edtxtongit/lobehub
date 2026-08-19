'use client';

import { memo, useEffect } from 'react';

import {
  dataSelectors,
  messageStateSelectors,
  useConversationStore,
  virtuaListSelectors,
} from '../../../store';

/**
 * AutoScroll component - handles auto-scrolling logic during AI generation.
 * Should be placed inside the last item of VList so it only triggers when visible.
 *
 * This component has no visual output - it only contains the auto-scroll logic.
 * Debug UI and BackBottom button are rendered separately outside VList.
 */
const AutoScroll = memo(() => {
  const atBottom = useConversationStore(virtuaListSelectors.atBottom);
  const isScrolling = useConversationStore(virtuaListSelectors.isScrolling);
  const isGenerating = useConversationStore(messageStateSelectors.isAIGenerating);
  const scrollToBottom = useConversationStore((s) => s.scrollToBottom);

  // PERF: subscribing to the whole `dbMessages` array re-rendered this
  // component on EVERY streaming store write (the array identity changes per
  // token batch). Primitive selectors (numbers) re-render only when the value
  // actually changes — which is all the effect below depends on.
  const lastMessageContentLength = useConversationStore((s) => {
    const last = dataSelectors.dbMessages(s).at(-1);
    return typeof last?.content === 'string' ? last.content.length : 0;
  });
  const messageCount = useConversationStore((s) => dataSelectors.dbMessages(s).length);

  const shouldAutoScroll = atBottom && isGenerating && !isScrolling;

  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom(false);
    }
  }, [shouldAutoScroll, scrollToBottom, messageCount, lastMessageContentLength]);

  // No visual output - this component only handles auto-scroll logic
  return null;
});

AutoScroll.displayName = 'ConversationAutoScroll';

export default AutoScroll;
