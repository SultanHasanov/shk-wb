import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { createRequire } from 'node:module';
import { afterEach, beforeEach } from 'vitest';

// Память о ПК и токенах (server/_app-device-cache.js) не должна переживать тест: у каждого своя «база».
const deviceCache = createRequire(import.meta.url)('../../server/_app-device-cache.js') as { resetForTests: () => void };
beforeEach(() => deviceCache.resetForTests());

// Автоочистка RTL включается только при globals:true, а конфиг её не задаёт —
// без этого разметка предыдущих тестов копится в одном DOM и запросы находят
// по нескольку совпадений.
afterEach(cleanup);
