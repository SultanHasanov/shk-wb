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
import s from './ContactsPage.module.css';

const TOPICS = [
  'Оплата и возврат',
  'Ключ и активация',
  'Настройка печати',
  'Не приходит код доступа',
  'Другое',
] as const;

const schema = z.object({
  name: z.string().min(2, 'Укажите, как к вам обращаться'),
  email: z.string().email('Введите корректную почту'),
  topic: z.string().min(1, 'Выберите тему'),
  message: z.string().min(20, 'Опишите ситуацию подробнее — минимум 20 символов'),
  consent: z.boolean().refine(v => v, 'Без согласия мы не можем обработать обращение'),
  website: z.string().optional(),
});

type Values = z.infer<typeof schema>;

const REQUISITES = [
  { term: 'Исполнитель', value: 'Самозанятый Хасанов Султан Ярагиевич' },
  { term: 'ИНН', value: '200204858850' },
  { term: 'Адрес', value: 'Чеченская Республика, Ачхой-Мартановский район, село Давыденко' },
  {
    term: 'Почта для обращений',
    value: <a href="mailto:sul987@mail.ru">sul987@mail.ru</a>,
  },
  {
    term: 'Документы',
    value: (
      <>
        <a className="accent" href="/offer">
          Публичная оферта
        </a>
        {' · '}
        <a className="accent" href="/privacy">
          Политика конфиденциальности
        </a>
      </>
    ),
  },
] as const;

export function ContactsPage() {
  useDocumentMeta(
    'Контакты и поддержка',
    'Напишите нам, если нужна помощь с оплатой, ключом активации или настройкой печати. Отвечаем в течение рабочего дня.',
  );

  const toast = useToast();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { topic: TOPICS[0] },
  });

  const onSubmit = handleSubmit(async values => {
    try {
      await api<{ok:true}>('/api/support',{method:'POST',body:JSON.stringify(values)});
      toast('Обращение отправлено, ответим на указанную почту', 'success');
      reset({ name: '', email: '', topic: TOPICS[0], message: '', consent: false, website:'' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Не удалось отправить обращение', 'error');
    }
  });

  return (
    <>
      <Hero
        compact
        eyebrow="Поддержка"
        title="Контакты"
        copy="Напишите нам, если нужна помощь с оплатой, ключом или настройкой печати. Обычно отвечаем в течение рабочего дня."
        trust={[
          'Ответ в течение рабочего дня',
          'Помогаем с установкой',
          'Разбираем спорные оплаты',
        ]}
      />

      <div className="page">
        <div className={s.layout}>
          <Card>
            <h2>Написать в поддержку</h2>
            <p className="muted" style={{ fontSize: 'var(--fs-14)' }}>
              Опишите, что происходит, и приложите номер заказа или ключа, если он у вас есть — так
              разберёмся быстрее.
            </p>

            <form className="stack" onSubmit={onSubmit} noValidate>
              <div aria-hidden="true" style={{position:'absolute',left:'-10000px',width:1,height:1,overflow:'hidden'}}>
                <label>Сайт<Input tabIndex={-1} autoComplete="off" {...register('website')} /></label>
              </div>
              <div className={s.pair}>
                <Field label="Как к вам обращаться" error={errors.name?.message}>
                  <Input autoComplete="name" {...register('name')} />
                </Field>

                <Field
                  label="Электронная почта"
                  error={errors.email?.message}
                  help="На неё придёт ответ"
                >
                  <Input type="email" autoComplete="email" {...register('email')} />
                </Field>
              </div>

              <Field label="Тема обращения" error={errors.topic?.message}>
                <Select {...register('topic')}>
                  {TOPICS.map(topic => (
                    <option key={topic} value={topic}>
                      {topic}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Сообщение" error={errors.message?.message}>
                <Textarea
                  rows={6}
                  placeholder="Что произошло, какой продукт, номер заказа или ключа"
                  {...register('message')}
                />
              </Field>

              <Checkbox id="contacts-consent" {...register('consent')}>
                Согласен на обработку персональных данных в соответствии с{' '}
                <a className="accent" href="/privacy">
                  политикой конфиденциальности
                </a>
              </Checkbox>
              {errors.consent && <Alert tone="error">{errors.consent.message}</Alert>}

              <Button size="lg" loading={isSubmitting}>
                <Send size={18} />
                Отправить обращение
              </Button>
            </form>
          </Card>

          <div className="stack-lg">
            <Card>
              <div className="stack">
                <MessageCircle size={32} color="var(--accent)" />
                <h2>Telegram — самый быстрый способ</h2>
                <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
                  Пишите напрямую: поможем с установкой, активацией ключа и подключением принтера.
                </p>
                <div className="row">
                  <a href="https://t.me/roma_denosov" target="_blank" rel="noopener noreferrer">
                    <Button>Написать @roma_denosov</Button>
                  </a>
                </div>
              </div>
            </Card>

            <Card>
              <div className="stack">
                <Send size={32} color="var(--accent)" />
                <h2>Канал с обновлениями</h2>
                <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
                  Анонсы новых версий программ, изменения в правилах Wildberries и разборы частых
                  проблем.
                </p>
                <div className="row">
                  <a href="https://t.me/wbtools_ru" target="_blank" rel="noopener noreferrer">
                    <Button variant="secondary">Открыть канал</Button>
                  </a>
                </div>
              </div>
            </Card>

            <Card>
              <div className="stack">
                <Clock size={32} color="var(--accent)" />
                <h2>Когда отвечаем</h2>
                <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
                  Будни с 10:00 до 20:00 по московскому времени. Обращения по оплате разбираем в
                  первую очередь — обычно в тот же день.
                </p>
              </div>
            </Card>
          </div>
        </div>
      </div>

      <Section tone="band" eyebrow="Реквизиты" title="Кто оказывает услуги">
        <SpecList items={REQUISITES} />
      </Section>
    </>
  );
}
