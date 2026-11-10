import { useEffect, useState } from 'react';
import type { AdminUserDetail } from '../../../../api/admin';
import { useLiftRestriction } from '../../../../api/admin-controls';
import { adminLabel, formatMskDateTime } from '../../../../lib/admin-audit';
import { PARTIAL_SCOPES, SCOPE_META, daysLeftLabel, liftPreview } from '../../../../lib/admin-controls';
import { Alert, Badge, Button, Checkbox, Field, Modal, Textarea, useToast } from '../../../../ui';
import { REASON_MAX, useConfirmAction, useIdempotencyKey } from '../../kit';
import { modalSubtitle } from '../shared';
import u from '../user.module.css';

/** Окно «Снять ограничение» (макет Restrict, второе состояние). */
export function LiftRestrictionModal({
  open,
  onOpenChange,
  detail,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AdminUserDetail;
}) {
  const restriction = detail.restriction;
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const key = useIdempotencyKey(open);
  const { pending, error, run, guardedOpenChange } = useConfirmAction(open, onOpenChange);
  const lift = useLiftRestriction();
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setReason('');
      setNotify(true);
    }
  }, [open]);

  if (!restriction) return null;

  const preview = liftPreview(detail, restriction);
  const reasonOk = reason.trim().length > 0;
  const areas = restriction.full ? ['Полностью'] : PARTIAL_SCOPES.filter(item => restriction.scopes.includes(item)).map(item => SCOPE_META[item].label);
  const left = restriction.until ? daysLeftLabel(restriction.until) : null;

  const submit = () => {
    if (!reasonOk || pending) return;
    void run(async () => {
      const result = await lift.mutateAsync({
        userId: detail.userId,
        restrictionId: restriction.id,
        reason: reason.trim(),
        notify,
        idempotencyKey: key,
      });
      const back = result.restored.stickerCodes + result.restored.programKeys + result.restored.cellLicenses;
      toast(back > 0 ? `Ограничение снято, включено обратно: ${back}` : 'Ограничение снято', 'success');
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={guardedOpenChange}
      title="Снять ограничение"
      description={modalSubtitle(detail)}
      size="lg"
      sheet
      footer={
        <div className={u.foot}>
          <span className={u.footHint} aria-live="polite">
            {reasonOk ? 'Снимем сразу, запишем в журнал' : 'Укажите, почему снимаете'}
          </span>
          <Button variant="secondary" onClick={() => guardedOpenChange(false)} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!reasonOk || pending} loading={pending}>
            Снять ограничение
          </Button>
        </div>
      }
    >
      <div className={u.modalBody}>
        <section className={u.box} aria-labelledby="lift-current">
          <div className={u.boxHead}>
            <h3 id="lift-current">Текущее ограничение</h3>
            <Badge tone={restriction.expired ? 'warning' : 'error'}>
              {restriction.expired ? 'Срок вышел' : 'Действует'} · {restriction.full ? 'полностью' : 'частично'}
            </Badge>
          </div>
          <dl className={u.dl}>
            <dt>Области</dt>
            <dd>
              <span className={u.pillRow}>
                {areas.map(area => (
                  <Badge key={area}>{area}</Badge>
                ))}
              </span>
            </dd>
            <dt>Срок</dt>
            <dd>
              с {formatMskDateTime(restriction.createdAt)}{' '}
              {restriction.until ? `до ${formatMskDateTime(restriction.until)}${left ? ` · ${left}` : ''}` : '· бессрочно'}
            </dd>
            <dt>Причина</dt>
            <dd>«{restriction.reason}»</dd>
            <dt>Кто</dt>
            <dd>{adminLabel({ adminFingerprint: restriction.createdBy, userAgent: null })}</dd>
            <dt>Пользователю</dt>
            <dd>«{restriction.message}»</dd>
          </dl>
        </section>

        <section className={u.box} aria-labelledby="lift-back">
          <div className={u.boxHead}>
            <h3 id="lift-back">Вернётся</h3>
          </div>
          <ul className={u.effects}>
            {preview.willReturn.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        {preview.staysOff.length > 0 && (
          <section className={u.box} aria-labelledby="lift-off">
            <div className={u.boxHead}>
              <h3 id="lift-off">Останется выключенным</h3>
            </div>
            <ul className={u.effects}>
              {preview.staysOff.map(item => (
                <li key={item.label}>
                  <strong>{item.label}</strong> — {item.note}
                </li>
              ))}
            </ul>
            <p className={u.muted}>Включить можно в карточке, вкладка «Доступы и лимиты».</p>
          </section>
        )}

        <Field label="Почему снимаете *" help="Попадёт в журнал рядом с исходной причиной">
          <Textarea rows={2} value={reason} maxLength={REASON_MAX} onChange={event => setReason(event.target.value)} />
        </Field>

        <Checkbox id="lift-notify" checked={notify} onChange={event => setNotify(event.target.checked)}>
          Сообщить пользователю — в боте и кабинете: «Доступ восстановлен»
        </Checkbox>

        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
