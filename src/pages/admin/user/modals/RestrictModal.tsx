import { useEffect, useState } from 'react';
import { AdminApiError, type AdminUserDetail, type RestrictionScope } from '../../../../api/admin';
import { useRestrict, useUpdateRestriction } from '../../../../api/admin-controls';
import {
  PARTIAL_SCOPES,
  RESTRICT_TERMS,
  SCOPE_META,
  defaultPublicMessage,
  mskDateOfIso,
  restrictEffects,
  restrictUntil,
} from '../../../../lib/admin-controls';
import { Alert, Button, Checkbox, Field, Modal, Textarea, useToast } from '../../../../ui';
import { REASON_MAX, TermPicker, useConfirmAction, useIdempotencyKey } from '../../kit';
import { modalSubtitle } from '../shared';
import u from '../user.module.css';

type PartialScope = (typeof PARTIAL_SCOPES)[number];
type Term = { preset: string; date: string };

export const PUBLIC_MESSAGE_MAX = 300;

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every(item => b.includes(item));
}

/**
 * Окно «Ограничить доступ» (макет Restrict): полностью или частично, области,
 * срок, причина для журнала, текст пользователю и список последствий.
 * mode 'edit' — правка действующего ограничения (updateRestriction).
 */
export function RestrictModal({
  open,
  onOpenChange,
  detail,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AdminUserDetail;
  mode: 'create' | 'edit';
}) {
  const current = mode === 'edit' ? detail.restriction : null;
  const [scope, setScope] = useState<'full' | 'partial'>('partial');
  const [areas, setAreas] = useState<PartialScope[]>([]);
  const [term, setTerm] = useState<Term>({ preset: '7', date: '' });
  const [reason, setReason] = useState('');
  const [publicMessage, setPublicMessage] = useState('');
  const [notify, setNotify] = useState(false);
  const [force, setForce] = useState(false);
  const [needForce, setNeedForce] = useState(false);
  const key = useIdempotencyKey(open);
  const { pending, error, run, guardedOpenChange } = useConfirmAction(open, onOpenChange);
  const restrict = useRestrict();
  const update = useUpdateRestriction();
  const toast = useToast();

  // Исходные значения правки — чтобы слать только то, что действительно поменяли.
  const initialTerm: Term = current
    ? current.until
      ? { preset: 'custom', date: mskDateOfIso(current.until) }
      : { preset: 'forever', date: '' }
    : { preset: '7', date: '' };

  useEffect(() => {
    if (!open) return;
    if (current) {
      setScope(current.full ? 'full' : 'partial');
      setAreas(PARTIAL_SCOPES.filter(item => current.scopes.includes(item)));
      setPublicMessage(current.publicMessage ?? '');
    } else {
      setScope('partial');
      setAreas([]);
      setPublicMessage('');
    }
    setTerm(initialTerm);
    setReason('');
    setNotify(false);
    setForce(false);
    setNeedForce(false);
    // initialTerm и current выводятся из detail — пересчитываем только при открытии.
  }, [open, mode]);

  const full = scope === 'full';
  const scopes: RestrictionScope[] = full ? ['all'] : PARTIAL_SCOPES.filter(item => areas.includes(item));
  const termTouched = !current || term.preset !== initialTerm.preset || term.date !== initialTerm.date;
  const until: string | null | undefined = termTouched ? restrictUntil(term.preset, term.date) : (current?.until ?? null);
  const effects = restrictEffects(detail, scopes, until, publicMessage);
  const reasonOk = reason.trim().length > 0;
  const showForce = Boolean(detail.protected) || needForce;
  const forceOk = mode === 'edit' || !showForce || force;

  let hint = 'Запишем в журнал: причина, срок, ваш IP';
  if (scopes.length === 0) hint = 'Отметьте, что отключить';
  else if (!reasonOk) hint = `Укажите причину — без неё не ${mode === 'edit' ? 'сохранить' : 'ограничить'}`;
  else if (until === undefined) hint = term.preset === 'custom' && term.date ? 'Дата должна быть позже текущего момента' : 'Выберите дату';
  else if (!forceOk) hint = 'Аккаунт защищён — подтвердите галочкой ниже';
  const canSubmit = scopes.length > 0 && reasonOk && until !== undefined && forceOk && !pending;

  const toggleArea = (item: PartialScope) =>
    setAreas(prev => (prev.includes(item) ? prev.filter(value => value !== item) : [...prev, item]));

  const submit = () => {
    if (!canSubmit || until === undefined) return;
    void run(async () => {
      try {
        if (current) {
          const body = {
            userId: detail.userId,
            restrictionId: current.id,
            reason: reason.trim(),
            idempotencyKey: key,
            ...(termTouched ? { until } : {}),
            ...(sameSet(scopes, current.scopes) ? {} : { scopes }),
            ...(publicMessage.trim() === (current.publicMessage ?? '').trim() ? {} : { publicMessage: publicMessage.trim() || null }),
          };
          await update.mutateAsync(body);
          toast('Ограничение изменено', 'success');
        } else {
          const result = await restrict.mutateAsync({
            userId: detail.userId,
            scopes,
            until,
            reason: reason.trim(),
            ...(publicMessage.trim() ? { publicMessage: publicMessage.trim() } : {}),
            notify,
            ...(showForce ? { force } : {}),
            idempotencyKey: key,
          });
          toast(
            result.authBan === 'failed'
              ? 'Ограничение наложено, но вход на сайт закрыть не удалось — проверьте журнал'
              : 'Доступ ограничен',
            result.authBan === 'failed' ? 'error' : 'success',
          );
        }
      } catch (err) {
        if (err instanceof AdminApiError && err.code === 'PROTECTED_ACCOUNT') setNeedForce(true);
        throw err;
      }
    });
  };

  const len = publicMessage.length;

  return (
    <Modal
      open={open}
      onOpenChange={guardedOpenChange}
      title={mode === 'edit' ? 'Изменить ограничение' : 'Ограничить доступ'}
      description={modalSubtitle(detail)}
      size="lg"
      sheet
      footer={
        <div className={u.foot}>
          <span className={u.footHint} aria-live="polite">
            {hint}
          </span>
          <Button variant="secondary" onClick={() => guardedOpenChange(false)} disabled={pending}>
            Отмена
          </Button>
          <Button variant="danger" onClick={submit} disabled={!canSubmit} loading={pending}>
            {mode === 'edit' ? 'Сохранить' : 'Ограничить'}
          </Button>
        </div>
      }
    >
      <div className={u.modalBody}>
        <section className={u.box} aria-labelledby="restrict-scale">
          <div className={u.boxHead}>
            <h3 id="restrict-scale">Что ограничить</h3>
          </div>
          <div className={u.choiceGrid} role="radiogroup" aria-labelledby="restrict-scale">
            <div className={`${u.choice} ${full ? u.choiceDanger : ''}`}>
              <input id="restrict-full" type="radio" name="restrict-scale" checked={full} onChange={() => setScope('full')} />
              <label htmlFor="restrict-full">
                <strong>Полностью</strong>
                <small>Вход на сайт, программы, бот, покупки и выводы</small>
              </label>
            </div>
            <div className={`${u.choice} ${!full ? u.choiceOn : ''}`}>
              <input id="restrict-partial" type="radio" name="restrict-scale" checked={!full} onChange={() => setScope('partial')} />
              <label htmlFor="restrict-partial">
                <strong>Частично</strong>
                <small>Выбрать, что отключить — остальное продолжит работать</small>
              </label>
            </div>
          </div>
        </section>

        <section className={u.box} aria-labelledby="restrict-areas">
          <div className={u.boxHead}>
            <h3 id="restrict-areas">Что отключить</h3>
            <span>{full ? 'При полном ограничении отключается всё' : `Отмечено: ${areas.length} из ${PARTIAL_SCOPES.length}`}</span>
          </div>
          <div className={u.choiceGrid}>
            {PARTIAL_SCOPES.map(item => {
              const checked = full || areas.includes(item);
              return (
                <div key={item} className={`${u.choice} ${full ? u.choiceOff : checked ? u.choiceDanger : ''}`}>
                  <input id={`area-${item}`} type="checkbox" checked={checked} disabled={full} onChange={() => toggleArea(item)} />
                  <label htmlFor={`area-${item}`}>
                    <strong>{SCOPE_META[item].label}</strong>
                    <small style={full ? { color: 'var(--text-muted)' } : undefined}>{SCOPE_META[item].description}</small>
                  </label>
                </div>
              );
            })}
          </div>
        </section>

        <section className={u.box}>
          <TermPicker
            presets={RESTRICT_TERMS}
            value={term}
            onChange={setTerm}
            dateLabel="Снять в дату"
            hint={term.preset === 'forever' ? 'Само не снимется — только вручную' : 'Снимется в 18:00 по Москве'}
          />
        </section>

        <Field label="Причина (для журнала) *" help="Видят только администраторы">
          <Textarea rows={2} value={reason} maxLength={REASON_MAX} onChange={event => setReason(event.target.value)} />
        </Field>

        <Field label="Текст для пользователя (необязательно)" help={`Покажем в программе и боте. До ${PUBLIC_MESSAGE_MAX} символов`}>
          <Textarea
            rows={2}
            value={publicMessage}
            maxLength={PUBLIC_MESSAGE_MAX}
            placeholder={defaultPublicMessage(until ?? null)}
            onChange={event => setPublicMessage(event.target.value)}
          />
        </Field>
        <span className={`${u.counter} ${len > 280 ? u.counterWarn : ''}`} style={{ alignSelf: 'flex-end', marginTop: 'calc(-1 * var(--sp-3))' }}>
          {len} / {PUBLIC_MESSAGE_MAX}
        </span>

        <section className={u.box} aria-labelledby="restrict-effects">
          <div className={u.boxHead}>
            <h3 id="restrict-effects">Что произойдёт</h3>
          </div>
          {effects.length > 0 ? (
            <ul className={u.effects}>
              {effects.map(effect => (
                <li key={effect.text}>{effect.strong ? <strong>{effect.text}</strong> : effect.text}</li>
              ))}
            </ul>
          ) : (
            <p className={u.muted}>Отметьте хотя бы одну область выше — здесь появится список последствий.</p>
          )}
        </section>

        {mode === 'create' && (
          <Checkbox id="restrict-notify" checked={notify} onChange={event => setNotify(event.target.checked)}>
            Сообщить пользователю об ограничении (Telegram и почта; кабинет — если он остаётся доступен)
          </Checkbox>
        )}

        {mode === 'create' && showForce && (
          <Alert tone="warning">
            <div className="stack" style={{ gap: 'var(--sp-2)' }}>
              <span>У аккаунта включён безлимит (владелец или выдан вручную) — такие аккаунты защищены от случайного ограничения.</span>
              <Checkbox id="restrict-force" checked={force} onChange={event => setForce(event.target.checked)}>
                Всё равно ограничить этот аккаунт
              </Checkbox>
            </div>
          </Alert>
        )}

        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
