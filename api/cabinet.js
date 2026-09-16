const { z } = require('zod');
const { sendApiError, supabaseFetch } = require('../server/_supabase');
const {
  deleteAuthUser,
  getAuthUser,
  readReferralCookieDetails,
  requireUser,
  sessionIssuedRecently,
} = require('../server/_user-auth');
const { createNotification } = require('../server/_notifications');
const { enforceRateLimit } = require('../server/_rate-limit');

// Реферальная ссылка публичная и должна переживать каждый Vercel-деплой.
// VERCEL_URL здесь использовать нельзя: он содержит технический адрес сборки.
const REFERRAL_ORIGIN = String(process.env.PUBLIC_REFERRAL_URL || 'https://shk-wb.vercel.app').replace(
  /\/$/,
  '',
);

const ProfileInput = z
  .object({
    displayName: z.string().trim().max(120),
    phone: z.string().trim().max(32),
    payerStatus: z.enum(['individual', 'self_employed', 'entrepreneur']),
  })
  .partial()
  .strict();
const PreferencesInput = z
  .object({
    thermalPrintSettings: z.record(z.string(), z.unknown()).optional(),
    notifyOrderStatus: z.boolean().optional(),
    notifyKeyExpiry: z.boolean().optional(),
    notifyLowBalance: z.boolean().optional(),
    notifyProductNews: z.boolean().optional(),
    dismissImportNotice: z.boolean().optional(),
  })
  .strict();
const ClaimInput = z
  .object({
    kind: z.enum(['sticker', 'program', 'cell_print', 'order']),
    value: z.string().trim().min(1).max(200),
  })
  .strict();
const WithdrawalInput = z
  .object({
    amountKopecks: z.number().int().min(50000),
    phone: z.string().trim().min(7).max(32),
    bank: z.string().trim().min(2).max(120),
  })
  .strict();
const ImportEntry = z
  .object({
    id: z.string().min(1).max(120),
    mode: z.enum(['range', 'custom']),
    category: z.enum(['product', 'box']).default('product'),
    prefix: z.string().max(12).optional().default(''),
    createdAt: z.string().datetime(),
    quantity: z.number().int().min(1).max(500),
    code: z.string().max(64).optional(),
    batchId: z.string().uuid().optional(),
    stickers: z
      .array(z.object({ code: z.union([z.string(), z.number()]) }).strict())
      .max(500)
      .optional(),
  })
  .strict();

function action(req) {
  return String(req.query?.action || 'bootstrap');
}
function q(value) {
  return encodeURIComponent(String(value));
}
function limit(req, max = 100) {
  return Math.min(max, Math.max(1, Number(req.query?.limit) || 25));
}
function before(req) {
  const value = String(req.query?.before || '');
  return value && !Number.isNaN(Date.parse(value))
    ? `&created_at=lt.${q(new Date(value).toISOString())}`
    : '';
}
function bad(res, parsed) {
  return res
    .status(400)
    .json({
      error: 'Некорректные данные',
      code: 'VALIDATION_ERROR',
      details: parsed.error.flatten(),
    });
}

async function ensureAccount(user) {
  await supabaseFetch('user_profiles?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      user_id: user.id,
      display_name: String(
        user.user_metadata?.full_name || user.user_metadata?.username || '',
      ).slice(0, 120),
    }),
  });
  await supabaseFetch('user_preferences?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ user_id: user.id }),
  });
  await supabaseFetch('rpc/ensure_referral_account', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: user.id }),
  });
}

async function maybeBindReferral(req, user) {
  const referral = readReferralCookieDetails(req);
  if (!referral) return;
  await supabaseFetch('rpc/bind_referral', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: user.id,
      p_code: referral.code,
      p_captured_at: new Date(referral.capturedAt * 1000).toISOString(),
    }),
  }).catch(() => {});
}

