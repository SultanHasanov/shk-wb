import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { Alert, Badge, Button, Field, Input, Textarea } from '../ui';
import {
  inspectCustomCodes,
  parseCustomCodes,
  removeDuplicateCodes,
} from '../lib/custom-sticker-list';
import s from './BulkCustomStickerEditor.module.css';

const STORAGE_KEY = 'custom-sticker-list-draft';
export type CustomStickerJob = {
  id: string;
  status: 'draft' | 'running' | 'paused_no_credits' | 'completed' | 'failed';
  total: number;
  generated: number;
  remaining: number;
  error: string | null;
  codes?: string[];
  batches: Array<{ historyId: string; count: number }>;
  updatedAt: string;
};

export function BulkCustomStickerEditor({
  authenticated,
  onNeedPackages,
}: {
  authenticated: boolean;
  onNeedPackages: () => void;
}) {
  const location = useLocation(),
    client = useQueryClient();
  const [codes, setCodes] = useState<string[]>(() =>
    parseCustomCodes(localStorage.getItem(STORAGE_KEY) || ''),
  );
  const [raw, setRaw] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [startedDraftId, setStartedDraftId] = useState<string | null>(null);
  const inspected = useMemo(() => inspectCustomCodes(codes), [codes]);
  const duplicateCount = inspected.filter(x => x.duplicate).length;
  const invalidCount = inspected.filter(x => x.invalid).length;
  const validCount = inspected.filter(x => !x.invalid && !x.duplicate).length;
  const jobs = useQuery({
    queryKey: ['custom-sticker-jobs'],
    queryFn: () => api<{ items: CustomStickerJob[] }>('/api/cabinet/custom-sticker-jobs'),
    enabled: authenticated,
  });
  const active = jobs.data?.items.find(job => job.status !== 'completed') || null;
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, raw);
  }, [raw]);
  useEffect(() => {
    if (
      !raw &&
      active?.status === 'draft' &&
      active.id !== startedDraftId &&
      active.codes?.length
    ) {
      setCodes(active.codes);
      setRaw(active.codes.join('\n'));
    }
  }, [active, raw, startedDraftId]);
  const update = (next: string[]) => {
    setCodes(next);
    const text = next.join('\n');
    setRaw(text);
  };
  const process = useMutation({
    mutationFn: async (jobId: string) => {
      let result: CustomStickerJob;
      do {
        result = await api<CustomStickerJob>('/api/cabinet/custom-sticker-jobs', {
          method: 'POST',
          body: JSON.stringify({ jobId }),
        });
      } while (result.status === 'running' && result.remaining > 0);
      return result;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['custom-sticker-jobs'] });
      void client.invalidateQueries({ queryKey: ['cabinet'] });
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api<CustomStickerJob>('/api/cabinet/custom-sticker-jobs', {
        method: 'PUT',
        body: JSON.stringify({ jobId: active?.status === 'draft' ? active.id : null, codes }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['custom-sticker-jobs'] }),
  });
  const start = useMutation({
    mutationFn: async () => {
      const job = await api<CustomStickerJob>('/api/cabinet/custom-sticker-jobs', {
        method: 'PUT',
        body: JSON.stringify({ jobId: active?.status === 'draft' ? active.id : null, codes }),
      });
      setStartedDraftId(job.id);
      localStorage.removeItem(STORAGE_KEY);
      setCodes([]);
      setRaw('');
      return process.mutateAsync(job.id);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ['custom-sticker-jobs'] }),
  });
  const busy = start.isPending || process.isPending || save.isPending;
  const error = start.error || process.error || save.error;
  return (
    <div className="stack">
      <Field
        label="Номера ШК"
        help="Вставьте 11-значные номера через пробел или каждый с новой строки."
      >
        <Textarea
          rows={6}
          value={raw}
          placeholder={'59874145000 59874145001\n59874145002'}
          onChange={e => {
            setRaw(e.target.value);
            setCodes(parseCustomCodes(e.target.value));
          }}
        />
      </Field>
      <div className={s.summary}>
        <Badge>Всего: {codes.length}</Badge>
        <Badge tone="success">Корректных: {validCount}</Badge>
        <Badge tone={duplicateCount ? 'warning' : 'default'}>Дублей: {duplicateCount}</Badge>
        <Badge tone={invalidCount ? 'error' : 'default'}>Неверной длины: {invalidCount}</Badge>
      </div>
      {(duplicateCount > 0 || invalidCount > 0) && (
        <div className={s.actions}>
          {duplicateCount > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => update(removeDuplicateCodes(codes))}
            >
              Удалить дубли
            </Button>
          )}
          {invalidCount > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => update(codes.filter(code => /^\d{11}$/.test(code)))}
            >
              Удалить некорректные
            </Button>
          )}
        </div>
      )}
      {codes.length > 0 && (
        <div className={s.list}>
          {inspected.map((item, index) => (
            <div
              key={`${index}-${item.value}`}
              className={`${s.item} ${item.invalid ? s.bad : ''} ${item.duplicate ? s.duplicate : ''}`}
            >
              <Input
                aria-invalid={item.invalid || item.duplicate}
                inputMode="numeric"
                value={item.value}
                onChange={e => {
                  const next = [...codes];
                  next[index] = e.target.value.trim();
                  update(next);
                }}
              />
              <span>
                {item.invalid ? (
                  <Badge tone="error">Нужно 11 цифр</Badge>
                ) : item.duplicate ? (
                  <Badge tone="warning">Дубль</Badge>
                ) : (
                  <Badge tone="success">Готов</Badge>
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => update(codes.filter((_, i) => i !== index))}
              >
                Удалить
              </Button>
            </div>
          ))}
        </div>
      )}
      {!authenticated && codes.length > 0 && (
        <Alert tone="info">
          Чтобы сохранить очередь и начать генерацию,{' '}
          <Link to="/login" state={{ from: location.pathname + location.search }}>
            войдите в кабинет
          </Link>
          . Список восстановится после входа.
        </Alert>
      )}
      {authenticated && (
        <div className={s.actions}>
          <Button
            variant="secondary"
            loading={save.isPending}
            disabled={
              !codes.length ||
              Boolean(duplicateCount) ||
              Boolean(invalidCount) ||
              Boolean(active && active.status !== 'draft')
            }
            onClick={() => save.mutate()}
          >
            Сохранить черновик
          </Button>
          <Button
            size="lg"
            loading={start.isPending || process.isPending}
            disabled={
              !codes.length ||
              Boolean(duplicateCount) ||
              Boolean(invalidCount) ||
              Boolean(active && active.status !== 'draft')
            }
            onClick={() => start.mutate()}
          >
            Сгенерировать весь список
          </Button>
        </div>
      )}
      {active && (
        <div className={s.job}>
          <div className={s.progressHead}>
            <strong>Сохранённая очередь</strong>
            <span>
              {active.generated} из {active.total} готово · осталось {active.remaining}
            </span>
          </div>
          <div className={s.progress}>
            <span
              style={{ width: `${active.total ? (active.generated / active.total) * 100 : 0}%` }}
            />
          </div>
          <div className={s.actions}>
            {active.status !== 'draft' && (
              <Button loading={busy} onClick={() => process.mutate(active.id)}>
                Продолжить
              </Button>
            )}
            {active.status === 'paused_no_credits' && (
              <Button variant="secondary" onClick={onNeedPackages}>
                Пополнить пакет
              </Button>
            )}
          </div>
        </div>
      )}
      {jobs.data?.items
        .filter(job => job.generated > 0)
        .map(job => (
          <div className={s.job} key={job.id}>
            <strong>
              {job.status === 'completed' ? 'Готово' : 'Сгенерировано'}: {job.generated} из{' '}
              {job.total}
            </strong>
            <div className={s.actions}>
              {job.batches.map((batch, i) => (
                <Link key={batch.historyId} to="/cabinet/history">
                  <Button size="sm" variant="secondary">
                    Пачка {i + 1} · {batch.count} шт.
                  </Button>
                </Link>
              ))}
            </div>
          </div>
        ))}
      {error && (
        <Alert tone="error">
          {error instanceof Error ? error.message : 'Не удалось обработать очередь'}
        </Alert>
      )}
    </div>
  );
}
