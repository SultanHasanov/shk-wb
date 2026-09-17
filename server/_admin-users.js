const crypto = require('crypto');
const { sendApiError, supabaseFetch } = require('./_supabase');
const { deleteAuthUser, getAuthUser } = require('./_user-auth');
const { createNotification } = require('./_notifications');
const {
  RESOURCES, addStickerGenerations, checkCellLicensePatch, checkStickerAccessPatch,
  createCellLicense, createProgramKey, createStickerAccessCode, isUuid, recordAdminAction,
} = require('./_admin-grants');

/**
 * Раздел «Пользователи» админки.
 *
 * Вызывается из api/admin/data.js ПОСЛЕ requireAdmin — своей проверки прав здесь
 * нет намеренно, чтобы не было второго места, где её можно забыть обновить.
 * Отдельным файлом в api/ этот раздел быть не может: там уже 12 функций, это
 * потолок тарифа Vercel.
 *
 * Список и сводка идут одним RPC каждый: auth.users из схемы public не читается,
 * а Auth Admin REST не умеет ни искать по телефону или коду доступа, ни
 * сортировать по выручке — пришлось бы выкачивать всех пользователей на каждый
 * показ страницы.
 */

const SORTS = ['created_at', 'last_sign_in_at', 'revenue', 'generation_used'];
const FILTERS = ['all', 'paying', 'free', 'telegram', 'banned', 'inactive'];
/** Бан длиной в сто лет: GoTrue умеет только срок, «навсегда» у него нет. */
const BAN_FOREVER = '876000h';

function badRequest(res, error) {
  return res.status(400).json({ error });
}

function authConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) throw new Error('Supabase auth environment variables are not configured');
  return { url, serviceKey };
}

/** Бан и разбан в GoTrue — это PUT с ban_duration, отдельных ручек нет. */
async function setAuthBan(userId, banned) {
  const { url, serviceKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ban_duration: banned ? BAN_FOREVER : 'none' }),
  });
  if (!response.ok) throw new Error('Unable to update ban state');
}

/** Ручная выдача должна выглядеть для клиента так же, как покупка. */
async function notifyUser(userId, title, body, link = '/cabinet/packages') {
  try {
    const user = await getAuthUser(userId);
    await createNotification({
      userId, kind: 'system', title, body, link,
      dedupeKey: `admin:${crypto.randomUUID()}`,
      email: user?.email?.endsWith('@users.invalid') ? null : user?.email,
    });
  } catch (error) {
    console.error('admin notification failed', error.message);
  }
}

async function listUsers(req, res) {
  const page = Math.max(0, Number.parseInt(req.query.page || '0', 10) || 0);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize || '25', 10) || 25));
  const sort = SORTS.includes(String(req.query.sort)) ? String(req.query.sort) : 'created_at';
  const filter = FILTERS.includes(String(req.query.filter)) ? String(req.query.filter) : 'all';
  const rows = await supabaseFetch('rpc/admin_user_directory', {
    method: 'POST',
    body: JSON.stringify({
      p_search: String(req.query.q || '').slice(0, 120),
      p_limit: pageSize,
      p_offset: page * pageSize,
      p_sort: sort,
      p_filter: filter,
    }),
  });
  const items = (rows || []).map(row => ({
    userId: row.user_id,
    email: row.email,
    emailConfirmed: row.email_confirmed,
    telegramOnly: row.telegram_only,
    banned: row.banned,
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at,
    displayName: row.display_name,
    phone: row.phone,
    payerStatus: row.payer_status,
    telegramUsername: row.telegram_username,
    codes: Number(row.codes_count || 0),
    generationLimit: Number(row.generation_limit || 0),
    generationUsed: Number(row.generation_used || 0),
    programKeys: Number(row.program_keys || 0),
    cellLicenses: Number(row.cell_licenses || 0),
    cellActive: Number(row.cell_active || 0),
    ordersPaid: Number(row.orders_paid || 0),
    revenueKopecks: Number(row.revenue_kopecks || 0),
    refundedKopecks: Number(row.refunded_kopecks || 0),
    lastOrderAt: row.last_order_at,
    referralCode: row.referral_code,
    referralEarnedKopecks: Number(row.referral_earned || 0),
    referralAvailableKopecks: Number(row.referral_available || 0),
    invited: Number(row.invited_count || 0),
  }));
  return res.json({ items, total: Number(rows?.[0]?.total_count || 0), page, pageSize, sort, filter });
}