async function getProfile(user) {
  const [profiles, preferences, telegram] = await Promise.all([
    supabaseFetch(`user_profiles?user_id=eq.${q(user.id)}&select=*&limit=1`),
    supabaseFetch(`user_preferences?user_id=eq.${q(user.id)}&select=*&limit=1`),
    supabaseFetch(
      `user_telegram_identities?user_id=eq.${q(user.id)}&select=username,first_name,last_name,photo_url&limit=1`,
    ),
  ]);
  const p = profiles[0] || {},
    pref = preferences[0] || {};
  return {
    userId: user.id,
    email: user.email?.endsWith('@users.invalid') ? null : user.email || null,
    telegramOnly: Boolean(user.email?.endsWith('@users.invalid')),
    displayName:
      p.display_name || user.user_metadata?.full_name || user.user_metadata?.username || '',
    phone: p.phone || '',
    payerStatus: p.payer_status || 'individual',
    registeredAt: user.created_at,
    lastSignInAt: user.last_sign_in_at || null,
    telegram: telegram[0] || null,
    preferences: mapPreferences(pref),
  };
}

function mapPreferences(row) {
  return {
    thermalPrintSettings: row.thermal_print_settings || {},
    notifyOrderStatus: row.notify_order_status !== false,
    notifyKeyExpiry: row.notify_key_expiry !== false,
    notifyLowBalance: Boolean(row.notify_low_balance),
    notifyProductNews: row.notify_product_news !== false,
    historyImportedAt: row.history_imported_at || null,
    historyImportedCount: Number(row.history_imported_count || 0),
    historyImportNoticeDismissedAt: row.history_import_notice_dismissed_at || null,
  };
}

async function getAssets(userId) {
  const [codes, program, cell] = await Promise.all([
    supabaseFetch(
      `sticker_access_codes?owner_user_id=eq.${q(userId)}&select=code,name,active,created_at,generation_limit,generation_used&order=created_at.desc`,
    ),
    supabaseFetch(
      `license_keys?owner_user_id=eq.${q(userId)}&select=id,key,usage_limit,used,active,created_at&order=created_at.desc`,
    ),
    supabaseFetch(
      `cell_print_licenses?owner_user_id=eq.${q(userId)}&select=id,key,duration_days,device_limit,active,activated_at,expires_at,created_at&order=created_at.desc`,
    ),
  ]);
  const ids = cell.map(x => x.id);
  const activations = ids.length
    ? await supabaseFetch(
        `cell_print_activations?license_id=in.(${ids.join(',')})&select=id,license_id,device_hash,first_seen_at,last_seen_at&order=last_seen_at.desc`,
      )
    : [];
  return [
    ...codes.map(x => ({
      type: 'sticker',
      key: x.code,
      label: x.name,
      active: x.active,
      createdAt: x.created_at,
      limits: { used: Number(x.generation_used || 0), total: Number(x.generation_limit || 0) },
    })),
    ...program.map(x => ({
      type: 'program',
      id: x.id,
      key: x.key,
      label: 'Подбор кодов',
      active: x.active,
      createdAt: x.created_at,
      used: x.used,
      total: x.usage_limit,
    })),
    ...cell.map(x => ({
      type: 'cell_print',
      id: x.id,
      key: x.key,
      label: 'Печать ячеек',
      active: x.active,
      createdAt: x.created_at,
      durationDays: x.duration_days,
      deviceLimit: x.device_limit,
      activatedAt: x.activated_at,
      expiresAt: x.expires_at,
      devices: activations
        .filter(a => a.license_id === x.id)
        .map(a => ({
          id: a.id,
          name: `Устройство ••••${String(a.device_hash).slice(-6)}`,
          firstSeenAt: a.first_seen_at,
          lastSeenAt: a.last_seen_at,
        })),
    })),
  ];
}

