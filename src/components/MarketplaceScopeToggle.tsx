import { Button } from '../ui';
import {
  CELL_PRINT_SCOPE_OPTIONS,
  type CellPrintMarketplaceScope,
} from '../lib/pricing';
import { useT } from '../i18n';

export function MarketplaceScopeToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: CellPrintMarketplaceScope;
  onChange: (value: CellPrintMarketplaceScope) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="grid grid-3" role="group" aria-label={t('Для какого маркетплейса', 'Қай маркетплейс үшін')}>
      {CELL_PRINT_SCOPE_OPTIONS.map(option => (
        <Button
          key={option.value}
          type="button"
          block
          variant={value === option.value ? 'primary' : 'secondary'}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
