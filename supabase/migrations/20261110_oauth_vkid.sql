-- Вход через Mail.ru поверх VK ID (provider = 'vkid'); см. server/_oauth-login.js.
begin;
alter table public.user_oauth_identities drop constraint if exists user_oauth_identities_provider_check;
alter table public.user_oauth_identities add constraint user_oauth_identities_provider_check check (provider in ('yandex', 'mailru', 'vkid'));
commit;
