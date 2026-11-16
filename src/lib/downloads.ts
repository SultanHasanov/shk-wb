/**
 * Открытые ссылки на установщики. Обе программы скачиваются бесплатно: платными
 * остались ключи и итерации, без которых .exe не работает.
 *
 * Токеновый /api/payments/download здесь намеренно не упоминается — он остался
 * только для заказов, оплаченных до перехода на бесплатное скачивание.
 */
export const PROGRAM_DOWNLOAD_URL = '/api/payments/download-program';

export const CELL_PRINT_DOWNLOAD_URL = '/api/payments/download-cell-print';

/** Запуск «Помощника ПВЗ» для Linux: скрипт качает программу в ~/.cache, сверяет sha256 и запускает. */
export const LINUX_INSTALL_COMMAND = 'curl -fsSL https://shk-wb.ru/dl/linux.sh | sh';
