const { supabaseFetch } = require('./_supabase');
const { getAuthUser } = require('./_user-auth');
const { adminError, runIdempotent, sendAdminError } = require('./_admin-grants');
const { accountMergeSummary } = require('./_telegram-account');
const identity = require('./_telegram-identity');
const userCache = require('./_telegram-user-cache');
const controls = require('./_user-controls');

/**
 * «Связать с Telegram» в админке: поддержка связывает аккаунт сайта с Telegram-ботом
 * (план «понятный бот», A1). Сам человек из бота этого больше не делает.
 *
 * GET  linkTelegramPreview?userId=<карточка>&query=<Telegram ID | @ник | почта>
 *   — кого с кем связываем, сводки обоих аккаунтов, исход и что мешает.
 * POST linkTelegram { userId: <аккаунт сайта>, telegramUserId, expected, confirmMove?, reason, idempotencyKey }
 *   — исход пересчитывается заново; не совпал с expected (что видел админ) → 409 OUTCOME_CHANGED.
 *
 * Исходы:
 *   new_identity  — у Telegram нет аккаунта: просто привязка (только если человек запускал бота —
 *                   защита от опечатки в ID);
 *   relink        — у Telegram пустой технический аккаунт: перепривязка, пустой аккаунт удаляется;
 *   merge         — технический аккаунт с данными: объединение (баланс, покупки, подписки, ПК);
 *   move_identity — Telegram привязан к другому аккаунту с почтой: переходит только привязка,
 *                   данные того аккаунта остаются при нём (отдельное подтверждение confirmMove).
 * Отказы (blockers): у аккаунта сайта другой Telegram, аккаунт сайта без подтверждённой почты,
 * аккаунт бота ограничен, облачные данные «Помощника» у аккаунта бота, партнёр у обоих, миграции нет.
 *
 * Вызывается из server/_admin-users.js (DELEGATED) после requireAdmin. Кеши бота сбрасываются
 * через server/_bot-rpc.js (узел бота — отдельный процесс), человек получает сообщение в боте.
 */

const OUTCOMES = Object.freeze(['new_identity', 'relink', 'merge', 'move_identity']);
const TELEGRAM_ID = /^\d{5,15}$/;
const USERNAME = /^@?([A-Za-z0-9_]{4,32})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function technical(email) {
  return /^telegram-[0-9]+@users[.]invalid$/i.test(String(email || ''));
}

function badRequest(res, error) {
  return res.status(400).json({ error, code: 'VALIDATION_ERROR' });
}

function cleanReason(value) {
  const reason = String(value ?? '').trim();
  if (!reason) return { error: 'Укажите причину для журнала' };
  if (reason.length > 500) return { error: 'Причина длиннее 500 символов' };
  return { value: reason };
}

