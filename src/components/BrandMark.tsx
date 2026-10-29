/** Знак «ШК ВБ» из утверждённого прототипа: малиновый квадрат со стилизованной W. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="8" fill="#cb11ab" />
      <path d="M7 9h3l1.4 6L13 9h2l1.6 6L18 9h3l-2.6 10h-3l-1.4-5.6L12.6 19h-3z" fill="#fff" />
    </svg>
  );
}