async function userDetail(req, res, userId) {
  const q = encodeURIComponent(userId);
  const [authUser, profiles, preferences, telegram, codes, programKeys, cellLicenses, orders, referral, attributions, notifications, historyCount, actions] = await Promise.all([
    getAuthUser(userId),
    supabaseFetch(`user_profiles?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`user_preferences?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`user_telegram_identities?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${q}&select=*&order=created_at.desc`),
    supabaseFetch(`license_keys?owner_user_id=eq.${q}&select=*&order=created_at.desc`),
    supabaseFetch(`cell_print_licenses?owner_user_id=eq.${q}&select=*&order=created_at.desc`),
    supabaseFetch(`payment_orders?user_id=eq.${q}&select=*&order=created_at.desc&limit=50`),
    supabaseFetch(`referral_accounts?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`referral_attributions?referrer_user_id=eq.${q}&select=invited_user_id,attributed_at&order=attributed_at.desc&limit=100`),
    supabaseFetch(`in_app_notifications?user_id=eq.${q}&select=id,kind,title,created_at,read_at&order=created_at.desc&limit=20`),
    supabaseFetch(`user_generation_history?user_id=eq.${q}&select=id&limit=1000`),
    supabaseFetch(`admin_actions?target_user_id=eq.${q}&select=*&order=created_at.desc&limit=50`),
  ]);
  if (!authUser) return res.status(404).json({ error: 'Пользователь не найден' });
  const licenseIds = cellLicenses.map(row => row.id);
  const activations = licenseIds.length
    ? await supabaseFetch(`cell_print_activations?license_id=in.(${licenseIds.join(',')})&select=*&order=last_seen_at.desc`)
    : [];
  const invitedIds = attributions.map(row => row.invited_user_id);
  const invitedFilter = invitedIds.length ? `(${invitedIds.map(encodeURIComponent).join(',')})` : '';
  const [referralProfiles, referralOrders, referralLedger] = await Promise.all([
    invitedIds.length
      ? supabaseFetch(`user_profiles?user_id=in.${invitedFilter}&select=user_id,display_name,phone&limit=100`)
      : [],
    invitedIds.length
      ? supabaseFetch(`payment_orders?user_id=in.${invitedFilter}&select=id,user_id,status,product_kind,amount,gross_amount,refunded_kopecks,created_at,paid_at&order=created_at.desc&limit=5000`)
      : [],
    supabaseFetch(`referral_ledger?user_id=eq.${q}&kind=in.(reward,reversal)&select=kind,amount_kopecks,order_id,created_at&order=created_at.asc&limit=5000`),
  ]);
  const referralAuthUsers = [];
  for (let index = 0; index < invitedIds.length; index += 10) {
    referralAuthUsers.push(...await Promise.all(invitedIds.slice(index, index + 10).map(getAuthUser)));
  }
  const referralProfileById = new Map(referralProfiles.map(row => [row.user_id, row]));
  const referralAuthById = new Map(referralAuthUsers.filter(Boolean).map(row => [row.id, row]));
  const referredUsers = attributions.map(attribution => {
    const invitedUserId = attribution.invited_user_id;
    const invitedOrders = referralOrders.filter(row => row.user_id === invitedUserId);
    const orderIds = new Set(invitedOrders.map(row => row.id));
    const rewards = referralLedger.filter(row => orderIds.has(row.order_id));
    const auth = referralAuthById.get(invitedUserId);
    const profile = referralProfileById.get(invitedUserId);
    return {
      userId: invitedUserId,
      email: auth?.email?.endsWith('@users.invalid') ? null : auth?.email || null,
      displayName: profile?.display_name || auth?.user_metadata?.full_name || auth?.user_metadata?.username || null,
      phone: profile?.phone || auth?.phone || null,
      registeredAt: auth?.created_at || null,
      attributedAt: attribution.attributed_at,
      paidOrders: invitedOrders.filter(row => row.status === 'succeeded').length,
      paidKopecks: invitedOrders.filter(row => row.status === 'succeeded').reduce((sum, row) => sum + Math.round(Number(row.amount || 0) * 100), 0),
      refundedKopecks: invitedOrders.reduce((sum, row) => sum + Number(row.refunded_kopecks || 0), 0),
      rewardedKopecks: rewards.filter(row => row.kind === 'reward').reduce((sum, row) => sum + Number(row.amount_kopecks || 0), 0),
      reversedKopecks: -rewards.filter(row => row.kind === 'reversal').reduce((sum, row) => sum + Number(row.amount_kopecks || 0), 0),
      earnedKopecks: rewards.reduce((sum, row) => sum + Number(row.amount_kopecks || 0), 0),
      orders: invitedOrders.map(row => ({
        id: row.id,
        status: row.status,
        productKind: row.product_kind,
        amountKopecks: Math.round(Number(row.amount || 0) * 100),
        grossKopecks: Math.round(Number(row.gross_amount ?? row.amount ?? 0) * 100),
        refundedKopecks: Number(row.refunded_kopecks || 0),
        createdAt: row.created_at,
        paidAt: row.paid_at,
      })),
    };
  });
  const account = referral[0] || {};
  return res.json({
    userId,
    email: authUser.email?.endsWith('@users.invalid') ? null : authUser.email || null,
    telegramOnly: Boolean(authUser.email?.endsWith('@users.invalid')),
    emailConfirmed: Boolean(authUser.email_confirmed_at),
    banned: Boolean(authUser.banned_until && Date.parse(authUser.banned_until) > Date.now()),
    createdAt: authUser.created_at,
    lastSignInAt: authUser.last_sign_in_at || null,
    // Подтверждение удаления сверяется с этим значением, поэтому отдаём и
    // техническую почту telegram-аккаунта, у которой нет публичного вида.
    confirmValue: authUser.email || userId,
    profile: profiles[0] || null,
    preferences: preferences[0] || null,
    telegram: telegram[0] || null,
    codes: codes.map(RESOURCES.stickerAccess.fromDb),
    programKeys: programKeys.map(RESOURCES.key.fromDb),
    cellLicenses: cellLicenses.map(row => ({
      ...RESOURCES.cellLicense.fromDb(row),
      devices: activations.filter(a => a.license_id === row.id).map(RESOURCES.cellActivation.fromDb),
    })),
    orders,
    referral: {
      code: account.referral_code || null,
      availableKopecks: Number(account.available_kopecks || 0),
      earnedKopecks: Number(account.earned_kopecks || 0),
      paidKopecks: Number(account.paid_kopecks || 0),
      invited: attributions.length,
      referrals: referredUsers,
    },
    notifications,
    historyEntries: historyCount.length,
    actions,
  });
}

module.exports = async function handler(req, res) {
  const action = String(req.query.action || 'list');
  const userId = String(req.body?.userId || req.query.userId || '');
  try {
    if (req.method === 'GET' && action === 'summary') {
      return res.json(await supabaseFetch('rpc/admin_user_summary', { method: 'POST', body: '{}' }));
    }
    if (req.method === 'GET' && action === 'list') return listUsers(req, res);
    if (req.method === 'GET' && action === 'detail') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      return userDetail(req, res, userId);
    }

    if (req.method === 'POST' && action === 'grantSticker') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const created = await createStickerAccessCode({
        name: req.body?.name, limit: req.body?.limit, ownerUserId: userId,
      });
      if (created.error) return badRequest(res, created.error);
      await recordAdminAction(req, 'grantSticker', userId, { code: created.row.code, limit: created.row.generation_limit });
      await notifyUser(userId, 'Вам выдан код доступа',
        `Код ${created.row.code} — ${created.row.generation_limit} генераций. Он уже доступен в кабинете.`);
      return res.status(201).json(RESOURCES.stickerAccess.fromDb(created.row));
    }
    if (req.method === 'POST' && action === 'topupSticker') {
      const codeId = Number(req.body?.codeId);
      if (!Number.isInteger(codeId)) return badRequest(res, 'Некорректный код');
      const result = await addStickerGenerations(codeId, req.body?.add);
      if (result.error) return badRequest(res, result.error);
      await recordAdminAction(req, 'topupSticker', userId, { codeId, add: Number(req.body?.add) });
      if (isUuid(userId)) {
        await notifyUser(userId, 'Пакет генераций пополнен',
          `К коду ${result.row.code} добавлено ${Number(req.body?.add)} генераций.`);
      }
      return res.json(RESOURCES.stickerAccess.fromDb(result.row));
    }
    if (req.method === 'POST' && action === 'grantProgramKey') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const created = await createProgramKey({
        key: req.body?.key, limit: req.body?.limit, note: req.body?.note, ownerUserId: userId,
      });
      if (created.error) return badRequest(res, created.error);
      await recordAdminAction(req, 'grantProgramKey', userId, { key: created.row.key, limit: created.row.usage_limit });
      await notifyUser(userId, 'Вам выдан ключ «Подбора кодов»',
        `Ключ ${created.row.key}, ${created.row.usage_limit} итераций.`, '/cabinet/keys');
      return res.status(201).json(RESOURCES.key.fromDb(created.row));
    }
    if (req.method === 'POST' && action === 'grantCellLicense') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const created = await createCellLicense({
        durationDays: req.body?.durationDays, deviceLimit: req.body?.deviceLimit,
        marketplaceScope: req.body?.marketplaceScope || 'wb', note: req.body?.note, ownerUserId: userId,
      });
      if (created.error) return badRequest(res, created.error);
      await recordAdminAction(req, 'grantCellLicense', userId, { key: created.row.key, durationDays: created.row.duration_days });
      await notifyUser(userId, 'Вам выдан ключ «Печати ячеек»',
        `Ключ ${created.row.key} на ${created.row.duration_days} дней, устройств: ${created.row.device_limit}.`, '/cabinet/keys');
      return res.status(201).json(RESOURCES.cellLicense.fromDb(created.row));
    }
    if (req.method === 'POST' && action === 'attach') {
      // Привязка уже существующего актива: человек купил без входа, а потом
      // завёл аккаунт, но код к нему не подтянулся.
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const kind = String(req.body?.kind || '');
      const value = String(req.body?.value || '').trim();
      const target = { sticker: ['sticker_access_codes', 'code'], program: ['license_keys', 'key'], cell_print: ['cell_print_licenses', 'key'] }[kind];
      if (!target || !/^[A-Za-z0-9-]{4,64}$/.test(value)) return badRequest(res, 'Проверьте тип и значение');
      const [table, column] = target;
      const rows = await supabaseFetch(`${table}?${column}=eq.${encodeURIComponent(kind === 'sticker' ? value : value.toUpperCase())}&owner_user_id=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ owner_user_id: userId }),
      });
      if (!rows.length) return res.status(409).json({ error: 'Актив не найден или уже принадлежит другому аккаунту' });
      await recordAdminAction(req, 'attach', userId, { kind, value });
      return res.json({ attached: true });
    }
    if (req.method === 'POST' && action === 'notify') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const title = String(req.body?.title || '').trim();
      const body = String(req.body?.body || '').trim();
      if (!title || title.length > 160 || !body || body.length > 2000) return badRequest(res, 'Заполните заголовок и текст');
      await notifyUser(userId, title, body, String(req.body?.link || '') || null);
      await recordAdminAction(req, 'notify', userId, { title });
      return res.status(201).json({ sent: true });
    }
    if (req.method === 'POST' && action === 'profile') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const patch = { updated_at: new Date().toISOString() };
      if ('displayName' in (req.body || {})) patch.display_name = String(req.body.displayName || '').slice(0, 120);
      if ('phone' in (req.body || {})) patch.phone = String(req.body.phone || '').slice(0, 32);
      if ('payerStatus' in (req.body || {})) {
        if (!['individual', 'self_employed', 'entrepreneur'].includes(req.body.payerStatus)) return badRequest(res, 'Неизвестный статус плательщика');
        patch.payer_status = req.body.payerStatus;
      }
      const rows = await supabaseFetch(`user_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      await recordAdminAction(req, 'profile', userId, patch);
      return res.json(rows[0] || {});
    }
    if (req.method === 'POST' && (action === 'block' || action === 'unblock')) {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const blocking = action === 'block';
      await setAuthBan(userId, blocking);
      // Одного бана мало: коды доступа работают без входа в аккаунт.
      const q = encodeURIComponent(userId);
      for (const table of ['sticker_access_codes', 'license_keys', 'cell_print_licenses']) {
        await supabaseFetch(`${table}?owner_user_id=eq.${q}`, {
          method: 'PATCH', body: JSON.stringify({ active: !blocking }),
        });
      }
      await recordAdminAction(req, action, userId, {});
      return res.json({ banned: blocking });
    }

    if (req.method === 'PATCH' && action === 'code') {
      const id = Number(req.body?.codeId);
      if (!Number.isInteger(id)) return badRequest(res, 'Некорректный код');
      const patch = {};
      if ('name' in (req.body || {})) patch.name = req.body.name;
      if ('limit' in (req.body || {})) patch.limit = req.body.limit;
      if ('active' in (req.body || {})) patch.active = req.body.active;
      const checked = await checkStickerAccessPatch(id, patch);
      if (checked.error) return res.status(checked.status || 400).json({ error: checked.error });
      const rows = await supabaseFetch(`sticker_access_codes?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(RESOURCES.stickerAccess.toDb(patch)),
      });
      await recordAdminAction(req, 'patchCode', userId, { codeId: id, ...patch });
      return res.json(RESOURCES.stickerAccess.fromDb(rows[0]));
    }
    if (req.method === 'PATCH' && action === 'programKey') {
      const id = Number(req.body?.id);
      if (!Number.isInteger(id)) return badRequest(res, 'Некорректный ключ');
      const patch = {};
      if ('limit' in (req.body || {})) patch.limit = Number(req.body.limit);
      if ('active' in (req.body || {})) patch.active = Boolean(req.body.active);
      const rows = await supabaseFetch(`license_keys?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(RESOURCES.key.toDb(patch)),
      });
      await recordAdminAction(req, 'patchProgramKey', userId, { id, ...patch });
      return res.json(RESOURCES.key.fromDb(rows[0]));
    }
    if (req.method === 'PATCH' && action === 'cellLicense') {
      const id = Number(req.body?.id);
      if (!Number.isInteger(id)) return badRequest(res, 'Некорректный ключ');
      const checked = await checkCellLicensePatch(id, req.body || {});
      if (checked.error) return res.status(checked.status || 400).json({ error: checked.error });
      const rows = await supabaseFetch(`cell_print_licenses?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...RESOURCES.cellLicense.toDb(req.body || {}), ...(checked.extra || {}) }),
      });
      await recordAdminAction(req, 'patchCellLicense', userId, { id, ...(req.body || {}) });
      return res.json(RESOURCES.cellLicense.fromDb(rows[0]));
    }

    if (req.method === 'DELETE' && action === 'account') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const authUser = await getAuthUser(userId);
      if (!authUser) return res.status(404).json({ error: 'Пользователь не найден' });
      // Промах по строке в списке стоит слишком дорого: удаление необратимо,
      // поэтому просим ввести почту удаляемого вручную.
      const confirm = String(req.body?.confirm || '').trim();
      if (!confirm || confirm !== String(authUser.email || userId)) {
        return res.status(409).json({ error: 'Введите почту пользователя для подтверждения' });
      }
      await recordAdminAction(req, 'deleteAccount', userId, { email: authUser.email });
      await deleteAuthUser(userId);
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendApiError(res, error);
  }
};
