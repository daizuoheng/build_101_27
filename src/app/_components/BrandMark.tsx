/**
 * Marca única de Radar Urbano (radar sobre el acento), en todas las pantallas. Decorativa: siempre va junto al
 * logotipo. La misma figura, con los colores fijos del tema, es el favicon (src/app/icon.svg).
 */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 36 36" className="shrink-0">
      <rect width="36" height="36" rx="8" className="fill-accent" />
      <g transform="translate(6 6)" fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-accent-ink">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 12 18 6" />
      </g>
    </svg>
  );
}
