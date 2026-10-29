import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Minus } from 'lucide-react';
import { Alert, Button, Segmented } from '../ui';
import { type AppPlan, type AppPlans, useAppPlans } from '../api/app';
import { useMoney } from '../lib/currency';
import { type T, useLocalePath, useT } from '../i18n';
import s from './AppPlansTable.module.css';

function monthsWord(n: number, t: T) {
  if (n === 1) return t('1 месяц', '1 ай');
  if (n < 5) return t(`${n} месяца`, `${n} ай`);
  return t(`${n} месяцев`, `${n} ай`);
}

function devicesShort(n: number, t: T) {
  if (n === 1) return t('1 компьютер', '1 компьютер');
  if (n < 5) return t(`${n} компьютера`, `${n} компьютер`);
  return t(`${n} ПК`, `${n} ДК`);
}

/** Что тариф добавляет к предыдущему — первая строка карточки, как в прототипе. */
function planHighlight(plans: AppPlans, plan: AppPlan) {
  const index = plans.plans.findIndex(item => item.id === plan.id);
  const previous = index > 0 ? new Set(plans.plans[index - 1].features) : new Set<string>();
  const added = plan.features.filter(id => !previous.has(id)).map(id => plans.features[id]).filter(Boolean);
  return added.slice(0, 4).join(', ');
}

function planLimits(plan: AppPlan, t: T) {
  const parts = [t(`${plan.codes} подборов`, `${plan.codes} іріктеу`)];
  if (plan.points && plan.points > 1) parts.push(t(`${plan.points} пункта`, `${plan.points} пункт`));
  parts.push(devicesShort(plan.devices, t));
  return parts.join(' · ');
}

/** Строка «Пакеты расширения» под тарифами: что можно докупить и скидки за срок. */
function AddonStrip({ plans }: { plans: AppPlans }) {
  const t = useT();
  const ids = new Set((plans.addons ?? []).map(addon => addon.id));
  const items = [
    [...ids].some(id => id.startsWith('devices')) && t('+ компьютеры', '+ компьютерлер'),
    [...ids].some(id => id.startsWith('points')) && t('+ пункты', '+ пункттер'),
    [...ids].some(id => id.startsWith('mirror')) && t('Загрузка с другого ПК', 'Басқа ДК-дан жүктеу'),
    ids.has('archive') && t('Архив клиентов', 'Клиенттер мұрағаты'),
  ].filter(Boolean) as string[];
  const discounted = plans.terms.filter(term => term.discountPercent > 0).map(term => term.months);

  if (!items.length && !discounted.length) return null;
  return (
    <div className={s.addon}>
      <span>
        <b>{t('Пакеты расширения:', 'Кеңейту пакеттері:')}</b>
      </span>
      {items.map(item => (
        <span key={item}>{item}</span>
      ))}
      {discounted.length > 0 && (
        <span className={s.addonAccent}>
          {t(`скидки за ${discounted.join(' / ')} мес`, `${discounted.join(' / ')} айға жеңілдік`)}
        </span>
      )}
    </div>
  );
}

/** Компактные карточки по прототипу: главная и «Помощник ПВЗ». */
function CompactCards({ plans }: { plans: AppPlans }) {
  const t = useT();
  const lp = useLocalePath();
  const { formatTotal } = useMoney();

  return (
    <>
      <div className={s.plans}>
        {plans.plans.map(plan => {
          const popular = plan.id === 'standard';
          const highlight = planHighlight(plans, plan);
          return (
            <div key={plan.id} className={`${s.plan} ${popular ? s.planPopular : ''}`}>
              <div className={s.planTop}>
                <h3 className={s.planName}>{plan.title}</h3>
                {popular && <span className={s.flag}>{t('Выбирают чаще', 'Жиі таңдайды')}</span>}
              </div>
              <div className={s.cost}>
                <b>{formatTotal(plan.prices['1'] ?? plan.monthlyPrice)}</b> <span>{t('/ мес', '/ ай')}</span>
              </div>
              <p className={s.sum}>{plan.summary}</p>
              <ul className={s.bullets}>
                {highlight && (
                  <li>
                    <Check size={16} aria-hidden="true" />
                    {highlight}
                  </li>
                )}
                <li>
                  <Check size={16} aria-hidden="true" />
                  {planLimits(plan, t)}
                </li>
              </ul>
              <Link className={s.planAction} to={lp(`/cabinet/subscription?plan=${plan.id}`)}>
                <Button variant={popular ? 'primary' : 'secondary'} block>
                  {t('Выбрать', 'Таңдау')}
                </Button>
              </Link>
            </div>
          );
        })}
      </div>
      <AddonStrip plans={plans} />
    </>
  );
}

