import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Clock, MessageCircle, Send } from 'lucide-react';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { SpecList } from '../components/SpecList';
import { Alert, Button, Card, Checkbox, Field, Input, Select, Textarea, useToast } from '../ui';
import { useDocumentMeta } from '../lib/seo';
import { api } from '../api/client';
import { type T, useLocalePath, useT } from '../i18n';
import s from './ContactsPage.module.css';

/** Значение темы уходит на сервер и сверяется со списком в api/support.js —
 *  поэтому оно всегда русское, переводится только подпись. */
const topics = (t: T) => [
  { value: 'Оплата и возврат', label: t('Оплата и возврат', 'Төлем және қайтару') },
  { value: 'Ключ и активация', label: t('Ключ и активация', 'Кілт және белсендіру') },
  { value: 'Настройка печати', label: t('Настройка печати', 'Басып шығаруды баптау') },
  { value: 'Не приходит код доступа', label: t('Не приходит код доступа', 'Қолжетімділік коды келмейді') },
  { value: 'Другое', label: t('Другое', 'Басқа') },
];

const DEFAULT_TOPIC = 'Оплата и возврат';

function makeSchema(t: T) {
  return z.object({
    name: z.string().min(2, t('Укажите, как к вам обращаться', 'Сізге қалай жүгінуге болатынын көрсетіңіз')),
    email: z.string().email(t('Введите корректную почту', 'Дұрыс поштаны енгізіңіз')),
    topic: z.string().min(1, t('Выберите тему', 'Тақырыпты таңдаңыз')),
    message: z.string().min(20, t('Опишите ситуацию подробнее — минимум 20 символов', 'Жағдайды толығырақ сипаттаңыз — кемінде 20 таңба')),
    consent: z.boolean().refine(v => v, t('Без согласия мы не можем обработать обращение', 'Келісімсіз өтінішті өңдей алмаймыз')),
    website: z.string().optional(),
  });
}

type Values = z.infer<ReturnType<typeof makeSchema>>;

