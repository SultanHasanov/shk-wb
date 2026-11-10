import k from './kit.module.css';

export interface StatusDotProps {
  tone: 'ok' | 'warning' | 'error' | 'muted' | 'accent';
  label: string;
  pulse?: boolean;
}

const TONE = {
  ok: k.toneOk,
  warning: k.toneWarning,
  error: k.toneError,
  muted: k.toneMuted,
  accent: k.toneAccent,
} as const;

/** Точка состояния с подписью. Цвет подсказывает, но смысл всегда несёт текст. */
export function StatusDot({ tone, label, pulse = false }: StatusDotProps) {
  return (
    <span className={`${k.status} ${TONE[tone]} ${pulse ? k.pulse : ''}`} data-tone={tone}>
      <span className={k.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
