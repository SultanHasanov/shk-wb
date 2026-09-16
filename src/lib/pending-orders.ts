type WritableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Токены заказов, оплаченных без входа в аккаунт.
 *
 *  У анонимной покупки нет ни почты, ни пользователя, поэтому единственная
 *  ниточка от неё к будущему кабинету остаётся в браузере покупателя. Кода
 *  доступа для этого мало: он появляется только на странице результата оплаты,
 *  а её можно закрыть или не дождаться. Токен же известен раньше — в момент
 *  ухода на ЮKassa, — и по нему кабинет забирает и заказ, и выданный им код.
 */
const PENDING_ORDERS_KEY = 'pending_order_tokens_v1';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,100}$/;
/** Больше двух десятков незабранных заказов у одного браузера не бывает. */
const LIMIT = 20;

export function readPendingOrders(storage: WritableStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PENDING_ORDERS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(parsed.map(value => String(value ?? '')).filter(value => TOKEN_PATTERN.test(value))),
    ].slice(-LIMIT);
  } catch {
    return [];
  }
}

function write(storage: WritableStorage, tokens: string[]): void {
  try {
    if (tokens.length) storage.setItem(PENDING_ORDERS_KEY, JSON.stringify(tokens));
    else storage.removeItem(PENDING_ORDERS_KEY);
  } catch {
    // Запрет на хранение не должен ломать оплату: покупка и без записи пройдёт.
  }
}

export function rememberPendingOrder(storage: WritableStorage, token: string): void {
  if (!TOKEN_PATTERN.test(token)) return;
  write(storage, [...readPendingOrders(storage).filter(value => value !== token), token].slice(-LIMIT));
}

export function forgetPendingOrder(storage: WritableStorage, token: string): void {
  const current = readPendingOrders(storage);
  const rest = current.filter(value => value !== token);
  if (rest.length !== current.length) write(storage, rest);
}
