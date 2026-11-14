// У пакета qrcode нет своих типов, а @types/qrcode в зависимости не тянем ради одной функции.
declare module 'qrcode' {
  export function create(
    text: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
  ): { modules: { size: number; data: Uint8Array | boolean[] } };
  const QRCode: { create: typeof create };
  export default QRCode;
}
