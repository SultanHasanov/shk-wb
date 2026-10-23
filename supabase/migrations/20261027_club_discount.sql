begin;

-- Скидка 20% участникам «Клуба вопросов» (бот @zara34_help_bot, проект zara-bot).
-- club_ref_at — когда человек последний раз пришёл в бота по кнопке из группы клуба (/start club_*).
-- Скидка действует 30 дней после такого перехода и только при активной подписке на клуб:
-- её бот проверяет фоном у zara-bot (маршрут /club-check), а не здесь.
alter table public.telegram_bot_subscribers add column if not exists club_ref_at timestamptz;

-- «Кто поставил оценку»: цена теперь передаётся ботом (25 ₽, со скидкой клуба — 20 ₽).
-- Старая сигнатура без цены удаляется, у новой цена по умолчанию прежняя — 2500 копеек.
drop function if exists public.bot_review_spend(uuid, bigint, bigint);
create or replace function public.bot_review_spend(p_user uuid, p_point bigint, p_client bigint, p_kopecks bigint default 2500)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  result jsonb;
begin
  if p_kopecks is null or p_kopecks <= 0 then raise exception 'bad price'; end if;
  perform pg_advisory_xact_lock(hashtext('bot_review:' || p_user::text));
  if exists (select 1 from public.bot_review_reveals
              where user_id = p_user and point_id = p_point and client_id = p_client) then
    return jsonb_build_object('ok', true, 'free', true,
      'balance', coalesce((select balance_kopecks from public.wallet_accounts where user_id = p_user), 0));
  end if;
  result := public.wallet_spend(p_user, p_kopecks, 'review:' || p_user::text || ':' || p_point::text || ':' || p_client::text,
                                jsonb_build_object('point', p_point, 'client', p_client, 'kopecks', p_kopecks));
  if not (result->>'ok')::boolean then
    return jsonb_build_object('ok', false, 'free', false, 'balance', (result->>'balance')::bigint);
  end if;
  insert into public.bot_review_reveals(user_id, point_id, client_id) values (p_user, p_point, p_client)
    on conflict do nothing;
  return jsonb_build_object('ok', true, 'free', false, 'balance', (result->>'balance')::bigint);
end;
$$;
revoke all on function public.bot_review_spend(uuid,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.bot_review_spend(uuid,bigint,bigint,bigint) to service_role;

commit;
