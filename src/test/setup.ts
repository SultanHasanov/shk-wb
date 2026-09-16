import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Автоочистка RTL включается только при globals:true, а конфиг её не задаёт —
// без этого разметка предыдущих тестов копится в одном DOM и запросы находят
// по нескольку совпадений.
afterEach(cleanup);
