import { useNavigate } from 'react-router-dom';
import { GeneratorWorkspace } from '../GeneratorPage';
import { TelegramBotPromo } from '../../components/TelegramBotPromo';
import { useDocumentMeta } from '../../lib/seo';
import { useT } from '../../i18n';

/**
 * Генератор внутри кабинета: та же рабочая часть, что и на публичной главной,
 * но без лендинга. Раньше за созданием стикеров приходилось уходить на главную
 * и возвращаться в кабинет вручную.
 */
export function CabinetGeneratorPage() {
  const t = useT();
  useDocumentMeta(t('Генератор — кабинет', 'Генератор — кабинет'));
  const navigate = useNavigate();

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('Генератор', 'Генератор')}</h1>
        <p>
          {t(
            'Создавайте стикеры товаров и QR-коды возвратных коробок здесь же. Код доступа подставляется из ваших пакетов, а созданное попадает в «Историю генераций».',
            'Тауар стикерлері мен қайтару қораптарының QR-кодтарын осы жерде жасаңыз. Қолжетімділік коды пакеттеріңізден қойылады, ал жасалғандары «Генерациялар тарихына» түседі.',
          )}
        </p>
      </header>

      <GeneratorWorkspace onNeedPackages={() => navigate('/cabinet/packages')} />

      <div className="section">
        <TelegramBotPromo variant="compact" />
      </div>
    </div>
  );
}
