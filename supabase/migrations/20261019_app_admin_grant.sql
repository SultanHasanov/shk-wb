begin;

-- Ручная выдача подписки «Помощник ПВЗ» администратором (помимо оплаты) и отзыв.
--
-- Логику «применить отрезок подписки» (продление / повышение с пересчётом дней /
-- понижение в очередь + снимок лимитов) выносим из complete_app_subscription_order
-- в общую app_apply_subscription(... , p_source, p_order_id). Тогда и оплата, и
-- ручная выдача используют ОДНУ проверенную логику и один формат снимка лимитов.
-- Разница только в source: 'payment' против 'admin'.

create or replace function public.app_apply_subscription(
  p_user uuid, p_plan text, p_months integer, p_snap jsonb,
  p_source text default 'payment', p_order_id uuid default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  cur public.app_subscriptions;
  last_row public.app_subscriptions;
  rank_new integer;
  rank_cur integer;
  new_price numeric;
  extra_days numeric := 0;
  r public.app_subscriptions;
  new_id uuid;
  term interval;
begin
  if p_snap is null or p_plan is null or p_months is null then
    raise exception 'Invalid subscription snapshot';
  end if;
  perform pg_advisory_xact_lock(hashtext('app_subs:' || p_user::text));
  term := make_interval(months => p_months);
  new_price := (p_snap->>'monthly_price')::numeric;
  rank_new := array_position(array['basic','standard','pro'], p_plan);
  cur := public.app_current_subscription(p_user);
  select * into last_row from public.app_subscriptions
   where user_id = p_user and not canceled and ends_at > now()
   order by ends_at desc limit 1;

  if cur.id is null and last_row.id is null then
    insert into public.app_subscriptions(user_id, plan, starts_at, ends_at, monthly_price, codes_per_month, stickers_per_month, device_limit, source_order_id, source)
      values (p_user, p_plan, now(), now() + term, new_price,
              (p_snap->>'codes')::int, (p_snap->>'stickers')::int, (p_snap->>'devices')::int, p_order_id, p_source)
      returning id into new_id;
  else
    rank_cur := array_position(array['basic','standard','pro'], coalesce(cur.plan, last_row.plan));
    if last_row.plan = p_plan and rank_new <= rank_cur then
      -- Продление того же тарифа (или уже стоящего в очереди).
      update public.app_subscriptions set ends_at = ends_at + term where id = last_row.id returning id into new_id;
    elsif rank_new > rank_cur then
      -- Повышение: остаток всех отрезков переводим в дни нового тарифа по цене.
      for r in select * from public.app_subscriptions
                where user_id = p_user and not canceled and ends_at > now() loop
        extra_days := extra_days
          + extract(epoch from (r.ends_at - greatest(r.starts_at, now()))) / 86400.0
            * r.monthly_price / greatest(new_price, 1);
        -- Уже идущий отрезок обрываем сейчас; ещё не начавшийся (в т.ч. стартующий
        -- ровно сейчас) отменяем — иначе ends_at=now()=starts_at нарушит ends_at>starts_at.
        if r.starts_at < now() then
          update public.app_subscriptions set ends_at = now() where id = r.id;
        else
          update public.app_subscriptions set canceled = true where id = r.id;
        end if;
      end loop;
      insert into public.app_subscriptions(user_id, plan, starts_at, ends_at, monthly_price, codes_per_month, stickers_per_month, device_limit, source_order_id, source)
        values (p_user, p_plan, now(),
                now() + term + make_interval(days => floor(extra_days)::int), new_price,
                (p_snap->>'codes')::int, (p_snap->>'stickers')::int, (p_snap->>'devices')::int, p_order_id, p_source)
        returning id into new_id;
    else
      -- Понижение: новый отрезок после последнего оплаченного.
      insert into public.app_subscriptions(user_id, plan, starts_at, ends_at, monthly_price, codes_per_month, stickers_per_month, device_limit, source_order_id, source)
        values (p_user, p_plan, last_row.ends_at, last_row.ends_at + term, new_price,
                (p_snap->>'codes')::int, (p_snap->>'stickers')::int, (p_snap->>'devices')::int, p_order_id, p_source)
        returning id into new_id;
    end if;
  end if;
  return new_id;
end;
$$;

-- Теперь завершение оплаты просто делегирует общей функции.
create or replace function public.complete_app_subscription_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  order_row public.payment_orders;
  snap jsonb;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
   where id = p_order_id and product_kind = 'app_subscription' for update;
  if not found then raise exception 'Subscription order not found'; end if;
  if order_row.app_fulfilled_at is not null then
    select id into new_id from public.app_subscriptions where source_order_id = p_order_id order by created_at desc limit 1;
    return new_id;
  end if;
  if order_row.user_id is null then raise exception 'Subscription requires an account'; end if;
  snap := order_row.pricing_snapshot -> 'app';
  if snap is null or order_row.app_plan is null or order_row.app_term_months is null then
    raise exception 'Invalid subscription order';
  end if;
  new_id := public.app_apply_subscription(
    order_row.user_id, order_row.app_plan, order_row.app_term_months, snap, 'payment', p_order_id);
  update public.payment_orders set app_fulfilled_at = now(), status = 'succeeded',
         paid_at = coalesce(paid_at, now()), updated_at = now()
   where id = p_order_id;
  return new_id;
end;
$$;

-- Ручная выдача: снимок лимитов приходит из приложения (server/_app-plans.js),
-- чтобы совпадать с оплаченной подпиской. Пишем в журнал как source='admin'.
create or replace function public.admin_grant_app_subscription(
  p_user uuid, p_plan text, p_months integer, p_snap jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
begin
  return public.app_apply_subscription(p_user, p_plan, p_months, p_snap, 'admin', null);
end;
$$;

-- Отзыв подписки: активную обрываем сейчас, будущую (в очереди) помечаем отменённой.
create or replace function public.admin_revoke_app_subscription(p_sub uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.app_subscriptions
     set canceled = true,
         ends_at = case when starts_at < now() then now() else ends_at end
   where id = p_sub;
end;
$$;

revoke all on function public.app_apply_subscription(uuid,text,integer,jsonb,text,uuid) from public, anon, authenticated;
revoke all on function public.admin_grant_app_subscription(uuid,text,integer,jsonb) from public, anon, authenticated;
revoke all on function public.admin_revoke_app_subscription(uuid) from public, anon, authenticated;
grant execute on function public.app_apply_subscription(uuid,text,integer,jsonb,text,uuid) to service_role;
grant execute on function public.admin_grant_app_subscription(uuid,text,integer,jsonb) to service_role;
grant execute on function public.admin_revoke_app_subscription(uuid) to service_role;

commit;
