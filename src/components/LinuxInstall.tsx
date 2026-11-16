import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, Check, Copy, Download, Lock, Monitor, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { LINUX_INSTALL_COMMAND } from '../lib/downloads';
import { useT } from '../i18n';
import s from './LinuxInstall.module.css';

/** Копирование с отметкой «Скопировано» на 2 с. Нет доступа к буферу — выделяем команду, чтобы скопировать вручную. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (fallbackEl?: HTMLElement | null) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      if (fallbackEl) {
        const range = document.createRange();
        range.selectNodeContents(fallbackEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };
  return { copied, copy };
}

export function CopyCommand({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { copied, copy } = useCopy(LINUX_INSTALL_COMMAND);
  const codeRef = useRef<HTMLElement>(null);
  return (
    <div className={`${s.cmd} ${compact ? s.cmdCompact : ''}`}>
      <code ref={codeRef} className={s.cmdText}>
        <span className={s.prompt} aria-hidden="true">$ </span>
        {LINUX_INSTALL_COMMAND}
      </code>
      <button
        type="button"
        className={s.copy}
        onClick={() => copy(codeRef.current)}
        aria-label={t('Скопировать команду', 'Команданы көшіру')}
      >
        {copied ? <Check size={16} strokeWidth={2.6} className={s.ok} /> : <Copy size={16} />}
        <span className={copied ? s.ok : undefined} aria-live="polite">
          {copied ? t('Скопировано', 'Көшірілді') : t('Копировать', 'Көшіру')}
        </span>
      </button>
    </div>
  );
}

function Bullet({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'success' }) {
  return (
    <li>
      <Check size={17} strokeWidth={2.6} className={tone === 'success' ? s.bulletOk : s.bulletAccent} />
      <span>{children}</span>
    </li>
  );
}

/** Две карточки в hero страницы программы: установщик для Windows и команда для Linux. */
export function PlatformCards({ downloadUrl }: { downloadUrl: string }) {
  const t = useT();
  return (
    <div className={s.platforms}>
      <div className={s.platform}>
        <div className={s.platformHead}>
          <span className={s.platformIcon}><Monitor size={22} /></span>
          <div>
            <div className={s.platformName}>Windows</div>
            <div className={s.platformSub}>{t('Windows 10 и 11, 64 бит · установщик около 4 МБ', 'Windows 10 және 11, 64 бит · орнатқыш шамамен 4 МБ')}</div>
          </div>
        </div>
        <ul className={s.bullets}>
          <Bullet>{t('Обычная установка: ярлык на рабочем столе и в «Пуске»', 'Кәдімгі орнату: жұмыс үстелінде және «Пуск» мәзірінде белгіше')}</Bullet>
          <Bullet>{t('Все разделы, включая сотрудников, видео по ШК и окно примерки', 'Барлық бөлімдер, соның ішінде қызметкерлер, ШК бойынша бейне және өлшеу терезесі')}</Bullet>
          <Bullet>{t('Обновляется сама, без связи работает до 24 часов', 'Өзі жаңарады, байланыссыз 24 сағатқа дейін жұмыс істейді')}</Bullet>
        </ul>
        <div className={s.grow} />
        <a href={downloadUrl} className={`${s.primary} desktop-only`}>
          <Download size={19} />
          {t('Скачать бесплатно', 'Тегін жүктеп алу')}
        </a>
      </div>

      <div className={s.platform}>
        <div className={s.platformHead}>
          <span className={`${s.platformIcon} ${s.platformIconDark}`}><Terminal size={22} /></span>
          <div>
            <div className={s.platformName}>
              Linux <span className={s.badge}>{t('новое', 'жаңа')}</span>
            </div>
            <div className={s.platformSub}>{t('x86_64 · запуск в браузере, без установки', 'x86_64 · браузерде іске қосу, орнатусыз')}</div>
          </div>
        </div>
        <ul className={s.bullets}>
          <Bullet tone="success">{t('Данные пункта не покидают компьютер', 'Пункт деректері компьютерден шықпайды')}</Bullet>
          <Bullet tone="success">{t('Закрыли вкладку — программа удаляет себя и все свои данные', 'Қойындыны жапсаңыз — бағдарлама өзін және барлық деректерін жояды')}</Bullet>
        </ul>
        <div className={s.cmdLabel}>{t('Вставьте в терминал (Ctrl + Alt + T):', 'Терминалға қойыңыз (Ctrl + Alt + T):')}</div>
        <CopyCommand compact />
        <div className={s.grow} />
        <a
          href="#linux"
          className={s.secondary}
          onClick={e => {
            const el = document.getElementById('linux');
            if (!el) return;
            e.preventDefault();
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          {t('Как запустить — по шагам', 'Қалай іске қосу — қадамдап')}
          <ArrowDown size={18} />
        </a>
      </div>
    </div>
  );
}

/* ---- Терминал, который «печатает» ---- */

type Line = { text: string; kind?: 'cmd' | 'link'; tone?: 'muted' | 'ok'; speed: number; pause: number; gap?: boolean };

/** Вывод — дословно то, что печатают linux.sh и программа (без номера пункта и пути к базе). */
const SCRIPT: Line[] = [
  { text: LINUX_INSTALL_COMMAND, kind: 'cmd', speed: 0.7, pause: 16 },
  { text: 'Помощник ПВЗ: проверяю последнюю версию…', tone: 'muted', speed: 2.2, pause: 18 },
  { text: 'Скачиваю новую версию… контрольная сумма совпала', tone: 'muted', speed: 2.2, pause: 24 },
  { text: 'Ищу базу WB на этом компьютере…', tone: 'muted', speed: 2.2, pause: 12 },
  { text: 'База WB найдена', speed: 2.2, pause: 26 },
  { text: 'Помощник ПВЗ работает. Откройте в браузере:', speed: 2.6, pause: 12, gap: true },
  { text: 'http://127.0.0.1:47815/?t=…', kind: 'link', speed: 2.6, pause: 4 },
  { text: 'Данные пункта не покидают этот компьютер.', tone: 'ok', speed: 2.6, pause: 6 },
  { text: 'Открываю браузер…', tone: 'muted', speed: 2.2, pause: 10 },
];
const TICK_MS = 25;

type Pos = { line: number; ch: number; wait: number };
const DONE: Pos = { line: SCRIPT.length, ch: 0, wait: 0 };

/** Печать начинается, когда терминал появился на экране; при «уменьшить движение» и без IntersectionObserver — сразу весь текст. */
function useTyping(ref: RefObject<HTMLElement | null>) {
  const animate =
    typeof window !== 'undefined' &&
    typeof IntersectionObserver !== 'undefined' &&
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [pos, setPos] = useState<Pos>(animate ? { line: 0, ch: 0, wait: SCRIPT[0].pause } : DONE);
  const [started, setStarted] = useState(!animate);

  useEffect(() => {
    if (started || !ref.current) return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setStarted(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [started, ref]);

  useEffect(() => {
    if (!started || pos.line >= SCRIPT.length) return;
    const id = window.setInterval(() => {
      setPos(p => {
        if (p.line >= SCRIPT.length) return p;
        if (p.wait > 0) return { ...p, wait: p.wait - 1 };
        const cur = SCRIPT[p.line];
        const next = p.ch + cur.speed;
        if (next < cur.text.length) return { ...p, ch: next };
        const n = p.line + 1;
        return { line: n, ch: 0, wait: n < SCRIPT.length ? SCRIPT[n].pause : 0 };
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [started, pos.line]);

  return pos;
}

function TypingTerminal() {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useTyping(ref);
  const done = pos.line >= SCRIPT.length;

  return (
    <div ref={ref} className={s.output} aria-hidden="true" data-terminal-output="">
      {SCRIPT.map((l, i) => {
        // ответ программы появляется только после того, как предыдущая строка «отработала»
        if (i > pos.line || (i === pos.line && i > 0 && pos.ch === 0 && pos.wait > 0)) return null;
        const full = i < pos.line;
        const text = full ? l.text : l.text.slice(0, Math.floor(pos.ch));
        const caret = done ? i === SCRIPT.length - 1 : i === pos.line;
        const cls = [
          l.kind === 'cmd' ? s.outCmd : l.tone === 'muted' ? s.outMuted : l.tone === 'ok' ? s.outOk : '',
          l.gap ? s.outGap : '',
          l.kind === 'link' ? s.outIndent : '',
        ].join(' ');
        return (
          <div key={i} className={cls}>
            {l.kind === 'cmd' && <span className={s.prompt}>$ </span>}
            {l.kind === 'link' ? <span className={s.outLink}>{text}</span> : text}
            {l.kind === 'link' && full && <span className={s.mark}>1</span>}
            {caret && <span className={s.caret} />}
          </div>
        );
      })}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

/** Подробная инструкция для Linux: шаги, терминал с командой, сноска о ссылке и приватность. */
export function LinuxInstall() {
  const t = useT();
  return (
    <div className={s.root}>
      <div className={s.grid}>
        <ol className={s.steps}>
          <li className={s.step}>
            <span className={s.num}>1</span>
            <div>
              <h3 className={s.stepTitle}>{t('Откройте терминал', 'Терминалды ашыңыз')}</h3>
              <p className={s.stepText}>
                {t('В Ubuntu и Mint — ', 'Ubuntu мен Mint-те — ')}
                <Kbd>Ctrl</Kbd> + <Kbd>Alt</Kbd> + <Kbd>T</Kbd>
                {t(
                  '. В других системах, например Astra Linux, найдите «Терминал» в меню приложений.',
                  '. Басқа жүйелерде, мысалы Astra Linux-та, қолданбалар мәзірінен «Терминалды» табыңыз.',
                )}
              </p>
            </div>
          </li>
          <li className={s.step}>
            <span className={s.num}>2</span>
            <div>
              <h3 className={s.stepTitle}>{t('Вставьте команду и нажмите Enter', 'Команданы қойып, Enter басыңыз')}</h3>
              <p className={s.stepText}>
                {t('Скопируйте её кнопкой «Копировать». В терминале вставка — ', '«Көшіру» батырмасымен көшіріңіз. Терминалда қою — ')}
                <Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>V</Kbd>.
              </p>
            </div>
          </li>
          <li className={s.step}>
            <span className={s.num}>3</span>
            <div>
              <h3 className={s.stepTitle}>{t('Работайте в браузере', 'Браузерде жұмыс істеңіз')}</h3>
              <p className={s.stepText}>
                {t(
                  'Программа сама найдёт базу WB и откроет её в браузере — ссылку копировать не нужно.',
                  'Бағдарлама WB базасын өзі тауып, оны браузерде ашады — сілтемені көшірудің қажеті жоқ.',
                )}
              </p>
            </div>
          </li>
        </ol>

        <div className={s.termCol}>
          <div className={s.term}>
            <div className={s.termBar}>
              <span className={s.dot} style={{ background: '#ff5f57' }} />
              <span className={s.dot} style={{ background: '#febc2e' }} />
              <span className={s.dot} style={{ background: '#28c840' }} />
              <span className={s.termTitle}>user@pvz: ~</span>
            </div>
            <div className={s.termBody}>
              <div className={s.termLabel}>{t('Команда для запуска', 'Іске қосу командасы')}</div>
              <CopyCommand />
            </div>
            <TypingTerminal />
          </div>

          <div className={s.footnote}>
            <span className={s.footMark}>1</span>
            <div>
              <strong>{t('Браузер откроется сам', 'Браузер өзі ашылады')}</strong>
              <p>
                {t('Если этого не произошло — выделите ссылку ', 'Егер ашылмаса — терминалдағы ')}
                <code className={s.inlineCode}>http://127.0.0.1:47815/?t=…</code>
                {t(' в терминале, скопируйте её ', ' сілтемесін белгілеп, ')}
                <Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>C</Kbd>
                {t(
                  ' и вставьте в адресную строку браузера. Ссылка у каждого компьютера своя, поэтому здесь её нет.',
                  ' арқылы көшіріп, браузердің мекенжай жолына қойыңыз. Сілтеме әр компьютерде өзінше, сондықтан ол мұнда жоқ.',
                )}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={s.cards}>
        <div className={s.card}>
          <span className={`${s.cardIcon} ${s.cardIconOk}`}><ShieldCheck size={20} /></span>
          <h3>{t('Данные пункта не покидают компьютер', 'Пункт деректері компьютерден шықпайды')}</h3>
          <p>
            {t(
              'База WB читается на месте и только для просмотра. В интернет уходит то же, что у версии для Windows: вход, проверка тарифа, запрос кода клиента и стикеры.',
              'WB базасы орнында және тек қарау үшін оқылады. Интернетке Windows нұсқасындағыдай ғана деректер кетеді: кіру, тарифті тексеру, клиент коды сұрауы және стикерлер.',
            )}
          </p>
        </div>
        <div className={s.card}>
          <span className={`${s.cardIcon} ${s.cardIconAccent}`}><Trash2 size={20} /></span>
          <h3>{t('Закрыли вкладку — следов не осталось', 'Қойындыны жаптыңыз — із қалмайды')}</h3>
          <p>
            {t(
              'Через полминуты после закрытия вкладки программа удаляет с компьютера себя, вход, настройки и архив. База WB и клиент WB не трогаются.',
              'Қойынды жабылғаннан кейін жарты минуттан соң бағдарлама компьютерден өзін, кіруді, баптауларды және мұрағатты жояды. WB базасы мен WB клиенті өзгеріссіз қалады.',
            )}
          </p>
        </div>
        <div className={s.card}>
          <span className={s.cardIcon}><Lock size={20} /></span>
          <h3>{t('Без установки и прав администратора', 'Орнатусыз және әкімші құқығынсыз')}</h3>
          <p>
            {t(
              'Один файл, его контрольная сумма сверяется перед запуском. Программа доступна только с этого компьютера — по ссылке из терминала.',
              'Бір файл, іске қосар алдында оның бақылау сомасы тексеріледі. Бағдарлама тек осы компьютерден — терминалдағы сілтеме арқылы қолжетімді.',
            )}
          </p>
        </div>
      </div>

      <p className={s.note}>
        {t(
          'В версии для Linux: ячейки, дорогие товары, «В пути», коробки, товар по ШК, код клиента, операции по дням и стикеры. Сотрудники, видео по ШК и окно примерки пока только в программе для Windows. Чтобы вход и настройки сохранялись между запусками, добавьте к команде ',
          'Linux нұсқасында: ұяшықтар, қымбат тауарлар, «Жолдағы», қораптар, ШК бойынша тауар, клиент коды, күндер бойынша операциялар және стикерлер. Қызметкерлер, ШК бойынша бейне және өлшеу терезесі әзірге тек Windows бағдарламасында. Кіру мен баптаулар іске қосулар арасында сақталуы үшін командаға ',
        )}
        <code className={s.inlineCode}>-s -- --keep</code>
        {t(' (получится «… | sh -s -- --keep»).', ' қосыңыз («… | sh -s -- --keep» болады).')}
      </p>
    </div>
  );
}
