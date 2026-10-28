import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Minus } from 'lucide-react';
import { Alert, Button, Segmented } from '../ui';
import { type AppPlans, useAppPlans } from '../api/app';
import { useMoney } from '../lib/currency';
import { type T, useLocalePath, useT } from '../i18n';
import s from './AppPlansTable.module.css';

function monthsWord(n: number, t: T) {
  if (n === 1) return t('1 месяц', '1 ай');
  if (n < 5) return t(`${n} месяца`, `${n} ай`);
  return t(`${n} месяцев`, `${n} ай`);
}

function PlanCards({ plans }: { plans: AppPlans }) {
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
              {popular && <span className={s.ribbon}>{t('Чаще всего берут', 'Ең жиі алады')}</span>}
              <h3 className={s.planName}>{plan.title}</h3>
              <p className="muted" style={{ margin: 0 }}>{plan.summary}</p>
              <div>
                <div className={s.planPrice}>{formatTotal(price)}</div>
                <div className={s.planPer}>
                  {months > 1
                    ? t(`за ${monthsWord(months, t)} · ${formatTotal(Math.round(price / months))} в месяц`, `${monthsWord(months, t)} · айына ${formatTotal(Math.round(price / months))}`)
                    : t('в месяц', 'айына')}
                </div>
              </div>
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
              <Link className={s.planAction} to={lp('/cabinet/subscription')}>
                <Button variant={popular ? 'primary' : 'secondary'}>{t('Оформить', 'Рәсімдеу')}</Button>
              </Link>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Таблица тарифов «Помощника ПВЗ». Данные — с сервера (/api/app/plans), без
 * копий цен на фронте. Вынесена из ProgramPage, чтобы ту же таблицу показывала
 * и главная, и страница /tarify.
 */
export function AppPlansTable() {
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
        <PlanCards plans={plans.data} />
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
