import { useState } from 'react';
import { KeyRound, LogOut, Package, Settings, TriangleAlert } from 'lucide-react';
import {
  Accordion,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  Modal,
  Pagination,
  PriceTable,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Spinner,
  Stat,
  Switch,
  Table,
  Tabs,
  Textarea,
  useToast,
} from '../ui';

export function UiInventoryPage() {
  const [modal, setModal] = useState(false);
  const [seg, setSeg] = useState<'product' | 'box'>('product');
  const [page, setPage] = useState(2);
  const toast = useToast();

  return (
    <div className="page">
      <header className="page-head">
        <h1>UI-инвентарь</h1>
        <p>Базовые React-компоненты и обязательные состояния дизайн-системы.</p>
      </header>

      <div className="stack-lg">
        <Card>
          <h2>Кнопки</h2>
          <div className="row">
            <Button>Основная</Button>
            <Button variant="secondary">Вторичная</Button>
            <Button variant="ghost">Текстовая</Button>
            <Button variant="danger">Опасная</Button>
            <Button disabled>Отключена</Button>
            <Button loading>Загрузка</Button>
          </div>
          <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
            <Button size="sm">Маленькая</Button>
            <Button>Обычная</Button>
            <Button size="lg">Большая</Button>
            <Spinner />
          </div>
        </Card>

        <Card>
          <h2>Статусы</h2>
          <div className="row">
            <Badge tone="success">Активен</Badge>
            <Badge tone="warning">Истекает через 3 дня</Badge>
            <Badge tone="error">Списание не прошло</Badge>
            <Badge tone="accent">Новинка</Badge>
            <Badge>Скоро</Badge>
          </div>
        </Card>

        <Card>
          <h2>Переключатель</h2>
          <div style={{ maxWidth: 360 }}>
            <Segmented
              label="Тип стикера"
              value={seg}
              onChange={setSeg}
              options={[
                { value: 'product', label: 'Товары' },
                { value: 'box', label: 'QR коробок' },
              ]}
            />
          </div>
        </Card>

        <Card>
          <h2>Вкладки</h2>
          <Tabs
            label="Пример вкладок"
            items={[
              {
                value: 'one',
                label: 'Первая',
                content: <p className="muted">Содержимое первой вкладки.</p>,
              },
              {
                value: 'two',
                label: 'Вторая',
                content: <p className="muted">Содержимое второй вкладки.</p>,
              },
              {
                value: 'three',
                label: 'Третья',
                content: <p className="muted">Содержимое третьей вкладки.</p>,
              },
            ]}
          />
        </Card>

        <Card>
          <h2>Аккордеон</h2>
          <Accordion
            items={[
              { q: 'Первый вопрос', a: 'Ответ на первый вопрос.' },
              { q: 'Второй вопрос', a: 'Ответ на второй вопрос.' },
            ]}
          />
        </Card>

        <div className="grid grid-2">
          <Card>
            <h2>Прогресс</h2>
            <div className="stack">
              <Progress value={30} max={100} label={<span>Обычный — 30%</span>} />
              <Progress value={85} max={100} label={<span>Предупреждение — 85%</span>} />
              <Progress value={100} max={100} label={<span>Исчерпано — 100%</span>} />
            </div>
          </Card>

          <Card>
            <h2>Тумблеры</h2>
            <div className="stack">
              <Switch defaultChecked description="Письмо за три дня до окончания">
                Истечение ключей
              </Switch>
              <hr className="divider" />
              <Switch description="Новые версии программ">Новости продуктов</Switch>
            </div>
          </Card>
        </div>

        <Card>
          <h2>Меню и аватар</h2>
          <div className="row">
            <Avatar name="demo@shk-wb.ru" />
            <Menu
              label="Демонстрационное меню"
              trigger={() => (
                <>
                  <Avatar name="demo@shk-wb.ru" size={28} />
                  demo@shk-wb.ru
                </>
              )}
            >
              {close => (
                <>
                  <MenuLabel>demo@shk-wb.ru</MenuLabel>
                  <MenuItem onClick={close}>
                    <Settings size={16} />
                    Настройки
                  </MenuItem>
                  <MenuItem danger onClick={close}>
                    <LogOut size={16} />
                    Выйти
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </Card>

        <Card>
          <h2>Таблица цен</h2>
          <PriceTable
            caption="Нажмите на цену, чтобы выбрать тариф"
            head={['1 компьютер', '2 компьютера', '3 компьютера']}
            rows={[
              {
                label: '1 неделя',
                cells: [
                  { label: '50 ₽', onSelect: () => toast('Выбран тариф 7 дней · 1 ПК') },
                  {
                    label: '85 ₽',
                    active: true,
                    onSelect: () => toast('Выбран тариф 7 дней · 2 ПК'),
                  },
                  { label: '115 ₽', onSelect: () => toast('Выбран тариф 7 дней · 3 ПК') },
                ],
              },
              {
                label: '1 месяц',
                cells: [
                  { label: '150 ₽', onSelect: () => toast('Выбран тариф 30 дней · 1 ПК') },
                  { label: '255 ₽', onSelect: () => toast('Выбран тариф 30 дней · 2 ПК') },
                  { label: '345 ₽', onSelect: () => toast('Выбран тариф 30 дней · 3 ПК') },
                ],
              },
            ]}
          />
        </Card>

        <Card>
          <h2>Сообщения</h2>
          <div className="stack">
            <Alert tone="info">Информационное сообщение о состоянии сервиса.</Alert>
            <Alert tone="success">Ключ успешно активирован.</Alert>
            <Alert tone="warning">Ключ истекает через 3 дня.</Alert>
            <Alert tone="error">Не удалось создать платёж. Попробуйте ещё раз.</Alert>
          </div>
        </Card>

        <Card>
          <h2>Метрики</h2>
          <div className="grid grid-3">
            <Stat value="2" label="активных ключа" icon={<KeyRound size={20} />} />
            <Stat value="62" label="стикеров осталось" icon={<Package size={20} />} />
            <Stat value="1" label="требует внимания" icon={<TriangleAlert size={20} />} />
          </div>
        </Card>

        <Card>
          <h2>Поля и формы</h2>
          <div className="grid grid-2">
            <Field label="Обычное поле" help="Пояснение под полем">
              <Input placeholder="Введите значение" />
            </Field>
            <Field label="Поле с ошибкой" error="Проверьте введённое значение">
              <Input defaultValue="12ab" />
            </Field>
            <Field label="Выбор">
              <Select>
                <option>Первый вариант</option>
                <option>Второй вариант</option>
              </Select>
            </Field>
            <Field label="Комментарий">
              <Textarea />
            </Field>
          </div>
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Checkbox>
              Я принимаю <a href="/offer">условия оферты</a>
            </Checkbox>
          </div>
        </Card>

        <Card>
          <h2>Таблица</h2>
          <Table>
            <thead>
              <tr>
                <th>Ключ</th>
                <th>Статус</th>
                <th>Окончание</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">CP-774B-3D55-AE5B</td>
                <td>
                  <Badge tone="warning">Истекает</Badge>
                </td>
                <td>26.09.2026</td>
              </tr>
              <tr>
                <td className="mono">CP-EA92-9F07-B789</td>
                <td>
                  <Badge tone="success">Активен</Badge>
                </td>
                <td>03.10.2026</td>
              </tr>
            </tbody>
          </Table>
          <Pagination page={page} pages={4} onChange={setPage} />
        </Card>

        <div className="grid grid-2">
          <Card>
            <h2>Загрузка</h2>
            <div className="stack">
              <Skeleton />
              <Skeleton width="70%" />
              <Skeleton width="45%" />
            </div>
          </Card>
          <Card>
            <EmptyState />
          </Card>
        </div>

        <Card>
          <h2>Оверлеи</h2>
          <div className="row">
            <Button onClick={() => setModal(true)}>Открыть диалог</Button>
            <Button variant="secondary" onClick={() => toast('Изменения сохранены', 'success')}>
              Уведомление — успех
            </Button>
            <Button variant="secondary" onClick={() => toast('Не удалось сохранить', 'error')}>
              Уведомление — ошибка
            </Button>
          </div>
        </Card>
      </div>

      <Modal
        open={modal}
        onOpenChange={setModal}
        title="Доступный диалог"
        description="Фокус, Escape и клавиатурная навигация управляются Radix UI."
      >
        <Button onClick={() => setModal(false)}>Понятно</Button>
      </Modal>
    </div>
  );
}