function first(rows) {
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function subscriberById(telegramUserId) {
  return first(await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${encodeURIComponent(telegramUserId)}&select=telegram_user_id,username,first_name,last_name,blocked_at&limit=1`));
}

async function identityRow(telegramUserId) {
  return first(await supabaseFetch(`user_telegram_identities?telegram_user_id=eq.${encodeURIComponent(telegramUserId)}&select=user_id,telegram_user_id,username,first_name,last_name&limit=1`));
}

/** Telegram ID по @нику: сначала среди тех, кто запускал бота, потом среди привязок (вход виджетом). */
async function telegramIdByUsername(username) {
  // В ilike символ _ — подстановочный, поэтому точное совпадение проверяем ещё раз здесь.
  const exact = rows => (Array.isArray(rows) ? rows : []).filter(row => String(row.username || '').toLowerCase() === username.toLowerCase());
  const subscribers = exact(await supabaseFetch(`telegram_bot_subscribers?username=ilike.${encodeURIComponent(username)}&select=telegram_user_id,username&limit=5`));
  if (subscribers.length) return Number(subscribers[0].telegram_user_id);
  const linked = exact(await supabaseFetch(`user_telegram_identities?username=ilike.${encodeURIComponent(username)}&select=telegram_user_id,username&limit=5`));
  return linked.length ? Number(linked[0].telegram_user_id) : null;
}

async function userIdByEmail(email) {
  const id = await supabaseFetch('rpc/auth_user_id_by_email', { method: 'POST', body: JSON.stringify({ p_email: email.toLowerCase() }) });
  return typeof id === 'string' && id ? id : null;
}

/**
 * Что связываем, по карточке и строке поиска. Карточка технического аккаунта (бот) — ищем аккаунт сайта
 * по почте, Telegram берём из карточки. Карточка аккаунта сайта — ищем Telegram по ID или @нику.
 * → { targetUserId, telegramUserId }
 */
async function resolvePair(cardUserId, rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) throw adminError(400, 'VALIDATION_ERROR', 'Укажите Telegram ID, @ник или почту');
  const cardAuth = await getAuthUser(cardUserId);
  if (!cardAuth) throw adminError(404, 'NOT_FOUND', 'Пользователь не найден');
  if (technical(cardAuth.email)) {
    if (!EMAIL.test(query)) throw adminError(400, 'VALIDATION_ERROR', 'Это аккаунт бота — укажите почту аккаунта сайта, с которым объединить');
    const own = first(await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(cardUserId)}&select=telegram_user_id&limit=1`));
    if (!own) throw adminError(409, 'NO_TELEGRAM', 'У этого аккаунта нет привязанного Telegram — объединять нечего');
    const targetUserId = await userIdByEmail(query);
    if (!targetUserId) throw adminError(404, 'NOT_FOUND', 'Аккаунт с такой почтой не найден');
    return { targetUserId, telegramUserId: Number(own.telegram_user_id) };
  }
  if (EMAIL.test(query)) throw adminError(400, 'VALIDATION_ERROR', 'Укажите Telegram ID или @ник — почта у этого аккаунта уже есть');
  if (TELEGRAM_ID.test(query)) return { targetUserId: cardUserId, telegramUserId: Number(query) };
  const nick = USERNAME.exec(query);
  if (!nick) throw adminError(400, 'VALIDATION_ERROR', 'Telegram ID — только цифры, ник — латиница, цифры и _');
  const telegramUserId = await telegramIdByUsername(nick[1]);
  if (!telegramUserId) throw adminError(404, 'NOT_FOUND', `@${nick[1]} не запускал бота и не входил через Telegram — попросите Telegram ID`);
  return { targetUserId: cardUserId, telegramUserId };
}

function accountView(userId, auth, summary) {
  return {
    userId,
    email: auth && !technical(auth.email) ? auth.email || null : null,
    technical: technical(auth?.email),
    emailConfirmed: Boolean(auth?.email_confirmed_at),
    createdAt: auth?.created_at || null,
    summary: summary || null,
  };
}

function label(row) {
  if (!row) return null;
  return row.username ? `@${row.username}` : row.first_name || String(row.telegram_user_id || '');
}

/** Есть ли в сводке хоть что-то, что видно человеку (для строки «что перейдёт»). */
function sourceHighlights(summary) {
  if (!summary) return [];
  const out = [];
  if (Number(summary.walletKopecks) > 0) out.push(`баланс ${(Number(summary.walletKopecks) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`);
  if (Number(summary.activeSubscriptions) > 0) out.push('действующая подписка «Помощника»');
  if (Number(summary.paidOrders) > 0) out.push(`оплаченных заказов: ${summary.paidOrders}`);
  if (Number(summary.stickersLeft) > 0) out.push(`стикеров в пакетах: ${summary.stickersLeft}`);
  if (Number(summary.devices) + Number(summary.cellPrintDevices) > 0) out.push(`ПК: ${Number(summary.devices) + Number(summary.cellPrintDevices)}`);
  if (Number(summary.licenseKeys) + Number(summary.cellPrintLicenses) > 0) out.push(`ключей: ${Number(summary.licenseKeys) + Number(summary.cellPrintLicenses)}`);
  return out;
}

