import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Camera, Check, Lock, MapPin, Pause, RotateCw, SearchX, X } from 'lucide-react';
import { ApiError } from '../api/client';
import { type FeedbackKind, submitFeedback, uploadFeedbackPhoto, usePublicFeedbackBoard } from '../api/feedback';
import { DEFAULT_HEADLINE, themeBackground } from '../lib/feedback-card';
import { useDocumentMeta } from '../lib/seo';
import { Spinner } from '../ui';
import s from './FeedbackFormPage.module.css';

const MAX_PHOTOS = 3;
const MAX_TEXT = 1000;
const RATING_WORDS = ['Поставьте оценку', 'Очень плохо', 'Плохо', 'Нормально', 'Хорошо', 'Отлично!'];
const KINDS: ReadonlyArray<{ value: FeedbackKind; label: string; placeholder: string }> = [
  { value: 'thanks', label: 'Благодарность', placeholder: 'Кого хотите поблагодарить? Что понравилось?' },
  { value: 'idea', label: 'Предложение', placeholder: 'Что нам стоит улучшить?' },
  { value: 'complaint', label: 'Жалоба', placeholder: 'Что случилось? Мы разберёмся' },
];
const kindForRating = (rating: number): FeedbackKind => (rating <= 2 ? 'complaint' : rating === 3 ? 'idea' : 'thanks');

type Photo = { key: string; preview: string; status: 'uploading' | 'ready' | 'error'; id?: string; token?: string; error?: string };

