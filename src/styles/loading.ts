import { createStaticStyles, css, keyframes } from 'antd-style';

export const dotLoading = css`
  &::after {
    content: '\\2026'; /* ascii code for the ellipsis character */

    overflow: hidden;
    display: inline-block;

    width: 0;

    vertical-align: bottom;

    animation: ellipsis steps(4, end) 900ms infinite;
  }

  @keyframes ellipsis {
    to {
      width: 1.25em;
    }
  }

  @keyframes ellipsis {
    to {
      width: 1.25em;
    }
  }
`;

// Animate only opacity so loading feedback stays on the compositor. Animating
// background-position on background-clipped text repaints every frame and keeps
// the whole conversation rendering pipeline active for the duration of a run.
const shine = keyframes`
  0%, 100% {
    opacity: 0.5;
  }

  50% {
    opacity: 1;
  }
`;

export const elapsedTimeStyles = createStaticStyles(({ css, cssVar }) => ({
  elapsedTime: css`
    color: ${cssVar.colorTextTertiary};
  `,
}));

export const shinyTextStyles = createStaticStyles(({ css, cssVar }) => ({
  errorText: css`
    color: ${cssVar.colorError};
  `,
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