/**
 * Исход связки аккаунта сайта targetUserId с Telegram telegramUserId — общий для предпросмотра и действия.
 * → { outcome, blockers: [{code, message}], warnings: [string], target, source, telegram, needsMoveConfirm }
 * outcome === 'already_linked' — делать нечего (тоже в blockers).
 */
async function computeLink(targetUserId, telegramUserId) {
  const [targetAuth, targetIdentity, sourceIdentity, subscriber, targetSummary] = await Promise.all([
    getAuthUser(targetUserId),
    identity.identityForUser(targetUserId),
    identityRow(telegramUserId),
    subscriberById(telegramUserId).catch(() => null),
    accountMergeSummary(targetUserId).catch(() => null),
  ]);
  if (!targetAuth) throw adminError(404, 'NOT_FOUND', 'Аккаунт сайта не найден');
  const blockers = [];
  const warnings = [];
  const block = (code, message) => blockers.push({ code, message });
  const telegram = {
    telegramUserId,
    username: subscriber?.username || sourceIdentity?.username || null,
    firstName: subscriber?.first_name || sourceIdentity?.first_name || null,
    lastName: subscriber?.last_name || sourceIdentity?.last_name || null,
    botStarted: Boolean(subscriber),
    botBlocked: Boolean(subscriber?.blocked_at),
  };
  const target = accountView(targetUserId, targetAuth, targetSummary);
  let source = null;
  let outcome;

  if (sourceIdentity && sourceIdentity.user_id === targetUserId) {
    return { outcome: 'already_linked', blockers: [{ code: 'ALREADY_LINKED', message: 'Этот Telegram уже привязан к этому аккаунту' }], warnings, target, source, telegram, needsMoveConfirm: false };
  }
  if (targetIdentity && Number(targetIdentity.telegram_user_id) !== Number(telegramUserId)) {
    block('TARGET_HAS_TELEGRAM', `К аккаунту сайта уже привязан другой Telegram (${label(targetIdentity)}) — сначала отвяжите его`);
  }
  if (technical(targetAuth.email)) {
    block('TARGET_NOT_SITE', 'Это аккаунт бота без почты — связывать можно только с аккаунтом сайта');
  } else if (!targetAuth.email || !targetAuth.email_confirmed_at) {
    block('TARGET_NOT_CONFIRMED', 'У аккаунта сайта не подтверждена почта — сначала пусть подтвердит её');
  }

  if (!sourceIdentity) {
    outcome = 'new_identity';
    if (!subscriber) block('NOT_STARTED', 'Этот Telegram не запускал бота — проверьте ID (защита от опечатки)');
  } else {
    const [sourceAuth, sourceSummary] = await Promise.all([
      getAuthUser(sourceIdentity.user_id),
      accountMergeSummary(sourceIdentity.user_id),
    ]);
    source = accountView(sourceIdentity.user_id, sourceAuth, sourceSummary);
    if (!sourceSummary || typeof sourceSummary.empty !== 'boolean') {
      block('MIGRATION_MISSING', 'В базе нет сводки аккаунта — примените миграцию 20261120_account_merge_full.sql');
      outcome = technical(sourceAuth?.email) ? 'merge' : 'move_identity';
    } else {
      if (sourceSummary.restricted) block('SOURCE_RESTRICTED', 'Аккаунт бота ограничен — сначала снимите ограничение в его карточке');
      if (!technical(sourceAuth?.email)) {
        outcome = 'move_identity';
        warnings.push(`Telegram привязан к другому аккаунту с почтой ${sourceAuth?.email || '—'}: перейдёт только привязка Telegram, данные того аккаунта останутся при нём`);
      } else if (sourceSummary.empty) {
        outcome = 'relink';
      } else {
        outcome = 'merge';
        if (Number(sourceSummary.points) > 0 || Number(sourceSummary.docs) > 0) {
          block('MERGE_CLOUD_DATA', 'У аккаунта бота есть облачные данные «Помощника» (пункты или документы) — они зашифрованы ключом аккаунта, перенести нельзя. Пусть сначала отключит пункты в программе');
        }
        if (sourceSummary.partner && targetSummary?.partner) block('MERGE_PARTNER_CONFLICT', 'Оба аккаунта — партнёры, объединить нельзя');
        if (Number(sourceSummary.generationReserved) > 0 && Number(targetSummary?.generationReserved) > 0) {
          block('MERGE_BUSY', 'В обоих аккаунтах сейчас создаются стикеры — повторите через минуту');
        }
        const moved = sourceHighlights(sourceSummary);
        if (moved.length) warnings.push(`К аккаунту сайта перейдёт: ${moved.join(', ')}`);
      }
    }
  }
  if (!telegram.botStarted && outcome !== 'new_identity') warnings.push('Человек не запускал бота — сообщение о связке не придёт');
  if (telegram.botBlocked) warnings.push('Бот заблокирован пользователем — сообщение о связке не придёт');
  return { outcome, blockers, warnings, target, source, telegram, needsMoveConfirm: outcome === 'move_identity' };
}