/** Фото с телефона весят 3–8 МБ: сжимаем до 1600 px по длинной стороне, JPEG. Не вышло (HEIC в Chrome) — шлём как есть. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

function Shell({ background, place, children }: { background: string; place?: string; children: React.ReactNode }) {
  return (
    <div className={s.page}>
      <header className={s.hero} style={{ background }}>
        <div className={s.heroInner}>
          {place && (
            <div className={s.place}>
              <MapPin size={16} aria-hidden="true" />
              <span>{place}</span>
            </div>
          )}
        </div>
      </header>
      <main className={s.main}>{children}</main>
      <footer className={s.footer}>
        Сделано на <a href="/" target="_blank" rel="noopener">shk-wb.ru</a> — QR для отзывов бесплатно
      </footer>
    </div>
  );
}

function StateCard({ icon, tone, title, text, action }: { icon: React.ReactNode; tone: 'ok' | 'warn' | 'muted'; title: string; text: string; action?: React.ReactNode }) {
  return (
    <section className={`${s.card} ${s.stateCard}`}>
      <div className={`${s.stateIcon} ${s[tone]}`} aria-hidden="true">{icon}</div>
      <h1 className={s.stateTitle}>{title}</h1>
      <p className={s.stateText}>{text}</p>
      {action}
    </section>
  );
}

export function FeedbackFormPage() {
  const { slug = '' } = useParams();
  const code = slug.toUpperCase();
  const board = usePublicFeedbackBoard(code);
  const [rating, setRating] = useState(0);
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [comment, setComment] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [website, setWebsite] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useDocumentMeta('Отзыв о пункте выдачи', 'Анонимный отзыв о пункте выдачи');

  // Превью фото — blob-ссылки: освобождаем при уходе со страницы.
  useEffect(() => () => photosRef.current.forEach(p => URL.revokeObjectURL(p.preview)), []);

  const background = board.data ? themeBackground(board.data.design) : 'linear-gradient(160deg, #d316b2 0%, #8f17c9 100%)';
  const place = board.data ? [board.data.place, board.data.address].filter(Boolean).join(' · ') : '';

  if (board.isPending) {
    return (
      <Shell background={background}>
        <section className={`${s.card} ${s.loading}`} aria-busy="true"><Spinner size={28} /><span>Открываем страницу отзыва…</span></section>
      </Shell>
    );
  }
  if (board.isError) {
    const missing = board.error instanceof ApiError && board.error.status === 404;
    return (
      <Shell background={missing ? '#1d1a29' : background}>
        {missing ? (
          <StateCard tone="muted" icon={<SearchX size={34} />} title="Код не найден" text="Этот QR-код удалён или напечатан с ошибкой. Если вы в пункте выдачи — скажите об этом сотруднику." />
        ) : (
          <StateCard
            tone="warn"
            icon={<RotateCw size={32} />}
            title="Страница не открылась"
            text={board.error instanceof Error ? board.error.message : 'Нет связи с сервером.'}
            action={<button type="button" className={s.secondary} onClick={() => board.refetch()}>Повторить</button>}
          />
        )}
      </Shell>
    );
  }
  if (!board.data.isActive) {
    return (
      <Shell background={background} place={place}>
        <StateCard tone="warn" icon={<Pause size={32} />} title="Приём отзывов на паузе" text="Владелец пункта временно выключил этот QR-код. Загляните позже или спросите сотрудника на выдаче." />
      </Shell>
    );
  }

  const reset = () => {
    photos.forEach(p => URL.revokeObjectURL(p.preview));
    setRating(0); setKind(null); setComment(''); setPhotos([]); setError(''); setDone(false);
  };

  if (done) {
    return (
      <Shell background={background} place={place}>
        <StateCard
          tone="ok"
          icon={<Check size={36} strokeWidth={2.6} />}
          title="Спасибо за отзыв!"
          text="Владелец пункта уже получил его. Ответа не будет — отзыв анонимный, но его обязательно прочитают."
          action={<button type="button" className={s.secondary} onClick={reset}>Оставить ещё один</button>}
        />
      </Shell>
    );
  }

  const activeKind = kind ?? (rating ? kindForRating(rating) : null);
  const placeholder = KINDS.find(k => k.value === activeKind)?.placeholder ?? 'Расскажите, как всё прошло';
  const uploading = photos.some(p => p.status === 'uploading');

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_PHOTOS - photos.length;
    const picked = Array.from(files).slice(0, room);
    for (const file of picked) {
      const key = `${Date.now()}-${Math.random()}`;
      const preview = URL.createObjectURL(file);
      setPhotos(list => [...list, { key, preview, status: 'uploading' }]);
      try {
        const blob = await shrink(file);
        const result = await uploadFeedbackPhoto(code, blob);
        setPhotos(list => list.map(p => (p.key === key ? { ...p, status: 'ready', ...result } : p)));
      } catch (e) {
        setPhotos(list => list.map(p => (p.key === key ? { ...p, status: 'error', error: e instanceof Error ? e.message : 'Не загрузилось' } : p)));
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  function removePhoto(key: string) {
    setPhotos(list => {
      const gone = list.find(p => p.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return list.filter(p => p.key !== key);
    });
  }

  async function send() {
    if (!rating || sending || uploading) return;
    setSending(true);
    setError('');
    try {
      await submitFeedback(code, {
        rating,
        kind: activeKind ?? kindForRating(rating),
        comment: comment.trim(),
        photos: photos.filter(p => p.status === 'ready' && p.id && p.token).map(p => ({ id: p.id!, token: p.token! })),
        website,
      });
      setDone(true);
    } catch (e) {
      // Текст и фото остаются на странице — можно повторить.
      if (e instanceof ApiError && e.code === 'PAUSED') board.refetch();
      setError(e instanceof Error ? e.message : 'Не удалось отправить отзыв');
    } finally {
      setSending(false);
    }
  }

  return (
    <Shell background={background} place={place}>
      <form className={s.card} onSubmit={e => { e.preventDefault(); send(); }} noValidate>
        <h1 className={s.title}>{board.data.headline || DEFAULT_HEADLINE}</h1>

        <fieldset className={s.rating}>
          <legend className="sr-only">Оценка</legend>
          <div className={s.stars} role="radiogroup" aria-label="Оценка от 1 до 5">
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} из 5 — ${RATING_WORDS[n]}`}
                className={`${s.star} ${n <= rating ? s.starOn : ''}`}
                onClick={() => { setRating(n); setKind(null); }}
              >
                ★
              </button>
            ))}
          </div>
          <div className={`${s.ratingWord} ${rating ? s.ratingChosen : ''}`} aria-live="polite">{RATING_WORDS[rating]}</div>
        </fieldset>

        <div className={s.block}>
          <div className={s.label} id="fb-kind">О чём отзыв?</div>
          <div className={s.chips} role="radiogroup" aria-labelledby="fb-kind">
            {KINDS.map(k => (
              <button key={k.value} type="button" role="radio" aria-checked={activeKind === k.value} className={`${s.chip} ${activeKind === k.value ? s.chipOn : ''}`} onClick={() => setKind(k.value)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div className={s.block}>
          <label className={s.label} htmlFor="fb-comment">Комментарий</label>
          <textarea id="fb-comment" className={s.textarea} rows={4} maxLength={MAX_TEXT} placeholder={placeholder} value={comment} onChange={e => setComment(e.target.value)} />
          <div className={s.counter}>{comment.length} / {MAX_TEXT}</div>
        </div>

        <div className={s.block}>
          <div className={s.label}>Фото <span className={s.muted}>— по желанию, до {MAX_PHOTOS}</span></div>
          <div className={s.photos}>
            {photos.map(p => (
              <div key={p.key} className={`${s.photo} ${p.status === 'error' ? s.photoError : ''}`}>
                <img src={p.preview} alt="" />
                {p.status === 'uploading' && <span className={s.photoBusy}><Spinner size={20} /></span>}
                {p.status === 'error' && <span className={s.photoFail} title={p.error}>Не загрузилось</span>}
                <button type="button" className={s.photoRemove} aria-label="Убрать фото" onClick={() => removePhoto(p.key)}><X size={12} strokeWidth={3} /></button>
              </div>
            ))}
            {photos.length < MAX_PHOTOS && (
              <label className={s.photoAdd}>
                <Camera size={22} aria-hidden="true" />
                Добавить
                <input ref={fileRef} type="file" accept="image/*" multiple className="sr-only" onChange={e => addFiles(e.target.files)} />
              </label>
            )}
          </div>
        </div>

        {/* Ловушка для ботов: человек это поле не видит */}
        <div className={s.trap} aria-hidden="true">
          <label htmlFor="fb-website">Сайт</label>
          <input id="fb-website" tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} />
        </div>

        <div className={s.privacy}>
          <Lock size={18} aria-hidden="true" />
          <span>Отзыв анонимный: мы не спрашиваем имя и телефон, а из фото удаляем геолокацию и модель телефона.</span>
        </div>

        {error && <div className={s.error} role="alert">{error}</div>}

        <button type="submit" className={s.submit} disabled={!rating || sending || uploading} aria-busy={sending}>
          {sending ? <Spinner size={18} /> : null}
          {!rating ? 'Сначала поставьте оценку' : uploading ? 'Загружаем фото…' : sending ? 'Отправляем…' : error ? 'Повторить отправку' : 'Отправить анонимно'}
        </button>
      </form>
    </Shell>
  );
}
