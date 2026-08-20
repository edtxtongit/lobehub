import { createStaticStyles, keyframes } from 'antd-style';

/**
 * Inspector text style — ellipsis + secondary color + flex align
 */
export const inspectorTextStyles = createStaticStyles(({ css, cssVar }) => ({
  root: css`
    overflow: hidden;
    display: flex;
    align-items: center;

    min-width: 0;

    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

/**
 * Highlight underline effect using gradient background
 */
export const highlightTextStyles = createStaticStyles(({ css, cssVar }) => {
  const highlightBase = (highlightColor: string) => css`
    overflow: hidden;

    min-width: 0;
    margin-inline-start: 4px;
    padding-block-end: 1px;

    color: ${cssVar.colorText};
    text-overflow: ellipsis;

    background: linear-gradient(to top, ${highlightColor} 40%, transparent 40%);
  `;

  return {
    gold: highlightBase(cssVar.gold4),
    info: highlightBase(cssVar.colorInfoBg),
    primary: highlightBase(cssVar.colorPrimaryBgHover),
    warning: highlightBase(cssVar.colorWarningBg),
  };
});

// Keep the loading cue compositor-only. background-position on clipped text is
// not compositable and otherwise repaints the chat viewport on every frame.
const shine = keyframes`
  0%, 100% {
    opacity: 0.5;
  }

  50% {
    opacity: 1;
  }
`;

/**
 * Shiny loading text animation
 */
export const shinyTextStyles = createStaticStyles(({ css, cssVar }) => ({
  shinyText: css`
    color: color-mix(in srgb, ${cssVar.colorText} 45%, transparent);

    background: linear-gradient(
      120deg,
      color-mix(in srgb, ${cssVar.colorTextBase} 0%, transparent) 40%,
      ${cssVar.colorTextSecondary} 50%,
      color-mix(in srgb, ${cssVar.colorTextBase} 0%, transparent) 60%
    );
    background-clip: text;
    background-position: 50%;
    background-size: 200% 100%;

    will-change: opacity;
    animation: ${shine} 1.5s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
      opacity: 1;
      animation: none;
    }
  `,
}));
