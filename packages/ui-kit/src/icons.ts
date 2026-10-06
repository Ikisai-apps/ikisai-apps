/** Iconos de trazo (24×24, 1.9 px) compartidos por las apps. Las apps pueden registrar los suyos con `registerIcons`. */

const ICONS: Record<string, string> = {
  // Marca y navegación
  mark: '<path d="M7 3h7l4 4v14H7z" fill="rgba(255,255,255,.18)"/><path d="M14 3v4h4"/><path d="M9.5 12h5M9.5 16h3"/>',
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  tasks: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M3 6l1.2 1.2L6.5 4.8M3 12l1.2 1.2 2.3-2.4M3 18l1.2 1.2 2.3-2.4"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="8" rx="1.5"/>',
  tag: '<path d="M3 3h8.5L21 12.5 12.5 21 3 11.5z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  invoice: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9.5 12h5M9.5 16h5"/>',
  cart: '<path d="M3 4h2l2.4 11h11.2L21 7H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2"/>',
  user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0"/>',
  chef: '<path d="M8 15v5h8v-5"/><path d="M6.5 15a3.5 3.5 0 0 1-1-6.9A4.5 4.5 0 0 1 14 5.6 4 4 0 0 1 18.5 8a3.5 3.5 0 0 1-1 7z"/>',
  bed: '<path d="M3 18V7"/><path d="M3 12h18v6"/><path d="M3 15h18"/><circle cx="7.5" cy="9.5" r="1.8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  // Acciones
  sync: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 21v-5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 16l-5-5-7 7M3 18l4-4 3 3"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h11a6 6 0 0 1 0 12h-3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M4.5 12.5l4.5 4.5L19.5 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  filter: '<path d="M3 6h18M6 12h12M10 18h4"/>',
  logout: '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4M8 12h10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  more: '<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  grip: '<circle cx="9" cy="6" r="1.6" fill="currentColor"/><circle cx="15" cy="6" r="1.6" fill="currentColor"/><circle cx="9" cy="12" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/><circle cx="9" cy="18" r="1.6" fill="currentColor"/><circle cx="15" cy="18" r="1.6" fill="currentColor"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6"/><path d="M4 20h16"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
  attach: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.5"/>',
  star: '<path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.2 6.1L12 17l-5.5 2.9 1.2-6.1-4.5-4.2 6.1-.8z"/>',
  pin: '<path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z M12 14v7"/>',
  // Estado
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  offline: '<path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.3-2.6M15.5 10.5a10 10 0 0 1 3.5 2.5M12 20h.01"/>',
  online: '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 9.5a14 14 0 0 1 20 0M12 20h.01"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 8.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};

export type IconName = keyof typeof ICONS | (string & {});

/** Añade o sustituye iconos (las apps registran los suyos al arrancar). */
export function registerIcons(extra: Record<string, string>): void {
  Object.assign(ICONS, extra);
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}

/** SVG de trazo que hereda `currentColor`. Decorativo: `aria-hidden`; pon el texto accesible en el botón o el enlace. */
export function icon(name: IconName, size = 22): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name] ?? ICONS.help ?? '';
  return svg;
}
