import { useNavigate } from 'react-router-dom';
import { GeneratorWorkspace } from '../GeneratorPage';
import { TelegramBotPromo } from '../../components/TelegramBotPromo';
import { useDocumentMeta } from '../../lib/seo';

/**
 * Генератор внутри кабинета: та же рабочая часть, что и на публичной главной,
 * но без лендинга. Раньше за созданием стикеров приходилось уходить на главную
 * и возвращаться в кабинет вручную.
 */
export function CabinetGeneratorPage() {
  useDocumentMeta('Генератор — кабинет');
  const navigate = useNavigate();

  return (
    <div className="page">
      <header className="page-head">
        <h1>Генератор</h1>
        <p>
          Создавайте стикеры товаров и QR-коды возвратных коробок здесь же. Код доступа
          подставляется из ваших пакетов, а созданное попадает в «Историю генераций».
        </p>
      </header>

      <GeneratorWorkspace onNeedPackages={() => navigate('/cabinet/packages')} />

      <div className="section">
        <TelegramBotPromo variant="compact" />
      </div>
    </div>
  );
}