/** Полная матрица функций со сроком подписки — страница /tarify. */
function FullCards({ plans }: { plans: AppPlans }) {
  const t = useT();
  const lp = useLocalePath();
  const { formatTotal } = useMoney();
  const [months, setMonths] = useState(1);

  return (
    <>
      <div className={s.plansHead}>
        <Segmented
          label={t('Срок подписки', 'Жазылым мерзімі')}
          value={String(months)}
          onChange={v => setMonths(Number(v))}
          options={plans.terms.map(term => ({
            value: String(term.months),
            label: term.discountPercent ? `${monthsWord(term.months, t)} −${term.discountPercent}%` : monthsWord(term.months, t),
          }))}
        />
      </div>
      <div className={s.plans}>
        {plans.plans.map(plan => {
          const price = plan.prices[String(months)];
          const popular = plan.id === 'standard';
          return (
            <div key={plan.id} className={`${s.plan} ${popular ? s.planPopular : ''}`}>
              <div className={s.planTop}>
                <h3 className={s.planName}>{plan.title}</h3>
                {popular && <span className={s.flag}>{t('Выбирают чаще', 'Жиі таңдайды')}</span>}
              </div>
              <div className={s.cost}>
                <b>{formatTotal(price)}</b>{' '}
                <span>
                  {months > 1
                    ? t(`за ${monthsWord(months, t)} · ${formatTotal(Math.round(price / months))} в месяц`, `${monthsWord(months, t)} · айына ${formatTotal(Math.round(price / months))}`)
                    : t('/ мес', '/ ай')}
                </span>
              </div>
              <p className={s.sum}>{plan.summary}</p>
              <ul className={s.limits}>
                <li>{t(`${plan.codes} подборов кода в месяц`, `Айына ${plan.codes} код іріктеу`)}</li>
                {plan.stickers > 0 && <li>{t(`${plan.stickers} стикеров в месяц`, `Айына ${plan.stickers} стикер`)}</li>}
                <li>{plan.devices === 1 ? t('1 компьютер', '1 компьютер') : t(`До ${plan.devices} компьютеров`, `${plan.devices} компьютерге дейін`)}</li>
              </ul>
              <ul className={s.planFeatures}>
                {Object.entries(plans.features).map(([id, title]) => {
                  const on = plan.features.includes(id);
                  return (
                    <li key={id} className={on ? '' : s.off}>
                      {on ? <Check size={16} className={s.featureCheck} /> : <Minus size={16} />}
                      {title}
                    </li>
                  );
                })}
              </ul>
              <Link className={s.planAction} to={lp(`/cabinet/subscription?plan=${plan.id}`)}>
                <Button variant={popular ? 'primary' : 'secondary'} block>
                  {t('Выбрать', 'Таңдау')}
                </Button>
              </Link>
            </div>
          );
        })}
      </div>
      <AddonStrip plans={plans} />
    </>
  );
}

/**
 * Тарифы «Помощника ПВЗ». Данные — с сервера (/api/app/plans), без копий цен на
 * фронте. compact — карточки из прототипа (главная, «Помощник ПВЗ»), full — с
 * матрицей функций и сроком подписки (/tarify).
 */
export function AppPlansTable({ variant = 'compact' }: { variant?: 'compact' | 'full' }) {
  const t = useT();
  const lp = useLocalePath();
  const plans = useAppPlans();

  if (plans.data) {
    return (
      <>
        {plans.data.freeMode && (
          <Alert tone="success">
            {t(
              'Сейчас все функции программы бесплатны: скачайте её и войдите аккаунтом сайта — тариф Про включится сам, подборы не списываются.',
              'Қазір бағдарламаның барлық функциялары тегін: оны жүктеп алып, сайт аккаунтымен кіріңіз — Про тарифі өзі қосылады, іріктеулер есептелмейді.',
            )}
          </Alert>
        )}
        {variant === 'full' ? <FullCards plans={plans.data} /> : <CompactCards plans={plans.data} />}
      </>
    );
  }
  if (plans.isError) {
    return (
      <p className="muted">
        {t('Не удалось загрузить тарифы. Их можно посмотреть на ', 'Тарифтерді жүктеу мүмкін болмады. Оларды ')}
        <Link className="accent" to={lp('/program')}>{t('странице программы', 'бағдарлама бетінен')}</Link>
        {t('.', ' қарауға болады.')}
      </p>
    );
  }
  return <p className="muted">{t('Загружаем тарифы…', 'Тарифтер жүктелуде…')}</p>;
}
