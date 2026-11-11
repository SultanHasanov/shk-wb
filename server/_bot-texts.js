// Общие тексты и числа для сообщений в Telegram, которые шлёт не только бот, но и сайт (оплаты, админка).
// Одно событие — один текст: начисление от поддержки (/bonus в боте и «Кошелёк» в админке), вознаграждение
// за приглашение (вебхук оплаты). Без зависимостей: модуль подключают _payments.js и _admin-*.js, а _wallet.js
// сам зависит от _payments.js — отсюда его не берём.

// Личка поддержки — кнопки «Написать в поддержку» в боте и под сообщениями из админки.
const SUPPORT_URL = 'https://t.me/roma_denosov';

// Приглашения: доля с каждой оплаты приглашённого = award_referral_order (0.10) в SQL — менять вместе.
const REFERRAL_PERCENT = 10;
// Минимум вывода вознаграждения на карту = WithdrawalInput в api/cabinet.js (50 000 коп.) — менять вместе.
const REFERRAL_WITHDRAW_MIN_RUB = 500;

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 1234.5 → «1 234,50 ₽» (как formatRub в _wallet.js). */
function rub(value) {
  const amount = Number(value) || 0;
  return `${amount.toLocaleString('ru-RU', { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
}

// Кнопки под сообщением о деньгах от поддержки: баланс тратится в боте — без ссылок на сайт.
const MONEY_KEYBOARD = Object.freeze([[{ text: '👤 Профиль', callback_data: 'menu:profile' }, { text: '☰ Меню', callback_data: 'menu:home' }]]);

/**
 * Начисление или списание поддержкой (обычный текст, без HTML): { subject, body }.
 * kopecks > 0 — начисление, < 0 — списание; note — причина (необязательна); balanceKopecks — баланс после.
 * В Telegram это <b>subject</b>, пустая строка, body — так собирают и deliverTelegram, и bonusNoticeText.
 */
function supportMoneyNotice({ kopecks, note, balanceKopecks }) {
  const credit = Number(kopecks) > 0;
  const amount = rub(Math.abs(Number(kopecks) || 0) / 100);
  const reason = String(note || '').trim();
  return {
    subject: credit ? `🎁 Поддержка начислила вам ${amount}` : `С баланса списано ${amount}`,
    body: [
      ...(reason ? [`Причина: ${reason}`] : []),
      `💰 На балансе: ${rub(Number(balanceKopecks || 0) / 100)}`,
      ...(credit ? [] : ['Есть вопросы — напишите в поддержку.']),
    ].join('\n'),
  };
}

/** То же сообщение готовым HTML для sendMessage. */
function supportMoneyNoticeHtml(input) {
  const { subject, body } = supportMoneyNotice(input);
  return `<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(body)}`;
}

/**
 * Пригласившему после оплаты приглашённого (HTML). availableKopecks — сколько можно забрать сейчас
 * (null — не прочиталось, строку не пишем). «Сделал оплату», а не «пополнил»: вознаграждение — с любой оплаты
 * картой, в том числе на сайте.
 */
function referralRewardHtml({ rewardKopecks, availableKopecks = null }) {
  return [
    `<b>💸 +${rub(Number(rewardKopecks || 0) / 100)} за приглашение</b>`,
    `Коллега, которого вы пригласили, сделал оплату — вам ${REFERRAL_PERCENT}%.`,
    ...(availableKopecks == null ? [] : [`Можно забрать: <b>${rub(Number(availableKopecks) / 100)}</b> — на баланс бота или на карту (от ${rub(REFERRAL_WITHDRAW_MIN_RUB)}).`]),
  ].join('\n');
}

const REFERRAL_KEYBOARD = Object.freeze([[{ text: '👥 Пригласить коллегу', callback_data: 'menu:ref' }]]);

module.exports = {
  MONEY_KEYBOARD, REFERRAL_KEYBOARD, REFERRAL_PERCENT, REFERRAL_WITHDRAW_MIN_RUB, SUPPORT_URL,
  referralRewardHtml, supportMoneyNotice, supportMoneyNoticeHtml,
};
