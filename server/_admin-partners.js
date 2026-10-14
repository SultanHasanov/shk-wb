const { sendApiError, supabaseFetch } = require('./_supabase');
const { getAuthUser } = require('./_user-auth');
const { isUuid, recordAdminAction } = require('./_admin-grants');
const partners = require('./_partners');

/**
 * Раздел «Партнёры» админки владельца: ?resource=partners&action=…
 *
 * Вызывается из api/admin/data.js ПОСЛЕ requireAdmin, своей проверки прав нет —
 * так же, как у _admin-users.js.
 */

function bad(res, error) {
  return res.status(400).json({ error });
}

async function listPartners() {
  const rows = await supabaseFetch('partners?select=*&order=created_at.desc');
  const [users, balances] = await Promise.all([
    Promise.all(rows.map(row => getAuthUser(row.user_id).catch(() => null))),
    Promise.all(rows.map(row => partners.getBalance(row.id))),
  ]);
  return rows.map((row, index) => ({
    ...partners.mapPartner(row), account: accountLabel(users[index]), balance: balances[index],
  }));
}

function accountLabel(user) {
  if (!user) return null;
  if (user.email && !user.email.endsWith('@users.invalid')) return user.email;
  const tg = user.user_metadata?.username;
  return tg ? `@${tg} (Telegram)` : 'Telegram-аккаунт';
}

module.exports = async function handleAdminPartners(req, res) {
  const action = String(req.query.action || 'list');
  try {
    if (req.method === 'GET' && action === 'list') return res.json({ items: await listPartners() });

    if (req.method === 'GET' && action === 'detail') {
      const id = String(req.query.id || '');
      if (!isUuid(id)) return bad(res, 'Некорректный партнёр');
      const row = await partners.getPartner(id);
      if (!row) return res.status(404).json({ error: 'Партнёр не найден' });
      const [items, ledger, payments, balance, user] = await Promise.all([
        partners.listPartnerItems(id),
        partners.listPartnerLedger(id),
        partners.listPayments(id),
        partners.getBalance(id),
        getAuthUser(row.user_id).catch(() => null),
      ]);
      return res.json({ partner: { ...partners.mapPartner(row), account: accountLabel(user) }, items, ledger, payments, balance });
    }

    if (req.method === 'GET' && action === 'settings') {
      return res.json({ kztPerRub: await partners.getKztRate() });
    }

    if (req.method === 'POST' && action === 'settings') {
      const rate = Number(req.body?.kztPerRub);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return bad(res, 'Курс: число больше 0');
      await supabaseFetch('site_settings', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ key: 'kzt_per_rub', value: rate, updated_at: new Date().toISOString() }),
      });
      await recordAdminAction(req, 'setKztRate', null, { kztPerRub: rate });
      return res.json({ kztPerRub: rate });
    }

    if (req.method === 'POST' && action === 'create') {
      const userId = String(req.body?.userId || '');
      const name = String(req.body?.name || '').trim();
      if (!isUuid(userId)) return bad(res, 'Выберите аккаунт партнёра');
      if (!name || name.length > 120) return bad(res, 'Введите название партнёра');
      if (!(await getAuthUser(userId).catch(() => null))) return bad(res, 'Аккаунт не найден');
      try {
        const rows = await supabaseFetch('partners', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            user_id: userId, name,
            note: String(req.body?.note || '').trim().slice(0, 500),
          }),
        });
        await recordAdminAction(req, 'createPartner', userId, { partnerId: rows[0].id, name });
        return res.status(201).json(partners.mapPartner(rows[0]));
      } catch (error) {
        if (error.status === 409) return res.status(409).json({ error: 'Этот аккаунт уже партнёр' });
        throw error;
      }
    }

    if (req.method === 'POST' && action === 'grant') {
      const id = String(req.body?.partnerId || '');
      const resource = String(req.body?.resource || '');
      const amount = Number(req.body?.amount);
      if (!isUuid(id) || !partners.RESOURCES.includes(resource)) return bad(res, 'Некорректный запрос');
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10000000) return bad(res, 'Количество: целое число, не ноль');
      const row = await partners.rpc('partner_grant', {
        p_partner: id, p_resource: resource, p_amount: amount,
        p_note: String(req.body?.note || '').trim().slice(0, 200),
      });
      await recordAdminAction(req, 'grantPartnerPool', row.user_id, { partnerId: id, resource, amount });
      return res.json(partners.mapPartner(row));
    }

    if (req.method === 'PATCH' && action === 'update') {
      const id = String(req.body?.partnerId || '');
      if (!isUuid(id)) return bad(res, 'Некорректный партнёр');
      const patch = {};
      if ('active' in req.body) patch.active = Boolean(req.body.active);
      if ('name' in req.body) {
        const name = String(req.body.name || '').trim();
        if (!name || name.length > 120) return bad(res, 'Введите название партнёра');
        patch.name = name;
      }
      if ('note' in req.body) patch.note = String(req.body.note || '').trim().slice(0, 500);
      // Оптовые цены за единицу в рублях — по ним считается долг партнёра.
      for (const [field, column] of [['priceStickerRub', 'price_sticker_rub'], ['priceProgramRub', 'price_program_rub'], ['priceCellRub', 'price_cell_rub']]) {
        if (!(field in req.body)) continue;
        const value = Number(req.body[field]);
        if (!Number.isFinite(value) || value < 0 || value > 100000) return bad(res, 'Цена за единицу: число от 0');
        patch[column] = Math.round(value * 10000) / 10000;
      }
      const rows = await supabaseFetch(`partners?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      if (!rows.length) return res.status(404).json({ error: 'Партнёр не найден' });
      await recordAdminAction(req, 'updatePartner', rows[0].user_id, { partnerId: id, ...patch });
      return res.json(partners.mapPartner(rows[0]));
    }

    // Оплата от партнёра. Отрицательная сумма — корректировка ошибочной записи.
    if (req.method === 'POST' && action === 'payment') {
      const id = String(req.body?.partnerId || '');
      const amount = Math.round(Number(req.body?.amountRub) * 100) / 100;
      if (!isUuid(id)) return bad(res, 'Некорректный партнёр');
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e9) return bad(res, 'Сумма: число, не ноль');
      await supabaseFetch('partner_payments', {
        method: 'POST',
        body: JSON.stringify({ partner_id: id, amount_rub: amount, note: String(req.body?.note || '').trim().slice(0, 200) }),
      });
      await recordAdminAction(req, 'partnerPayment', null, { partnerId: id, amountRub: amount });
      return res.status(201).json({ balance: await partners.getBalance(id) });
    }

    // Владелец может выключить любой код или ключ партнёра — например, по жалобе.
    if (req.method === 'POST' && action === 'toggleItem') {
      const id = String(req.body?.partnerId || '');
      if (!isUuid(id)) return bad(res, 'Некорректный партнёр');
      const result = await partners.toggle(id, req.body);
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      await recordAdminAction(req, 'togglePartnerItem', null, { partnerId: id, kind: req.body.kind, id: req.body.id, active: req.body.active });
      return res.json(result);
    }

    return res.status(404).json({ error: 'Unknown action' });
  } catch (error) {
    if (partners.sendPartnerError(res, error)) return;
    return sendApiError(res, error);
  }
};
