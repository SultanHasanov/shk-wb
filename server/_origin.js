function publicOrigin(req) {
  const configured=String(process.env.PUBLIC_APP_URL||'').trim().replace(/\/$/,'');
  if(configured)return configured;
  // VERCEL_URL — уникальный технический адрес каждого деплоя. В production
  // он не должен попадать в платёжные return_url и публичные ссылки.
  if(process.env.VERCEL_ENV==='production'){
    const production=String(process.env.VERCEL_PROJECT_PRODUCTION_URL||'shk-wb.vercel.app').trim().replace(/^https?:\/\//,'').replace(/\/$/,'');
    return `https://${production}`;
  }
  const vercel=String(process.env.VERCEL_URL||'').trim().replace(/^https?:\/\//,'').replace(/\/$/,'');
  if(vercel)return `https://${vercel}`;
  const host=String(req?.headers?.['x-forwarded-host']||req?.headers?.host||'').split(',')[0].trim().toLowerCase();
  if(/^[a-z0-9.-]+\.vercel\.app(?::\d+)?$/.test(host)||/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)||/^(www\.)?shk-wb\.(ru|vercel\.app)$/.test(host)){
    const proto=/^(localhost|127\.0\.0\.1)/.test(host)?'http':'https';return `${proto}://${host}`;
  }
  // Единственный домен, который сейчас обслуживает сайт. shk-wb.ru ещё не привязан
  // к проекту, поэтому держать его дефолтом нельзя: возврат из ЮKassa ушёл бы на чужой хост.
  return 'https://shk-wb.vercel.app';
}
module.exports={publicOrigin};