function orderLabel(row) {
  if (row.product_kind === 'stickers')
    return `${row.renewal_target_key ? 'Пополнение кода' : 'Пакет генераций'} · ${Number(row.range_quantity || 0) + Number(row.custom_quantity || 0)} шт.`;
  if (row.product_kind === 'program_license')
    return `${row.renewal_target_key ? 'Пополнение' : 'Подбор кодов'} · ${row.license_iterations} итераций`;
  if (String(row.product_kind).startsWith('cell_print'))
    return `${row.renewal_target_key ? 'Продление' : 'Печать ячеек'} · ${row.cell_print_duration_days || 0} дней · ${row.cell_print_device_limit || 0} устройств`;
  return 'Программа «Подбор кодов»';
}
function mapOrder(row) {
  return {
    id: row.id,
    publicToken: row.public_token,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    status: row.status,
    productKind: row.product_kind,
    product: orderLabel(row),
    amount: Number(row.amount),
    grossAmount: Number(row.gross_amount ?? row.amount),
    referralCreditKopecks: Number(row.referral_credit_kopecks || 0),
    currency: row.currency,
    accessCode: row.access_code,
    licenseKey: row.program_license_key || row.cell_print_license_key || null,
    renewal: Boolean(row.renewal_target_key),
    receiptUrl: row.receipt_url || null,
  };
}

async function getOrders(userId, count = 25, cursor = '') {
  const rows = await supabaseFetch(
    `payment_orders?user_id=eq.${q(userId)}${cursor}&select=*&order=created_at.desc&limit=${count}`,
  );
  return rows.map(mapOrder);
}

/* getProgramEntitlement убран: установщик «Подбора кодов» скачивается свободно
   через /api/payments/download-program, и кабинету больше не нужно искать
   оплаченный заказ, чтобы показать кнопку. */

async function bootstrap(req, res, user) {
  await ensureAccount(user);
  await maybeBindReferral(req, user);
  const [profile, assets, orders, notifications, unread, referral] = await Promise.all([
    getProfile(user),
    getAssets(user.id),
    getOrders(user.id, 5),
    supabaseFetch(
      `in_app_notifications?user_id=eq.${q(user.id)}&select=*&order=created_at.desc&limit=8`,
    ),
    supabaseFetch(`in_app_notifications?user_id=eq.${q(user.id)}&read_at=is.null&select=id`),
    getReferral(user.id),
  ]);
  const stickerAssets = assets.filter(x => x.type === 'sticker');
  const remaining = stickerAssets.reduce(
    (sum, x) => sum + Math.max(0, x.limits.total - x.limits.used),
    0,
  );
  const total = stickerAssets.reduce((sum, x) => sum + x.limits.total, 0);
  const now = Date.now();
  const needsAttention = assets.filter(
    x =>
      x.type === 'cell_print' &&
      x.active &&
      x.expiresAt &&
      new Date(x.expiresAt).getTime() >= now &&
      new Date(x.expiresAt).getTime() - now < 4 * 86400000,
  ).length;
  return res.json({
    profile,
    assets,
    orders,
    notifications: notifications.map(mapNotification),
    unreadNotifications: unread.length,
    referral,
    overview: {
      activeKeys: assets.filter(x => x.active).length,
      stickersLeft: remaining,
      stickersTotal: total,
      needsAttention,
    },
  });
}

function mapNotification(n) {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    readAt: n.read_at,
    createdAt: n.created_at,
  };
}

