import s from './Steps.module.css';

export type Step = { title: string; text: string };

/**
 * Нумерованные шаги. Номер рисуется через counter в CSS, а не текстом в
 * разметке: список остаётся семантическим <ol>, и скринридер не читает цифру
 * дважды.
 */
export function Steps({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className={s.steps}>
      {steps.map(step => (
        <li key={step.title} className={s.step}>
          <h3 className={s.stepTitle}>{step.title}</h3>
          <p className={s.stepText}>{step.text}</p>
        </li>
      ))}
    </ol>
  );
}
