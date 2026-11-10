import type { AdminUserDetail } from '../../../../../api/admin';
import { int } from '../../../../../lib/admin-controls';
import { Button, Field, Select } from '../../../../../ui';
import { PreviewRows, Stepper } from './controls';
import u from '../../user.module.css';

export type GenerationsDraft = { target: number | 'new'; add: number };

export const GEN_MAX = 100000;

/** Код по умолчанию: первый включённый, иначе первый; кодов нет — новый код. */
export function initialGenerations(detail: AdminUserDetail): GenerationsDraft {
  const codes = detail.codes ?? [];
  const first = codes.find(code => code.active) ?? codes[0];
  return { target: first ? first.id : 'new', add: 100 };
}

/** Вкладка «Генерации»: пополнить существующий код (topupSticker) или выдать новый (grantSticker). */
export function GenerationsSection({
  detail,
  value,
  onChange,
}: {
  detail: AdminUserDetail;
  value: GenerationsDraft;
  onChange: (next: GenerationsDraft) => void;
}) {
  const codes = detail.codes ?? [];
  const isNew = value.target === 'new';
  const code = isNew ? null : codes.find(c => c.id === value.target) ?? null;
  const left = code ? Math.max(0, code.limit - code.used) : 0;

  const rows = isNew
    ? [
        { label: 'Новый код', from: 'нет', to: 'будет создан', changed: true },
        { label: 'Генераций на новом коде', from: '0', to: int(value.add), changed: value.add > 0 },
        ...(codes[0]
          ? [{ label: `Код ${codes[0].code}`, from: int(Math.max(0, codes[0].limit - codes[0].used)), to: int(Math.max(0, codes[0].limit - codes[0].used)), changed: false }]
          : []),
      ]
    : [
        { label: 'Код', from: code?.code ?? '—', to: code?.code ?? '—', changed: false },
        { label: 'Осталось генераций', from: int(left), to: int(left + value.add), changed: value.add > 0 },
      ];

  return (
    <div className={u.modalBody}>
      {codes.length > 0 && !isNew && (
        <Field label="Код генератора" help="Генерации стикеров на сайте. Код привязан к этому аккаунту">
          <Select value={String(value.target)} onChange={event => onChange({ ...value, target: Number(event.target.value) })}>
            {codes.map(c => (
              <option key={c.id} value={c.id}>
                {c.code} · осталось {Math.max(0, c.limit - c.used)}
                {c.active ? '' : ' · отключён'}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <div className={u.placeRow} style={{ padding: 0 }}>
        <label className={u.placeLabel} htmlFor="gen-add">
          {isNew ? 'Генераций на новом коде' : 'Добавить генераций'}
        </label>
        <Stepper id="gen-add" label="генерации" value={value.add} step={10} min={0} max={GEN_MAX} onChange={add => onChange({ ...value, add })} />
      </div>

      {codes.length > 0 && (
        <div className={u.box}>
          <Button
            type="button"
            variant="secondary"
            aria-pressed={isNew}
            style={{ minHeight: 'var(--tap)', alignSelf: 'flex-start' }}
            onClick={() => onChange({ ...value, target: isNew ? (codes.find(c => c.active) ?? codes[0]).id : 'new' })}
          >
            {isNew ? 'Не выдавать новый код' : 'Выдать новый код'}
          </Button>
          {isNew && (
            <p className={u.muted}>
              Будет выдан новый код с {int(value.add)} генерациями. Прежние коды продолжат работать как раньше.
            </p>
          )}
        </div>
      )}
      {codes.length === 0 && <p className={u.muted}>Кодов у пользователя нет — будет выдан новый код.</p>}

      <PreviewRows rows={rows} />
    </div>
  );
}
