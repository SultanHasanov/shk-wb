import { Button } from '../ui';
import {
  CELL_PRINT_SCOPE_OPTIONS,
  type CellPrintMarketplaceScope,
} from '../lib/pricing';

export function MarketplaceScopeToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: CellPrintMarketplaceScope;
  onChange: (value: CellPrintMarketplaceScope) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-3" role="group" aria-label="Для какого маркетплейса">
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
