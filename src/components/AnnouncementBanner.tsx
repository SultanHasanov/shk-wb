import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Megaphone, X } from 'lucide-react';
import s from './AnnouncementBanner.module.css';

type Announcement = {
  id: number;
  text: string;
  url: string | null;
  button: string | null;
};

const DISMISS_KEY = 'announcement-dismissed';

/** Ссылку на свой же сайт открываем роутером, без перезагрузки всего приложения. */
function internalPath(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return null;
  }
}

/**
 * Объявление из панели управления. В старом проекте полосу рисовал отдельный
 * скрипт по разметке из статического index.html; при переезде на React она
 * потерялась вместе с самим index.html — админка публиковала объявления,
 * которые видела только десктопная программа.
 */
export function AnnouncementBanner() {
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  // localStorage читаем в эффекте: в приватном режиме доступ к нему бросает
  // исключение, и первый рендер не должен от него зависеть. null здесь значит
  // «ещё не читали», поэтому отсутствие записи превращаем в пустую строку.
  useEffect(() => {
    try {
      setDismissedId(localStorage.getItem(DISMISS_KEY) ?? '');
    } catch {
      setDismissedId('');
    }
  }, []);

  const { data } = useQuery({
    queryKey: ['announcement'],
    queryFn: async (): Promise<Announcement[]> => {
      const response = await fetch('/api/messages?surface=site');
      if (!response.ok) throw new Error('Не удалось загрузить объявления');
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const item = Array.isArray(data) ? data[0] : undefined;

  // Обрезку меряем по факту: длина строки зависит от ширины экрана, а не от
  // числа символов. В развёрнутом виде не пересчитываем — иначе кнопка
  // «Свернуть» исчезала бы сразу после нажатия.
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setClipped(node.scrollHeight - node.clientHeight > 2);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [item?.text, expanded]);

  if (!item?.text || dismissedId === null || dismissedId === String(item.id)) return null;

  const id = String(item.id);
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, id);
    } catch {
      // Не смогли запомнить — полоса вернётся на следующей странице, это не страшно
    }
    setDismissedId(id);
  };

  const label = item.button || 'Подробнее';
  const path = item.url ? internalPath(item.url) : null;
  const external = item.url && !path && /^https?:\/\//i.test(item.url) ? item.url : null;

  return (
    <aside className={s.banner} aria-label="Объявление" aria-live="polite">
      <div className={s.inner}>
        <div className={s.head}>
          <Megaphone size={18} className={s.icon} aria-hidden="true" />
          <div>
            <p ref={textRef} className={`${s.text} ${expanded ? '' : s.clamped}`}>
              {item.text}
            </p>
            {(clipped || expanded) && (
              <button type="button" className={s.more} onClick={() => setExpanded(v => !v)}>
                {expanded ? 'Свернуть' : 'Читать полностью'}
              </button>
            )}
          </div>
        </div>

        {path && (
          <Link className={s.cta} to={path}>
            {label}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
        {external && (
          <a className={s.cta} href={external} target="_blank" rel="noopener noreferrer">
            {label}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        )}

        <button type="button" className={s.close} onClick={dismiss} aria-label="Закрыть объявление">
          <X size={16} />
        </button>
      </div>
    </aside>
  );
}
