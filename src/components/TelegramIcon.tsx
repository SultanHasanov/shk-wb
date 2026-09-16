/** Фирменный самолётик Telegram: у lucide есть только обобщённый Send, а рядом
 *  с аватаркой канала нужен именно узнаваемый значок — как на боевом сайте. */
export function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9.04 15.47 8.7 20.2c.48 0 .69-.21.94-.46l2.26-2.16 4.68 3.43c.86.48 1.48.23 1.71-.79l3.1-14.54c.31-1.28-.46-1.78-1.3-1.47L1.6 9.9c-1.25.48-1.23 1.17-.21 1.48l4.66 1.45L17.2 6.5c.5-.31.96-.14.58.19z" />
    </svg>
  );
}