export function ContactsPage() {
  const t = useT();
  const lp = useLocalePath();
  useDocumentMeta(
    t('Контакты и поддержка', 'Байланыс және қолдау'),
    t(
      'Напишите нам, если нужна помощь с оплатой, ключом активации или настройкой печати. Отвечаем в течение рабочего дня.',
      'Төлем, белсендіру кілті немесе басып шығаруды баптау бойынша көмек керек болса, бізге жазыңыз. Жұмыс күні ішінде жауап береміз.',
    ),
  );

  const toast = useToast();
  const schema = useMemo(() => makeSchema(t), [t]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { topic: DEFAULT_TOPIC },
  });

  const onSubmit = handleSubmit(async values => {
    try {
      await api<{ok:true}>('/api/support',{method:'POST',body:JSON.stringify(values)});
      toast(t('Обращение отправлено, ответим на указанную почту', 'Өтініш жіберілді, көрсетілген поштаға жауап береміз'), 'success');
      reset({ name: '', email: '', topic: DEFAULT_TOPIC, message: '', consent: false, website:'' });
    } catch (error) {
      toast(error instanceof Error ? error.message : t('Не удалось отправить обращение', 'Өтінішті жіберу мүмкін болмады'), 'error');
    }
  });

  const requisites = [
    { term: t('Исполнитель', 'Орындаушы'), value: t('Самозанятый Хасанов Султан Ярагиевич', 'Өзін-өзі жұмыспен қамтыған Хасанов Султан Ярагиевич') },
    { term: t('ИНН', 'ИНН (РФ салық нөмірі)'), value: '200204858850' },
    { term: t('Адрес', 'Мекенжай'), value: t('Чеченская Республика, Ачхой-Мартановский район, село Давыденко', 'Шешен Республикасы, Ачхой-Мартан ауданы, Давыденко ауылы') },
    {
      term: t('Почта для обращений', 'Өтініштерге арналған пошта'),
      value: <a href="mailto:sul987@mail.ru">sul987@mail.ru</a>,
    },
    {
      term: t('Документы', 'Құжаттар'),
      value: (
        <>
          <a className="accent" href={lp('/offer')}>
            {t('Публичная оферта', 'Жария оферта')}
          </a>
          {' · '}
          <a className="accent" href={lp('/privacy')}>
            {t('Политика конфиденциальности', 'Құпиялылық саясаты')}
          </a>
        </>
      ),
    },
  ];

  return (
    <>
      <Hero
        compact
        eyebrow={t('Поддержка', 'Қолдау')}
        title={t('Контакты', 'Байланыс')}
        copy={t(
          'Напишите нам, если нужна помощь с оплатой, ключом или настройкой печати. Обычно отвечаем в течение рабочего дня.',
          'Төлем, кілт немесе басып шығаруды баптау бойынша көмек керек болса, бізге жазыңыз. Әдетте жұмыс күні ішінде жауап береміз.',
        )}
        trust={[
          t('Ответ в течение рабочего дня', 'Жұмыс күні ішінде жауап'),
          t('Помогаем с установкой', 'Орнатуға көмектесеміз'),
          t('Разбираем спорные оплаты', 'Даулы төлемдерді қарастырамыз'),
        ]}
      />

      <div className="page">
        <div className={s.layout}>
          <Card>
            <h2>{t('Написать в поддержку', 'Қолдау қызметіне жазу')}</h2>
            <p className="muted" style={{ fontSize: 'var(--fs-14)' }}>
              {t(
                'Опишите, что происходит, и приложите номер заказа или ключа, если он у вас есть — так разберёмся быстрее.',
                'Не болып жатқанын сипаттап, тапсырыс немесе кілт нөмірі болса, оны қоса жіберіңіз — тезірек анықтаймыз.',
              )}
            </p>

            <form className="stack" onSubmit={onSubmit} noValidate>
              <div aria-hidden="true" style={{position:'absolute',left:'-10000px',width:1,height:1,overflow:'hidden'}}>
                <label>Сайт<Input tabIndex={-1} autoComplete="off" {...register('website')} /></label>
              </div>
              <div className={s.pair}>
                <Field label={t('Как к вам обращаться', 'Сізге қалай жүгінейік')} error={errors.name?.message}>
                  <Input autoComplete="name" {...register('name')} />
                </Field>

                <Field
                  label={t('Электронная почта', 'Электрондық пошта')}
                  error={errors.email?.message}
                  help={t('На неё придёт ответ', 'Жауап соған келеді')}
                >
                  <Input type="email" autoComplete="email" {...register('email')} />
                </Field>
              </div>

              <Field label={t('Тема обращения', 'Өтініш тақырыбы')} error={errors.topic?.message}>
                <Select {...register('topic')}>
                  {topics(t).map(topic => (
                    <option key={topic.value} value={topic.value}>
                      {topic.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t('Сообщение', 'Хабарлама')} error={errors.message?.message}>
                <Textarea
                  rows={6}
                  placeholder={t('Что произошло, какой продукт, номер заказа или ключа', 'Не болды, қай өнім, тапсырыс немесе кілт нөмірі')}
                  {...register('message')}
                />
              </Field>

              <Checkbox id="contacts-consent" {...register('consent')}>
                {t('Согласен на обработку персональных данных в соответствии с', 'Дербес деректерімді')}{' '}
                <a className="accent" href={lp('/privacy')}>
                  {t('политикой конфиденциальности', 'құпиялылық саясатына')}
                </a>
                {t('', ' сәйкес өңдеуге келісемін')}
              </Checkbox>
              {errors.consent && <Alert tone="error">{errors.consent.message}</Alert>}

              <Button size="lg" loading={isSubmitting}>
                <Send size={18} />
                {t('Отправить обращение', 'Өтінішті жіберу')}
              </Button>
            </form>
          </Card>

          <div className="stack-lg">
            <Card>
              <div className="stack">
                <MessageCircle size={32} color="var(--accent)" />
                <h2>{t('Telegram — самый быстрый способ', 'Telegram — ең жылдам тәсіл')}</h2>
                <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
                  {t(
                    'Пишите напрямую: поможем с установкой, активацией ключа и подключением принтера.',
                    'Тікелей жазыңыз: орнатуға, кілтті белсендіруге және принтерді қосуға көмектесеміз.',
                  )}
                </p>
                <div className="row">
                  <a href="https://t.me/roma_denosov" target="_blank" rel="noopener noreferrer">
                    <Button>{t('Написать @roma_denosov', '@roma_denosov-қа жазу')}</Button>
                  </a>
                </div>
              </div>
            </Card>

            <Card>
              <div className="stack">
                <Send size={32} color="var(--accent)" />
                <h2>{t('Канал с обновлениями', 'Жаңартулар арнасы')}</h2>
                <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
                  {t(
                    'Анонсы новых версий программ, изменения в правилах Wildberries и разборы частых проблем.',
                    'Бағдарламалардың жаңа нұсқаларының анонстары, Wildberries ережелеріндегі өзгерістер және жиі кездесетін мәселелерді талдау.',
                  )}
                </p>
                <div className="row">
                  <a href="https://t.me/wbtools_ru" target="_blank" rel="noopener noreferrer">
                    <Button variant="secondary">{t('Открыть канал', 'Арнаны ашу')}</Button>
                  </a>
                </div>
              </div>
            </Card>

            <Card>
              <div className="stack">
                <Clock size={32} color="var(--accent)" />
                <h2>{t('Когда отвечаем', 'Қашан жауап береміз')}</h2>
                <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
                  {t(
                    'Будни с 10:00 до 20:00 по московскому времени. Обращения по оплате разбираем в первую очередь — обычно в тот же день.',
                    'Жұмыс күндері Мәскеу уақытымен 10:00-ден 20:00-ге дейін (Астана уақытымен 12:00–22:00). Төлем бойынша өтініштерді бірінші кезекте қарастырамыз — әдетте сол күні.',
                  )}
                </p>
              </div>
            </Card>
          </div>
        </div>
      </div>

      <Section tone="band" eyebrow={t('Реквизиты', 'Деректемелер')} title={t('Кто оказывает услуги', 'Қызметтерді кім көрсетеді')}>
        <SpecList items={requisites} />
      </Section>
    </>
  );
}
