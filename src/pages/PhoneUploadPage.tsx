import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, CloudUpload, File as FileIcon, FileText, Image, Monitor, Music, RotateCw, SearchX, Video, X } from 'lucide-react';
import { ApiError } from '../api/client';
import { type PhoneInfo, cancelFile, linkState, openLink, sendChunk, startFile } from '../api/phone-drop';
import { useDocumentMeta } from '../lib/seo';
import { Spinner } from '../ui';
import s from './PhoneUploadPage.module.css';

type Status = 'waiting' | 'sending' | 'sent' | 'delivered' | 'error' | 'rejected' | 'canceled';
type Item = { key: string; file: File; status: Status; sent: number; fileId?: string; error?: string };
type Gate = { kind: 'loading' } | { kind: 'ready'; info: PhoneInfo } | { kind: 'gone'; used: boolean; text: string } | { kind: 'error'; text: string };

const secretKey = (token: string) => `phone-drop:${token}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function readSecret(token: string) {
  try { return sessionStorage.getItem(secretKey(token)); } catch { return null; }
}
function saveSecret(token: string, secret: string) {
  try { sessionStorage.setItem(secretKey(token), secret); } catch { /* приватный режим: привязка живёт до закрытия вкладки */ }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
}

function KindIcon({ file }: { file: File }) {
  const type = file.type;
  if (type.startsWith('image/')) return <Image size={20} aria-hidden="true" />;
  if (type.startsWith('video/')) return <Video size={20} aria-hidden="true" />;
  if (type.startsWith('audio/')) return <Music size={20} aria-hidden="true" />;
  if (type.startsWith('text/') || /pdf|word|excel|sheet|document|presentation/.test(type)) return <FileText size={20} aria-hidden="true" />;
  return <FileIcon size={20} aria-hidden="true" />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.page}>
      <main className={s.main}>{children}</main>
      <footer className={s.footer}>Передача через <a href="/" target="_blank" rel="noopener">shk-wb.ru</a> · файлы не хранятся на сервере</footer>
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

export function PhoneUploadPage() {
  const { token = '' } = useParams();
  const [gate, setGate] = useState<Gate>({ kind: 'loading' });
  const [items, setItems] = useState<Item[]>([]);
  // компьютер на связи (забирает файлы); false — программа закрыта, без интернета или приём на ней сброшен
  const [pcOnline, setPcOnline] = useState(true);
  const secretRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const fileRef = useRef<HTMLInputElement>(null);
  useDocumentMeta('Файлы на компьютер', 'Отправка файлов с телефона в «Помощник ПВЗ»');

  const lost = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.code === 'LINK_GONE' || error.code === 'LINK_USED' || error.code === 'LINK_NOT_OPENED')) {
      setGate({ kind: 'gone', used: error.code === 'LINK_USED', text: error.message });
      return true;
    }
    return false;
  }, []);

  const open = useCallback(async () => {
    setGate({ kind: 'loading' });
    try {
      const info = await openLink(token, readSecret(token));
      if (info.secret) saveSecret(token, info.secret);
      secretRef.current = info.secret ?? readSecret(token);
      setGate({ kind: 'ready', info });
    } catch (error) {
      if (!lost(error)) setGate({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось открыть страницу' });
    }
  }, [token, lost]);

  useEffect(() => { open(); }, [open]);

  const patch = (key: string, change: Partial<Item>) => setItems(list => list.map(i => (i.key === key ? { ...i, ...change } : i)));

  // Отправка по одному файлу, кусками. Обрыв связи — повтор того же куска; ПК не успевает — сервер
  // держит запрос и просит повторить (PC_BEHIND).
  const pump = useCallback(async () => {
    if (runningRef.current || gate.kind !== 'ready') return;
    runningRef.current = true;
    try {
      for (;;) {
        const item = itemsRef.current.find(i => i.status === 'waiting');
        if (!item) break;
        const secret = secretRef.current || '';
        patch(item.key, { status: 'sending', sent: 0, error: undefined });
        try {
          const { file: fileId, chunkBytes } = await startFile(token, secret, { name: item.file.name, size: item.file.size, mime: item.file.type });
          patch(item.key, { fileId });
          const total = Math.ceil(item.file.size / chunkBytes);
          for (let idx = 0; idx < total; idx++) {
            if (itemsRef.current.find(i => i.key === item.key)?.status === 'canceled') break;
            const blob = item.file.slice(idx * chunkBytes, Math.min(item.file.size, (idx + 1) * chunkBytes));
            for (let attempt = 0; ; attempt++) {
              try {
                await sendChunk(token, secret, fileId, idx, blob);
                break;
              } catch (error) {
                const retry = error instanceof ApiError && (error.status === 0 || error.code === 'PC_BEHIND' || error.status >= 500 || error.status === 429);
                if (!retry || attempt >= 40) throw error;
                await sleep(error instanceof ApiError && error.code === 'PC_BEHIND' ? 500 : Math.min(10_000, 1500 * (attempt + 1)));
              }
            }
            patch(item.key, { sent: Math.min(item.file.size, (idx + 1) * chunkBytes) });
          }
          if (itemsRef.current.find(i => i.key === item.key)?.status !== 'canceled') patch(item.key, { status: 'sent', sent: item.file.size });
        } catch (error) {
          if (lost(error)) return;
          const rejected = error instanceof ApiError && error.status === 413;
          patch(item.key, { status: rejected ? 'rejected' : 'error', error: error instanceof Error ? error.message : 'Не отправилось' });
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [gate, token, lost]);

  useEffect(() => { if (items.some(i => i.status === 'waiting')) pump(); }, [items, pump]);

  // Галочка «на компьютере»: ПК забрал файл целиком.
  const waitingPc = items.some(i => i.status === 'sent');
  useEffect(() => {
    if (!waitingPc || gate.kind !== 'ready') return;
    let stop = false;
    const tick = async () => {
      while (!stop) {
        try {
          const info = await linkState(token, secretRef.current || '');
          setPcOnline(info.pcOnline !== false);
          const done = new Set(info.files.filter(f => f.done).map(f => f.id));
          setItems(list => list.map(i => (i.status === 'sent' && i.fileId && done.has(i.fileId) ? { ...i, status: 'delivered' } : i)));
        } catch (error) {
          if (lost(error)) return;
        }
        await sleep(2500);
      }
    };
    tick();
    return () => { stop = true; };
  }, [waitingPc, gate.kind, token, lost]);

  if (gate.kind === 'loading') {
    return <Shell><section className={`${s.card} ${s.loading}`} aria-busy="true"><Spinner size={28} /><span>Подключаемся к компьютеру…</span></section></Shell>;
  }
  if (gate.kind === 'gone') {
    return (
      <Shell>
        <StateCard
          tone="muted"
          icon={<SearchX size={34} />}
          title={gate.used ? 'Ссылка уже использована' : 'Ссылка недействительна'}
          text={gate.used ? 'Эту ссылку уже открыли на другом телефоне. Нажмите «Новый QR» в программе и отсканируйте его снова.' : 'Приём на компьютере завершён или QR устарел. Нажмите «Новый QR» в программе «Помощник ПВЗ» и отсканируйте его снова.'}
        />
      </Shell>
    );
  }
  if (gate.kind === 'error') {
    return (
      <Shell>
        <StateCard tone="warn" icon={<RotateCw size={32} />} title="Страница не открылась" text={gate.text}
          action={<button type="button" className={s.secondary} onClick={open}>Повторить</button>} />
      </Shell>
    );
  }

  const { info } = gate;
  const maxFile = info.limits.fileBytes;

  function add(files: FileList | null) {
    if (!files?.length) return;
    const now = Date.now();
    const next: Item[] = Array.from(files).map((file, n) => ({
      key: `${now}-${n}-${Math.random()}`,
      file,
      sent: 0,
      status: file.size > maxFile ? 'rejected' : file.size === 0 ? 'rejected' : 'waiting',
      error: file.size > maxFile ? `Больше ${formatSize(maxFile)} — так не отправить` : file.size === 0 ? 'Пустой файл' : undefined,
    }));
    setItems(list => [...next, ...list]);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function cancel(item: Item) {
    patch(item.key, { status: 'canceled' });
    if (item.fileId && secretRef.current) await cancelFile(token, secretRef.current, item.fileId).catch(() => {});
  }

  const sending = items.find(i => i.status === 'sending');
  const queued = items.filter(i => i.status === 'waiting').length;
  const delivered = items.filter(i => i.status === 'delivered').length;

  return (
    <Shell>
      <section className={s.card}>
        <div className={s.target}>
          <span className={s.targetIcon} aria-hidden="true"><Monitor size={22} /></span>
          <div>
            <div className={s.targetLabel}>Отправка на компьютер</div>
            <div className={s.targetName}>{info.pcName}</div>
          </div>
        </div>

        <label className={s.pick}>
          <CloudUpload size={30} aria-hidden="true" />
          <span className={s.pickTitle}>Выбрать файлы</span>
          <span className={s.pickHint}>Фото, видео, документы, музыка — до {formatSize(maxFile)} каждый</span>
          <input ref={fileRef} type="file" multiple className="sr-only" onChange={e => add(e.target.files)} />
        </label>

        {(sending || queued > 0 || delivered > 0) && (
          <div className={s.summary} aria-live="polite">
            {sending ? `Отправляем «${sending.file.name}»` : queued ? `В очереди: ${queued}` : ''}
            {delivered > 0 && <span className={s.summaryOk}><Check size={14} strokeWidth={3} aria-hidden="true" /> На компьютере: {delivered}</span>}
          </div>
        )}

        {waitingPc && !pcOnline && (
          <div className={s.warn} role="status">
            Компьютер сейчас не забирает файлы. Они ждут на сервере до 30 минут: откройте на компьютере «Помощник ПВЗ» → «С телефона»
            и проверьте интернет. Если там нет QR — нажмите «Показать QR», отсканируйте заново и отправьте файлы ещё раз.
          </div>
        )}

        {items.length > 0 && (
          <ul className={s.list}>
            {items.map(item => {
              const pct = item.file.size ? Math.round((item.sent / item.file.size) * 100) : 0;
              return (
                <li key={item.key} className={`${s.row} ${item.status === 'error' || item.status === 'rejected' ? s.rowBad : ''}`}>
                  <span className={s.rowIcon}><KindIcon file={item.file} /></span>
                  <div className={s.rowBody}>
                    <div className={s.rowName}>{item.file.name}</div>
                    <div className={s.rowMeta}>
                      {item.status === 'waiting' && `${formatSize(item.file.size)} · в очереди`}
                      {item.status === 'sending' && `${formatSize(item.sent)} из ${formatSize(item.file.size)} · ${pct}%`}
                      {item.status === 'sent' && `${formatSize(item.file.size)} · компьютер забирает…`}
                      {item.status === 'delivered' && `${formatSize(item.file.size)} · на компьютере`}
                      {item.status === 'canceled' && 'Отменено'}
                      {(item.status === 'error' || item.status === 'rejected') && item.error}
                    </div>
                    {item.status === 'sending' && <div className={s.bar}><div className={s.barFill} style={{ width: `${pct}%` }} /></div>}
                  </div>
                  <div className={s.rowAction}>
                    {item.status === 'delivered' && <span className={s.okDot}><Check size={16} strokeWidth={3} aria-label="Доставлено" /></span>}
                    {item.status === 'sent' && <Spinner size={18} />}
                    {(item.status === 'waiting' || item.status === 'sending') && (
                      <button type="button" className={s.iconBtn} aria-label="Отменить" onClick={() => cancel(item)}><X size={16} /></button>
                    )}
                    {item.status === 'error' && (
                      <button type="button" className={s.iconBtn} aria-label="Повторить" onClick={() => patch(item.key, { status: 'waiting', sent: 0, error: undefined })}><RotateCw size={16} /></button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className={s.note}>Не закрывайте страницу, пока идёт отправка. Файлы попадут в раздел «С телефона» программы и останутся там, пока их не удалят.</p>
      </section>
    </Shell>
  );
}
