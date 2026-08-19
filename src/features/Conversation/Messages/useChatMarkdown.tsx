'use client';

import { type MarkdownProps } from '@lobehub/ui';
import { type ReactNode, useMemo, useState } from 'react';

import { HtmlPreviewDrawer } from '@/components/HtmlPreview';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/selectors';

import { type MarkdownElement, markdownElements } from '../Markdown/plugins';

// Honor each plugin's declared `scope`: this hook renders assistant / grouped
// messages, so user-only constructs (skill, tool, action, mention, …) must not
// be parsed here — otherwise a `<skill … />` the model happens to echo back
// would render as an interactive chip. Mirrors the `scope !== 'assistant'`
// filter on the user-message hook.
const assistantMarkdownElements = markdownElements.filter((s) => s.scope !== 'user');

const rehypePlugins = assistantMarkdownElements
  .map((element: MarkdownElement) => element.rehypePlugin)
  .filter(Boolean);
const remarkPlugins = assistantMarkdownElements
  .map((element: MarkdownElement) => element.remarkPlugin)
  .filter(Boolean);

interface UseChatMarkdownOptions {
  citations?: MarkdownProps['citations'];
  enableStream?: boolean;
  id: string;
  isGenerating: boolean;
}

export const useChatMarkdown = ({
  id,
  isGenerating,
  citations,
  enableStream = true,
}: UseChatMarkdownOptions): {
  drawer: ReactNode;
  markdownProps: Partial<MarkdownProps>;
} => {
  const { transitionMode } = useUserStore(userGeneralSettingsSelectors.config);
  const animated = enableStream && transitionMode === 'fadeIn' && isGenerating;

  const [drawerContent, setDrawerContent] = useState<string | null>(null);

  const components = useMemo(
    () =>
      Object.fromEntries(
        markdownElements.map((element: MarkdownElement) => {
          const Component = element.Component;
          return [element.tag, (props: any) => <Component {...props} id={id} />];
        }),
      ),
    [id],
  );

  const markdownProps = useMemo(
    () =>
      ({
        animated,
        citations,
        componentProps: {
          html: {
            onExpand: (content: string) => setDrawerContent(content),
          },
        },
        components,
        enableCustomFootnotes: true,
        enableHtmlPreview: true,
        enableStream,
        rehypePlugins,
        remarkPlugins,
        // PERF: default 'char' wraps EVERY character in its own animated span
        // (opacity fade) — a long reply creates tens of thousands of
        // concurrently-managed CSS animations, which is the dominant GPU /
        // compositor load during streaming. 'word' cuts the animated node
        // count ~5x (lobe-ui's own recommendation) and uses Intl.Segmenter so
        // CJK text still fades in word-by-word instead of as one giant block.
        streamAnimationGranularity: 'word',
        showFootnotes: !citations?.length || citations.every((item) => item.title !== item.url),
      }) satisfies Partial<MarkdownProps>,
    [animated, citations, components, enableStream],
  );

  const drawer = useMemo(
    () =>
      drawerContent ? (
        <HtmlPreviewDrawer
          content={drawerContent}
          open={!!drawerContent}
          onClose={() => setDrawerContent(null)}
        />
      ) : null,
    [drawerContent],
  );

  return useMemo(() => ({ drawer, markdownProps }), [drawer, markdownProps]);
};
