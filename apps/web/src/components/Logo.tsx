/** blh 品牌标识：圆角方块 + 抽象「b」形，颜色跟随 currentColor。 */
export function BlhLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="currentColor" />
      <path d="M8 7.25h2.9a2.5 2.5 0 0 1 0 5H8v-5Zm0 5h4.1a2.5 2.5 0 0 1 0 5H8v-5Z" fill="#ffffff" />
    </svg>
  );
}
