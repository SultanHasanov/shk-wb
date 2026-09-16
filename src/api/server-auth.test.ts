import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';

const require=createRequire(import.meta.url);
const root=resolve(__dirname,'../..');
const { publicOrigin }=require('../../server/_origin.js') as {publicOrigin:(req:{headers:Record<string,string>})=>string};
const auth=require('../../server/_user-auth.js') as {referralCookie:(code:string)=>string;readReferralCookie:(req:{headers:{cookie:string}})=>string|null;requireUser:(req:{headers:Record<string,string>},res:{status:(status:number)=>{json:(body:unknown)=>unknown}})=>Promise<unknown>};

describe('серверный контур кабинета',()=>{
  afterEach(()=>{delete process.env.PUBLIC_APP_URL;delete process.env.VERCEL_URL;delete process.env.VERCEL_ENV;delete process.env.VERCEL_PROJECT_PRODUCTION_URL;delete process.env.REFERRAL_COOKIE_SECRET;vi.restoreAllMocks()});
  it('использует VERCEL_URL для preview-ссылок',()=>{process.env.VERCEL_URL='shk-wb-git-feature-team.vercel.app';expect(publicOrigin({headers:{}})).toBe('https://shk-wb-git-feature-team.vercel.app')});
  it('использует постоянный домен проекта в production',()=>{process.env.VERCEL_ENV='production';process.env.VERCEL_URL='shk-random-deploy.vercel.app';process.env.VERCEL_PROJECT_PRODUCTION_URL='shk-wb.vercel.app';expect(publicOrigin({headers:{}})).toBe('https://shk-wb.vercel.app')});
  it('формирует реферальные ссылки только на постоянном публичном домене',()=>{
    const cabinet=readFileSync(resolve(root,'api/cabinet.js'),'utf8');
    expect(cabinet).toMatch(/const REFERRAL_ORIGIN\s*=[^\n]*'https:\/\/shk-wb\.vercel\.app'/);
    // Любой origin, выведенный из запроса, снова привяжет ссылку к адресу сборки,
    // поэтому проверяем не конкретный вызов, а отсутствие такого источника вообще.
    expect(cabinet).not.toMatch(/publicOrigin/);
    const links=cabinet.match(/[^\n]*\/r\/\$\{[^\n]*/g)||[];
    expect(links).toHaveLength(1);
    for(const line of links)expect(line).toContain('${REFERRAL_ORIGIN}/r/${');
  });
  it('подписывает и проверяет реферальную cookie',()=>{process.env.REFERRAL_COOKIE_SECRET='test-secret-at-least-thirty-two-bytes';const value=auth.referralCookie('ABCDEF12');expect(auth.readReferralCookie({headers:{cookie:`x=1; shk_ref=${encodeURIComponent(value)}`}})).toBe('ABCDEF12');expect(auth.readReferralCookie({headers:{cookie:`shk_ref=${encodeURIComponent(value)}broken`}})).toBeNull()});
  it('отклоняет запрос кабинета без Bearer-токена',async()=>{const json=vi.fn();const status=vi.fn(()=>({json}));await expect(auth.requireUser({headers:{}},{status})).resolves.toBeNull();expect(status).toHaveBeenCalledWith(401);expect(json).toHaveBeenCalledWith(expect.objectContaining({code:'AUTH_REQUIRED'}))});
});