async function linkTelegramPreview(req, res, { userId }) {
  try {
    const pair = await resolvePair(userId, req.query?.query);
    const preview = await computeLink(pair.targetUserId, pair.telegramUserId);
    return res.json({ ...preview, request: { userId: pair.targetUserId, telegramUserId: pair.telegramUserId } });
  } catch (error) {
    return sendAdminError(res, error);
  }
}

/** Ошибка RPC связки → понятный отказ админке (409 с кодом). Прочее летит дальше (502). */
function rpcRefusal(error) {
  const text = String(error?.message || '');
  const known = [
    ['TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED', 'SOURCE_RESTRICTED', 'Аккаунт бота ограничен — сначала снимите ограничение'],
    ['TELEGRAM_ACCOUNT_NOT_EMPTY', 'OUTCOME_CHANGED', 'В аккаунте бота появились данные — откройте предпросмотр заново'],
    ['TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT', 'TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT', 'Реферальные деньги или выплаты мешают объединению — нужна ручная сверка'],
    ['TARGET_ACCOUNT_HAS_TELEGRAM', 'TARGET_HAS_TELEGRAM', 'К аккаунту сайта уже привязан другой Telegram — сначала отвяжите его'],
    ['SOURCE_ACCOUNT_NOT_TECHNICAL', 'OUTCOME_CHANGED', 'Аккаунт бота изменился — откройте предпросмотр заново'],
    ['TARGET_ACCOUNT_', 'TARGET_NOT_CONFIRMED', 'У аккаунта сайта нет подтверждённой почты'],
    ['MERGE_POINT_CONFLICT', 'MERGE_POINT_CONFLICT', 'Один и тот же пункт WB подключён в обоих аккаунтах — пусть отключит его в одном из них'],
    ['MERGE_CLOUD_DATA', 'MERGE_CLOUD_DATA', 'У аккаунта бота есть облачные данные «Помощника» — объединить нельзя без их переноса'],
    ['MERGE_BUSY', 'MERGE_BUSY', 'В аккаунтах сейчас создаются стикеры — повторите через минуту'],
    ['MERGE_PARTNER_CONFLICT', 'MERGE_PARTNER_CONFLICT', 'Оба аккаунта — партнёры, объединить нельзя'],
  ];
  const hit = known.find(([needle]) => text.includes(needle));
  return hit ? adminError(409, hit[1], hit[2]) : null;
}

/** Сбросить связку и снимки на сайте и на узле бота; ошибки только в лог. */
async function resetCaches(telegramUserId, userIds) {
  const rpc = require('./_bot-rpc');
  userCache.forgetTelegramUser(telegramUserId);
  for (const id of userIds) userCache.forgetSiteUser(id);
  try { controls.invalidate(); } catch (error) { console.error('user controls invalidate failed', error.message); }
  const calls = [
    ['forgetTelegramUser', telegramUserId],
    ...userIds.map(id => ['forgetSiteUser', id]),
    ['invalidateUserControls'],
  ];
  for (const [fn, ...args] of calls) {
    await rpc.callBot(fn, ...args).catch(error => console.warn(`bot ${fn} after linkTelegram failed`, error.message));
  }
}

