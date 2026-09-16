import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileClock, Printer, QrCode } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Segmented,
  Table,
  Tabs,
} from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, useCabinet, useCabinetMutation, useHistory } from '../../api/cabinet';
import { apiBlob } from '../../api/client';
import type { GenerationEntry } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';
import s from './HistoryPage.module.css';

type Filter = 'all' | 'product' | 'box';

/** Номера пачки: у массовой генерации это список, у одиночной — единственный код. */
function entryCodes(entry: GenerationEntry): string[] {
  if (entry.codes?.length) return entry.codes;
  return entry.code ? [entry.code] : [];
}

/**
 * Печать уже созданной пачки. Пачку в 200 штук печатают частями, поэтому
 * здесь же видно, что уже выведено на бумагу, и можно допечатать остаток.
 */
function PrintDialog({ entry, onClose }: { entry: GenerationEntry; onClose: () => void }) {
  const [columns, setColumns] = useState(4);
  const [onlyUnprinted, setOnlyUnprinted] = useState(true);
  const [count, setCount] = useState<number | ''>('');
  const [fileError, setFileError] = useState('');
  const [filePending, setFilePending] = useState(false);
  const mark = useCabinetMutation<{ entryId: string; codes: string[] }, { printedCodes: string[] }>(
    '/api/cabinet/history',
    'PATCH',
  );

  const codes = entryCodes(entry);
  const printed = new Set(entry.printedCodes ?? []);
  const pool = onlyUnprinted ? codes.filter(code => !printed.has(code)) : codes;
  const limit = Number(count);
  const chosen = limit > 0 ? pool.slice(0, limit) : pool;

  const url = (inline: boolean) => {
    // Одиночная запись сохраняет компактный физический размер сетки «5 в ряд».
    const params = new URLSearchParams({ columns: String(entry.mode === 'custom' ? 5 : columns) });
    if (entry.batchId) params.set('batch', entry.batchId);
    else params.set('history', entry.id);
    if (entry.category === 'box') {
      params.set('variant', 'box');
      params.set('prefix', entry.prefix || 'TRBX');
    }
    if (chosen.length && chosen.length < codes.length) params.set('codes', chosen.join(','));
    if (inline) params.set('inline', '1');
    return `/api/stickers/pdf?${params.toString()}`;
  };

  // Файл открывается в соседней вкладке, поэтому отметку ставим по факту клика.
  const remember = () => {
    if (chosen.length) mark.mutate({ entryId: entry.id, codes: chosen });
  };

  const openHistoryPdf = async (inline: boolean) => {
    setFileError('');
    setFilePending(true);
    const printWindow = inline ? window.open('about:blank', '_blank') : null;
    try {
      const blob = await apiBlob(url(inline));
      const objectUrl = URL.createObjectURL(blob);
      if (inline && printWindow) printWindow.location.href = objectUrl;
      else {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `stickers-history-${entry.id}.pdf`;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      remember();
    } catch (error) {
      printWindow?.close();
      setFileError(error instanceof Error ? error.message : 'Не удалось подготовить PDF');
    } finally {
      setFilePending(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title="Печать пачки"
      description="Выберите раскладку листа и сколько стикеров вывести."
    >
      <div className="stack">
        <div className="row">
          <span className="muted">В пачке {codes.length}</span>
          <span className="muted">Напечатано {printed.size}</span>
          <strong>К печати сейчас: {chosen.length}</strong>
        </div>

        {entry.mode === 'range' && (
          <>
            <Segmented
              label="Количество колонок на листе"
              value={String(columns)}
              onChange={value => setColumns(Number(value))}
              options={[
                { value: '1', label: '1' },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
                { value: '4', label: '4' },
                { value: '5', label: '5' },
              ]}
            />
            <p className="muted">
              Выберите, сколько QR-кодов или стикеров должно помещаться в одной строке листа A4.
            </p>
          </>
        )}

        <Checkbox
          checked={onlyUnprinted}
          onChange={e => setOnlyUnprinted(e.target.checked)}
          id="history-only-unprinted"
        >
          Только те, что ещё не печатались
        </Checkbox>

        <Field label="Сколько напечатать" help={`Доступно ${pool.length}. Пусто — все.`}>
          <Input
            type="number"
            min={1}
            max={pool.length}
            placeholder={`Все ${pool.length}`}
            value={count}
            onChange={e => setCount(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </Field>

        {!chosen.length && (
          <Alert tone="info">
            Вся пачка уже напечатана. Снимите галочку, чтобы напечатать повторно.
          </Alert>
        )}

        {Boolean(chosen.length) && (
          <div className="row">
            {entry.batchId ? <a href={url(false)} download onClick={remember}>
              <Button>
                <Download size={18} />
                Скачать PDF
              </Button>
            </a> : <Button disabled={filePending} onClick={() => openHistoryPdf(false)}><Download size={18} />Скачать PDF</Button>}
            {entry.batchId ? <a href={url(true)} target="_blank" rel="noopener noreferrer" onClick={remember}>
              <Button variant="secondary">
                <Printer size={18} />
                Печать
              </Button>
            </a> : <Button variant="secondary" disabled={filePending} onClick={() => openHistoryPdf(true)}><Printer size={18} />Печать</Button>}
          </div>
        )}

        {fileError && <Alert tone="error">{fileError}</Alert>}
        {mark.isError && <Alert tone="error">{mark.error.message}</Alert>}
      </div>
    </Modal>
  );
}

function PreviewDialog({ entry, onClose }: { entry: GenerationEntry; onClose: () => void }) {
  const codes = entryCodes(entry);
  const [visible, setVisible] = useState(Math.min(4, codes.length));
  const imageUrl = (code: string) => {
    const params = new URLSearchParams({ code });
    if (entry.batchId) params.set('batch', entry.batchId);
    else params.set('history', entry.id);
    if (entry.category === 'box') {
      params.set('variant', 'box');
      params.set('prefix', entry.prefix || 'TRBX');
    }
    return `/api/stickers/image?${params.toString()}`;
  };

  return (
    <Modal open onOpenChange={open => !open && onClose()} title="Готовые QR-коды">
      <div className="stack">
        <div className={s.previewGrid}>
          {codes.slice(0, visible).map(code => (
            <figure key={code} className={s.previewCard}>
              <HistoryPreviewImage src={imageUrl(code)} code={code} authenticated={!entry.batchId} />
              <figcaption>{code}</figcaption>
            </figure>
          ))}
        </div>
        <div className="row">
          {visible < codes.length && (
            <>
              <Button variant="secondary" onClick={() => setVisible(Math.min(visible + 4, codes.length))}>
                Показать ещё 4
              </Button>
              <Button variant="ghost" onClick={() => setVisible(codes.length)}>Показать все</Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>Свернуть</Button>
          <span className="muted">Показано {visible} из {codes.length}</span>
        </div>
      </div>
    </Modal>
  );
}

function HistoryPreviewImage({ src, code, authenticated }: { src: string; code: string; authenticated: boolean }) {
  const [objectUrl, setObjectUrl] = useState('');
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    let currentUrl = '';
    void apiBlob(src).then(blob => {
      if (!active) return;
      currentUrl = URL.createObjectURL(blob);
      setObjectUrl(currentUrl);
    });
    return () => {
      active = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [authenticated, src]);
  return <img src={authenticated ? objectUrl : src} alt={`QR-код ${code}`} loading="lazy" />;
}

export function HistoryPage() {
  useDocumentMeta('История генераций — кабинет');
  const [filter, setFilter] = useState<Filter>('all');
  const [printing, setPrinting] = useState<GenerationEntry | null>(null);
  const [previewing, setPreviewing] = useState<GenerationEntry | null>(null);
  const query = useHistory(filter);
  const cabinet = useCabinet();
  const dismiss = useCabinetMutation<{ dismissImportNotice: boolean }>(
    '/api/cabinet/preferences',
    'PATCH',
  );

  if (query.isPending)
    return (
      <div className="page">
        <CabinetLoading />
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <CabinetError error={query.error} retry={() => query.refetch()} />
      </div>
    );

  const imported = cabinet.data?.profile.preferences;

  return (
    <div className="page">
      <header className="page-head">
        <h1>История генераций</h1>
        <p>Серверная история доступна на всех ваших устройствах.</p>
      </header>

      {Boolean(
        imported?.historyImportedAt &&
        imported.historyImportedCount > 0 &&
        !imported.historyImportNoticeDismissedAt,
      ) && (
        <Alert tone="info">
          <div className="row">
            <span>Перенесено локальных записей: {imported?.historyImportedCount}.</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => dismiss.mutate({ dismissImportNotice: true })}
            >
              Скрыть
            </Button>
          </div>
        </Alert>
      )}

      <Tabs
        label="Тип стикера"
        value={filter}
        onChange={setFilter}
        items={[
          { value: 'all', label: 'Все' },
          { value: 'product', label: 'Товары' },
          { value: 'box', label: 'QR коробок' },
        ]}
      />

      <div className="section">
        {query.data.items.length ? (
          <Table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Тип</th>
                <th>Режим</th>
                <th>Количество</th>
                <th>Номера</th>
                <th>Напечатано</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.items.map(g => {
                const codes = entryCodes(g);
                const printedCount = (g.printedCodes ?? []).filter(code =>
                  codes.includes(code),
                ).length;
                return (
                  <tr key={g.id}>
                    <td>{dateTime(g.createdAt)}</td>
                    <td>
                      <Badge tone={g.category === 'box' ? 'accent' : 'default'}>
                        {g.category === 'box' ? 'QR коробок' : 'Товары'}
                      </Badge>
                    </td>
                    <td>{g.mode === 'range' ? 'Массово' : 'По номеру'}</td>
                    <td>{g.quantity}</td>
                    <td className="mono">
                      {g.code || g.codes?.slice(0, 2).join(' — ') || g.batchId || '—'}
                    </td>
                    <td>
                      {codes.length ? (
                        <Badge tone={printedCount >= codes.length ? 'success' : 'default'}>
                          {printedCount} из {codes.length}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <Button size="sm" variant="secondary" disabled={!codes.length} onClick={() => setPreviewing(g)}>
                          <QrCode size={16} />
                          Посмотреть QR
                        </Button>
                        <Button size="sm" variant="secondary" disabled={!codes.length} onClick={() => setPrinting(g)}>
                          <Printer size={16} />
                          Печать
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <Card>
            <EmptyState
              icon={<FileClock />}
              title="Здесь пока пусто"
              text="Новые генерации появятся здесь автоматически."
              action={
                <Link to="/cabinet/generator">
                  <Button>Открыть генератор</Button>
                </Link>
              }
            />
          </Card>
        )}
      </div>

      {printing && <PrintDialog entry={printing} onClose={() => setPrinting(null)} />}
      {previewing && <PreviewDialog entry={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  );
}
