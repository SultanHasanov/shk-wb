const ACCESS_CODE_PATTERN = /^(?:\d{6}|STK-[A-F0-9]{32})$/;

function normalizeAccessCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isAccessCode(value) {
  return ACCESS_CODE_PATTERN.test(normalizeAccessCode(value));
}

function createAccessCode(crypto) {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

module.exports = { createAccessCode, isAccessCode, normalizeAccessCode };