async function history(req, res, user) {
  if (req.method === 'GET') {
    const kind = ['product', 'box'].includes(req.query?.kind)
      ? `&payload->>category=eq.${q(req.query.kind)}`
      : '';
    const pageSize = limit(req),
      rows = await supabaseFetch(
        `user_generation_history?user_id=eq.${q(user.id)}${kind}${before(req)}&select=*&order=created_at.desc&limit=${pageSize}`,
      );
    return res.json({
      items: rows.map(r => ({
        id: String(r.id),
        clientEntryId: r.client_entry_id,
        mode: r.mode,
        createdAt: r.created_at,
        ...r.payload,
        printedCodes: r.printed_codes || [],
      })),
      nextCursor: rows.length === pageSize ? rows[rows.length - 1].created_at : null,
    });
  }
  // Отметка напечатанного. Копим объединением: печать частями не должна
  // затирать то, что человек вывел на бумагу в прошлый заход.
  if (req.method === 'PATCH') {
    const parsed = z
      .object({
        entryId: z.string().regex(/^\d+$/),
        codes: z.array(z.string().regex(/^\d{1,20}$/)).max(500),
      })
      .safeParse(req.body);
    if (!parsed.success) return bad(res, parsed);
    const merged = await supabaseFetch('rpc/merge_printed_history_codes', {
      method: 'POST',
      body: JSON.stringify({
        p_user_id: user.id,
        p_entry_id: Number(parsed.data.entryId),
        p_codes: parsed.data.codes,
      }),
    });
    return res.json({ printedCodes: merged });
  }
  if (req.method === 'POST') {
    if (
      !(await enforceRateLimit(req, res, {
        scope: 'history-import',
        limit: 3,
        windowSeconds: 3600,
        key: user.id,
      }))
    )
      return;
    const parsed = z.object({ entries: z.array(ImportEntry).max(100) }).safeParse(req.body);
    if (!parsed.success) return bad(res, parsed);
    const existing = await supabaseFetch(
      `user_generation_history?user_id=eq.${q(user.id)}&select=id&limit=1001`,
    );
    if (existing.length + parsed.data.entries.length > 1000)
      return res
        .status(409)
        .json({
          error: 'В истории можно хранить не более 1000 импортированных записей',
          code: 'HISTORY_LIMIT',
        });
    const sanitized = parsed.data.entries.map(e => ({
      user_id: user.id,
      client_entry_id: e.id,
      mode: e.mode,
      created_at: e.createdAt,
      payload: {
        category: e.category,
        prefix: e.prefix,
        quantity: e.quantity,
        code: e.code || null,
        batchId: e.batchId || null,
        codes: (e.stickers || []).map(s => String(s.code)).slice(0, 500),
        imported: true,
      },
    }));
    if (sanitized.length)
      await supabaseFetch('user_generation_history?on_conflict=user_id,client_entry_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify(sanitized),
      });
    await supabaseFetch(`user_preferences?user_id=eq.${q(user.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        history_imported_at: new Date().toISOString(),
        history_imported_count: sanitized.length,
        history_import_notice_dismissed_at: null,
        updated_at: new Date().toISOString(),
      }),
    });
    return res.status(201).json({ imported: sanitized.length });
  }
  return res.status(405).end();
}

async function getReferral(userId) {
  await supabaseFetch('rpc/ensure_referral_account', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId }),
  });
  const [accounts, attributions, withdrawals] = await Promise.all([
    supabaseFetch(`referral_accounts?user_id=eq.${q(userId)}&select=*&limit=1`),
    supabaseFetch(
      `referral_attributions?referrer_user_id=eq.${q(userId)}&select=invited_user_id,attributed_at&order=attributed_at.desc&limit=100`,
    ),
    supabaseFetch(
      `referral_withdrawals?user_id=eq.${q(userId)}&select=id,amount_kopecks,bank_name,sbp_phone,status,admin_note,created_at,updated_at&order=created_at.desc&limit=50`,
    ),
  ]);
  const invitedIds = attributions.map(x => x.invited_user_id);
  const invitedFilter = invitedIds.length ? `(${invitedIds.map(q).join(',')})` : '';
  const [profiles, orders, ledger] = await Promise.all([
    invitedIds.length
      ? supabaseFetch(
          `user_profiles?user_id=in.${invitedFilter}&select=user_id,display_name&limit=100`,
        )
      : [],
    invitedIds.length
      ? supabaseFetch(
          `payment_orders?user_id=in.${invitedFilter}&status=eq.succeeded&select=id,user_id,amount,refunded_kopecks,paid_at&order=paid_at.asc&limit=5000`,
        )
      : [],
    supabaseFetch(
      `referral_ledger?user_id=eq.${q(userId)}&select=id,kind,amount_kopecks,order_id,created_at,details&order=created_at.desc&limit=5000`,
    ),
  ]);
  const a = accounts[0] || {};
  const profileById = new Map(profiles.map(x => [x.user_id, x]));
  const referrals = attributions.map((attribution, index) => {
    const personOrders = orders.filter(x => x.user_id === attribution.invited_user_id);
    const orderIds = new Set(personOrders.map(x => x.id));
    const earned = ledger
      .filter(x => orderIds.has(x.order_id) && (x.kind === 'reward' || x.kind === 'reversal'))
      .reduce((sum, x) => sum + Number(x.amount_kopecks || 0), 0);
    const purchases = personOrders.filter(
      x =>
        Math.max(0, Math.round(Number(x.amount || 0) * 100) - Number(x.refunded_kopecks || 0)) > 0,
    );
    const purchasesKopecks = purchases.reduce(
      (sum, x) =>
        sum +
        Math.max(0, Math.round(Number(x.amount || 0) * 100) - Number(x.refunded_kopecks || 0)),
      0,
    );
    const displayName = String(
      profileById.get(attribution.invited_user_id)?.display_name || '',
    ).trim();
    return {
      id: attribution.invited_user_id,
      label: displayName || `Реферал №${attributions.length - index}`,
      attributedAt: attribution.attributed_at,
      purchases: purchases.length,
      purchasesKopecks,
      earnedKopecks: earned,
      lastPurchaseAt: personOrders.length ? personOrders[personOrders.length - 1].paid_at : null,
    };
  });
  return {
    code: a.referral_code || '',
    link: `${REFERRAL_ORIGIN}/r/${a.referral_code || ''}`,
    availableKopecks: Number(a.available_kopecks || 0),
    reservedKopecks: Number(a.reserved_kopecks || 0),
    earnedKopecks: Number(a.earned_kopecks || 0),
    paidKopecks: Number(a.paid_kopecks || 0),
    invited: attributions.length,
    referrals,
    events: ledger
      .slice(0, 50)
      .map(x => ({
        id: x.id,
        kind: x.kind,
        amountKopecks: Number(x.amount_kopecks),
        createdAt: x.created_at,
        details: x.details,
      })),
    withdrawals: withdrawals.map(x => ({
      ...x,
      amountKopecks: Number(x.amount_kopecks),
      phone: `••••${String(x.sbp_phone).slice(-4)}`,
    })),
  };
}

async function handleProfile(req, res, user) {
  if (req.method === 'GET') return res.json(await getProfile(user));
  if (req.method !== 'PATCH') return res.status(405).end();
  const parsed = ProfileInput.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const body = { updated_at: new Date().toISOString() };
  if (parsed.data.displayName !== undefined) body.display_name = parsed.data.displayName;
  if (parsed.data.phone !== undefined) body.phone = parsed.data.phone;
  if (parsed.data.payerStatus !== undefined) body.payer_status = parsed.data.payerStatus;
  const rows = await supabaseFetch(`user_profiles?user_id=eq.${q(user.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  return res.json(rows[0]);
}

async function handlePreferences(req, res, user) {
  if (req.method === 'GET') {
    const rows = await supabaseFetch(`user_preferences?user_id=eq.${q(user.id)}&select=*&limit=1`);
    return res.json(mapPreferences(rows[0] || {}));
  }
  if (req.method !== 'PATCH') return res.status(405).end();
  const parsed = PreferencesInput.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const d = parsed.data,
    body = { updated_at: new Date().toISOString() };
  if (d.thermalPrintSettings !== undefined) body.thermal_print_settings = d.thermalPrintSettings;
  for (const [apiKey, dbKey] of [
    ['notifyOrderStatus', 'notify_order_status'],
    ['notifyKeyExpiry', 'notify_key_expiry'],
    ['notifyLowBalance', 'notify_low_balance'],
    ['notifyProductNews', 'notify_product_news'],
  ])
    if (d[apiKey] !== undefined) body[dbKey] = d[apiKey];
  if (
    ['notifyOrderStatus', 'notifyKeyExpiry', 'notifyLowBalance', 'notifyProductNews'].some(
      k => d[k] !== undefined,
    )
  ) {
    body.notification_consent_updated_at = new Date().toISOString();
    body.notification_consent_source = 'cabinet';
  }
  if (d.dismissImportNotice) body.history_import_notice_dismissed_at = new Date().toISOString();
  await supabaseFetch(`user_preferences?user_id=eq.${q(user.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.json({ ok: true });
}

async function handleNotifications(req, res, user) {
  if (req.method === 'GET') {
    const pageSize = limit(req, 100),
      rows = await supabaseFetch(
        `in_app_notifications?user_id=eq.${q(user.id)}${before(req)}&select=*&order=created_at.desc&limit=${pageSize}`,
      );
    return res.json({
      items: rows.map(mapNotification),
      nextCursor: rows.length === pageSize ? rows[rows.length - 1].created_at : null,
    });
  }
  if (req.method !== 'PATCH') return res.status(405).end();
  const parsed = z
    .object({ id: z.string().uuid().optional(), readAll: z.boolean().optional() })
    .refine(x => x.id || x.readAll)
    .safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const filter = parsed.data.readAll
    ? `user_id=eq.${q(user.id)}&read_at=is.null`
    : `user_id=eq.${q(user.id)}&id=eq.${q(parsed.data.id)}`;
  await supabaseFetch(`in_app_notifications?${filter}`, {
    method: 'PATCH',
    body: JSON.stringify({ read_at: new Date().toISOString() }),
  });
  return res.json({ ok: true });
}

async function deleteAccount(req, res, user) {
  if (req.method !== 'DELETE') return res.status(405).end();
  if (req.body?.confirmation !== 'УДАЛИТЬ')
    return res.status(400).json({ error: 'Введите слово УДАЛИТЬ', code: 'CONFIRMATION_REQUIRED' });
  if (!sessionIssuedRecently(user))
    return res
      .status(403)
      .json({ error: 'Перед удалением войдите в аккаунт повторно', code: 'RECENT_LOGIN_REQUIRED' });
  // Все пользовательские FK заданы как ON DELETE CASCADE/SET NULL. Удаление
  // через Auth выполняет их одной транзакцией; предварительная ручная отвязка
  // могла оставить живой аккаунт без покупок, если Auth API затем падал.
  await supabaseFetch(
    `referral_withdrawals?user_id=eq.${q(user.id)}&status=in.(pending,approved)`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }),
    },
  );
  await deleteAuthUser(user.id);
  return res.status(204).end();
}

async function cronNotifications(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) return res.status(401).end();
  try {
    const start = new Date(Date.now() + 2 * 86400000).toISOString(),
      end = new Date(Date.now() + 4 * 86400000).toISOString();
    const releasedReservations = Number(
      await supabaseFetch('rpc/release_stale_payment_reservations', {
        method: 'POST',
        body: '{}',
      }).catch(() => 0),
    );
    const licenses = await supabaseFetch(
      `cell_print_licenses?owner_user_id=not.is.null&active=eq.true&expires_at=gte.${encodeURIComponent(start)}&expires_at=lt.${encodeURIComponent(end)}&select=id,key,owner_user_id,expires_at`,
    );
    let sent = 0;
    for (const license of licenses) {
      const prefs = await supabaseFetch(
        `user_preferences?user_id=eq.${encodeURIComponent(license.owner_user_id)}&select=notify_key_expiry&limit=1`,
      );
      if (prefs[0]?.notify_key_expiry === false) continue;
      const user = await getAuthUser(license.owner_user_id);
      await createNotification({
        userId: license.owner_user_id,
        kind: 'key_expiry',
        title: 'Срок ключа скоро закончится',
        body: `Ключ ${license.key} действует до ${new Date(license.expires_at).toLocaleDateString('ru-RU')}.`,
        link: '/cabinet/keys',
        dedupeKey: `key-expiry-3d:${license.id}:${String(license.expires_at).slice(0, 10)}`,
        email: user?.email?.endsWith('@users.invalid') ? null : user?.email,
        emailEnabled: true,
      });
      sent++;
    }
    return res.json({ checked: licenses.length, created: sent, releasedReservations });
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: 'Notification job failed' });
  }
}

module.exports = async function handler(req, res) {
  if (action(req) === 'cron') return cronNotifications(req, res);
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const a = action(req);
    if (a === 'bootstrap') return bootstrap(req, res, user);
    if (a === 'assets' && req.method === 'GET')
      return res.json({ items: await getAssets(user.id) });
    if (a === 'claim' && req.method === 'POST') {
      const parsed = ClaimInput.safeParse(req.body);
      if (!parsed.success) return bad(res, parsed);
      const result = await supabaseFetch('rpc/claim_user_asset', {
        method: 'POST',
        body: JSON.stringify({
          p_user_id: user.id,
          p_kind: parsed.data.kind,
          p_value: parsed.data.value,
        }),
      });
      return res.status(201).json(result);
    }
    if (a === 'orders' && req.method === 'GET') {
      const pageSize = limit(req),
        items = await getOrders(user.id, pageSize, before(req));
      return res.json({
        items,
        nextCursor: items.length === pageSize ? items[items.length - 1].createdAt : null,
      });
    }
    if (a === 'history') return history(req, res, user);
    if (a === 'profile') return handleProfile(req, res, user);
    if (a === 'preferences') return handlePreferences(req, res, user);
    if (a === 'notifications') return handleNotifications(req, res, user);
    if (a === 'telegram' && req.method === 'DELETE') {
      if (user.email?.endsWith('@users.invalid'))
        return res
          .status(409)
          .json({ error: 'Сначала добавьте почту и пароль', code: 'LAST_LOGIN_METHOD' });
      await supabaseFetch(`user_telegram_identities?user_id=eq.${q(user.id)}`, {
        method: 'DELETE',
      });
      return res.status(204).end();
    }
    if (a === 'device' && req.method === 'DELETE') {
      const id = Number(req.query.id);
      if (!Number.isInteger(id))
        return res.status(400).json({ error: 'Некорректное устройство', code: 'VALIDATION_ERROR' });
      const owned = await supabaseFetch(
        `cell_print_activations?id=eq.${id}&select=license_id,cell_print_licenses!inner(owner_user_id)&cell_print_licenses.owner_user_id=eq.${q(user.id)}&limit=1`,
      );
      if (!owned.length)
        return res.status(404).json({ error: 'Устройство не найдено', code: 'NOT_FOUND' });
      await supabaseFetch(`cell_print_activations?id=eq.${id}`, { method: 'DELETE' });
      return res.status(204).end();
    }
    if (a === 'referrals' && req.method === 'GET') return res.json(await getReferral(user.id));
    if (a === 'withdraw' && req.method === 'POST') {
      const parsed = WithdrawalInput.safeParse(req.body);
      if (!parsed.success) return bad(res, parsed);
      const id = await supabaseFetch('rpc/create_referral_withdrawal', {
        method: 'POST',
        body: JSON.stringify({
          p_user_id: user.id,
          p_amount_kopecks: parsed.data.amountKopecks,
          p_phone: parsed.data.phone,
          p_bank: parsed.data.bank,
        }),
      });
      return res.status(201).json({ id });
    }
    if (a === 'account') return deleteAccount(req, res, user);
    return res.status(404).json({ error: 'Метод кабинета не найден', code: 'NOT_FOUND' });
  } catch (error) {
    const details = JSON.stringify(error.details || '');
    if (details.includes('belongs to another'))
      return res
        .status(409)
        .json({ error: 'Этот актив уже принадлежит другому аккаунту', code: 'ASSET_OWNED' });
    if (details.includes('Asset not found'))
      return res.status(404).json({ error: 'Код или ключ не найден', code: 'ASSET_NOT_FOUND' });
    if (details.includes('Insufficient referral'))
      return res
        .status(409)
        .json({
          error: 'Недостаточно средств на реферальном балансе',
          code: 'INSUFFICIENT_BALANCE',
        });
    return sendApiError(res, error);
  }
};