async function linkTelegram(req, res, { userId }) {
  const body = req.body || {};
  const telegramUserId = Number(body.telegramUserId);
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return badRequest(res, 'Некорректный Telegram ID');
  const expected = String(body.expected || '');
  if (!OUTCOMES.includes(expected)) return badRequest(res, 'Нет исхода предпросмотра — откройте предпросмотр заново');
  const reason = cleanReason(body.reason);
  if (reason.error) return badRequest(res, reason.error);
  const confirmMove = body.confirmMove === true;
  return runIdempotent(req, res, {
    action: 'linkTelegram', key: body.idempotencyKey, userId,
    payload: { telegramUserId, expected, confirmMove }, reason: reason.value,
  }, async () => {
    const preview = await computeLink(userId, telegramUserId);
    if (preview.outcome !== expected) {
      throw adminError(409, 'OUTCOME_CHANGED', 'Состояние аккаунтов изменилось — откройте предпросмотр заново', { outcome: preview.outcome });
    }
    if (preview.blockers.length) throw adminError(409, preview.blockers[0].code, preview.blockers[0].message);
    if (preview.needsMoveConfirm && !confirmMove) {
      throw adminError(409, 'CONFIRM_REQUIRED', 'Подтвердите перенос привязки с аккаунта с почтой');
    }
    const telegram = {
      id: telegramUserId, username: preview.telegram.username,
      first_name: preview.telegram.firstName || '', last_name: preview.telegram.lastName,
    };
    let rpcResult = {};
    try {
      if (expected === 'new_identity') await identity.saveIdentity(userId, telegram);
      else if (expected === 'merge') rpcResult = await identity.mergeTelegramAccount(userId, telegram);
      else rpcResult = await identity.relinkIdentity(userId, telegram);
    } catch (error) {
      throw rpcRefusal(error) || error;
    }
    const sourceUserId = preview.source?.userId || null;
    await resetCaches(telegramUserId, [userId, ...(sourceUserId ? [sourceUserId] : [])]);
    const notified = await require('./_bot-rpc').callBot('notifyAccountLinked', telegramUserId)
      .catch(error => { console.warn('notifyAccountLinked failed', error.message); return null; });
    const delivered = notified?.delivered === true;
    const sourceKept = rpcResult?.sourceKept === true;
    const moved = {
      walletKopecks: Number(rpcResult?.movedWalletKopecks || 0),
      subscriptions: Number(rpcResult?.movedSubscriptions || 0),
      devices: Number(rpcResult?.movedDevices || 0),
    };
    const warnings = [];
    if (sourceKept) warnings.push('Аккаунт бота не удалён: на нём появились данные во время связки. Проверьте его и перенесите остаток вручную');
    if (!delivered) warnings.push('Связано, но сообщение в бот не доставлено');
    const responseBody = {
      ok: true, outcome: expected, telegramUserId, sourceUserId,
      sourceDeleted: Boolean(sourceUserId) && rpcResult?.deleteSource === true && !sourceKept,
      ...(sourceKept ? { sourceKept: true } : {}),
      moved, delivered,
      ...(warnings.length ? { warning: warnings.join('. ') } : {}),
    };
    return {
      status: 200,
      body: responseBody,
      result: sourceKept ? 'partial' : 'ok',
      before: {
        outcome: preview.outcome, telegram: preview.telegram, target: preview.target, source: preview.source,
        warnings: preview.warnings,
      },
      after: { telegramUserId, linkedTo: userId, rpc: rpcResult || {}, delivered },
      reason: reason.value,
    };
  });
}

module.exports = { OUTCOMES, computeLink, linkTelegram, linkTelegramPreview, resolvePair, rpcRefusal };
