import type { AdminUserDetail } from '../../../../../api/admin';
import {
  CODES_MAX,
  LIMIT_TERMS,
  SLOT_MAX,
  type LimitsDraft,
  formatDateMsk,
  int,
  limitsPreview,
} from '../../../../../lib/admin-controls';
import { Alert, Field, Input, Switch } from '../../../../../ui';
import { TermPicker } from '../../../kit';
import { PLAN_LABEL } from '../../shared';
import { PreviewRows, SegButtons, Stepper } from './controls';
import u from '../../user.module.css';

type Term = 'forever' | 'date';

function termText(term: Term, date: string): string {
  return term === 'date' ? (date ? `до ${formatDateMsk(`${date}T12:00:00+03:00`)}` : 'дата не выбрана') : 'бессрочно';
}

/** Вкладка «Помощник ПВЗ» окна «Лимиты»: подборы, места, безлимит, было → станет. */
export function PvzSection({
  detail,
  draft,
  onChange,
}: {
  detail: AdminUserDetail;
  draft: LimitsDraft;
  onChange: (patch: Partial<LimitsDraft>) => void;
}) {
  const base = detail.app?.limits?.base ?? { devices: 1, points: 1, mirror: 0, codes: 0 };
  const planName = PLAN_LABEL[detail.app?.entitlements?.plan ?? ''] ?? null;
  const envUnlimited = detail.unlimited?.source === 'env' && detail.unlimited.active;
  const rows = limitsPreview(detail, draft);
  const prevNote = draft.unlimited
    ? `Безлимит ${termText(draft.unlimitedTerm, draft.unlimitedDate)}`
    : `Подборы ${draft.codesMode === 'tariff' ? 'по тарифу' : termText(draft.codesTerm, draft.codesDate)} · места ${termText(draft.slotsTerm, draft.slotsDate)}`;

  const places: Array<{ key: 'devices' | 'points' | 'mirror'; label: string; word: string; base: number }> = [
    { key: 'devices', label: 'ПК', word: 'ПК', base: base.devices },
    { key: 'points', label: 'Пункты', word: 'пункты', base: base.points },
    { key: 'mirror', label: 'Зеркало', word: 'зеркало', base: base.mirror },
  ];

  return (
    <div className={u.modalBody}>
      <section className={u.box} aria-labelledby="lim-codes">
        <div className={u.boxHead}>
          <h3 id="lim-codes">Подборы кодов в месяц</h3>
          <span>{planName ? `В тарифе «${planName}»: ${int(base.codes)}` : `Без тарифа: ${int(base.codes)}`}</span>
        </div>
        <SegButtons
          label="Как считать подборы"
          value={draft.codesMode}
          onChange={codesMode => onChange({ codesMode })}
          options={[
            { value: 'tariff', label: 'Как в тарифе' },
            { value: 'add', label: 'Прибавить к тарифу' },
            { value: 'exact', label: 'Задать ровно' },
          ]}
        />
        {draft.codesMode === 'tariff' ? (
          <p className={u.muted}>Своя настройка снимется — останется лимит тарифа: {int(base.codes)} подборов в месяц.</p>
        ) : (
          <>
            <div className={u.placeRow} style={{ padding: 0 }}>
              <label className={u.placeLabel} htmlFor="lim-codes-value">
                {draft.codesMode === 'add' ? 'Прибавить подборов' : 'Подборов в месяц ровно'}
              </label>
              <Stepper
                id="lim-codes-value"
                label="подборы"
                value={draft.codes}
                step={50}
                max={CODES_MAX}
                onChange={codes => onChange({ codes })}
              />
            </div>
            <TermPicker
              presets={LIMIT_TERMS}
              value={{ preset: draft.codesTerm, date: draft.codesDate }}
              onChange={v => onChange({ codesTerm: v.preset as Term, codesDate: v.date })}
              dateLabel="Действует по (включительно)"
            />
          </>
        )}
      </section>

      <section className={u.box} aria-labelledby="lim-slots">
        <div className={u.boxHead}>
          <h3 id="lim-slots">Дополнительные места</h3>
          <span>
            По тарифу сейчас: {base.devices} ПК, {base.points} пункт., {base.mirror} зерк.
          </span>
        </div>
        <div className={u.places}>
          {places.map(place => (
            <div key={place.key} className={u.placeRow}>
              <label className={u.placeLabel} htmlFor={`lim-${place.key}`}>
                <span>
                  {place.label} <b>+{draft[place.key]}</b>
                </span>
                <small>
                  сейчас по тарифу {place.base} · станет {place.base + draft[place.key]}
                </small>
              </label>
              <Stepper
                id={`lim-${place.key}`}
                label={place.word}
                value={draft[place.key]}
                max={SLOT_MAX}
                onChange={value => onChange({ [place.key]: value } as Partial<LimitsDraft>)}
              />
            </div>
          ))}
        </div>
        {Number(detail.legacyDeviceBonus) > 0 && (
          <p className={u.muted}>Учтена старая надбавка ПК: +{detail.legacyDeviceBonus}. После сохранения мест она перейдёт в ручные лимиты.</p>
        )}
        <TermPicker
          presets={LIMIT_TERMS}
          value={{ preset: draft.slotsTerm, date: draft.slotsDate }}
          onChange={v => onChange({ slotsTerm: v.preset as Term, slotsDate: v.date })}
          dateLabel="Места действуют по (включительно)"
          hint="Один общий срок для ПК, пунктов и зеркала"
        />
      </section>

      <section className={u.box} aria-labelledby="lim-unlim">
        <Switch
          id="lim-unlim"
          checked={draft.unlimited}
          onChange={event => onChange({ unlimited: event.target.checked })}
          description="Подборы и места без ограничений. Списания не идут"
        >
          Безлимит
        </Switch>
        {envUnlimited && <Alert tone="info">Безлимит этому аккаунту включён в настройках сервера (владелец) — здесь его не выключить.</Alert>}
        {draft.unlimited && (
          <>
            <TermPicker
              presets={LIMIT_TERMS}
              value={{ preset: draft.unlimitedTerm, date: draft.unlimitedDate }}
              onChange={v => onChange({ unlimitedTerm: v.preset as Term, unlimitedDate: v.date })}
              dateLabel="Безлимит по (включительно)"
            />
            <p className={u.muted}>Пока безлимит включён, лимиты выше не действуют. Когда срок выйдет, они вернутся сами.</p>
          </>
        )}
      </section>

      <Field label="Заметка (видно в карточке)" help="Необязательно, до 300 символов">
        <Input value={draft.note} maxLength={300} onChange={event => onChange({ note: event.target.value })} />
      </Field>

      <PreviewRows note={prevNote} rows={rows} />
    </div>
  );
}
