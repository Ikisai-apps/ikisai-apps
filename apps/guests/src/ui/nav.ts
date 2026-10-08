/**
 * Módulos visibles y navegación (API.md §13.1) con la barra del kit 0.21 (U5): Inicio y los módulos que el organizador
 * haya activado en su ventana (antes, durante o después) van en la barra; el resto, en «Más» (como mucho cinco entradas en
 * el móvil). Sin módulos del organizador no hay barra (fase 1).
 */
import type { NavItem } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { inWindow } from '../app/portal.ts';
import { momentOf } from './home.ts';

export interface Modules { program: boolean; menu: boolean; lodging: boolean; materials: boolean; questions: boolean; map: boolean }

export function modulesOf(ctx: GuestContext): Modules {
  const m = ctx.experience()?.modules ?? {};
  const moment = momentOf(ctx.guest());
  return {
    program: Boolean(m.program?.visible && inWindow(m.program.window, moment)),
    menu: Boolean(m.menu?.visible && inWindow(m.menu.window, moment)),
    lodging: Boolean(m.lodging?.visible),
    materials: Boolean(m.materials?.visible),
    questions: Boolean(m.questions?.visible),
    map: Boolean(m.map?.visible),
  };
}

export function hasNav(mods: Modules): boolean {
  return mods.program || mods.menu || mods.lodging || mods.materials || mods.questions;
}

/** Secciones de la barra y de «Más» para una persona. Vacías sin módulos del organizador. */
export function navItems(ctx: GuestContext, base: string, mods: Modules): { nav: NavItem[]; more: NavItem[] } {
  if (!hasNav(mods)) return { nav: [], more: [] };
  const g = ctx.guest();
  const nav: NavItem[] = [
    { hash: base, label: t('nav.home'), icon: 'home', matches: [base] },
    ...(mods.program ? [{ hash: `${base}/programa`, label: t('nav.program'), icon: 'calendar' } as NavItem] : []),
    ...(mods.menu ? [{ hash: `${base}/menu`, label: t('nav.menu'), icon: 'chef' } as NavItem] : []),
    ...(mods.lodging ? [{ hash: `${base}/alojamiento`, label: t('nav.lodging'), icon: 'bed' } as NavItem] : []),
  ];
  const more: NavItem[] = [
    { hash: `${base}/info`, label: t('home.info'), icon: 'info' },
    ...(mods.materials ? [{ hash: `${base}/materiales`, label: t('materials.title'), icon: 'attach' } as NavItem] : []),
    ...(mods.questions ? [{ hash: `${base}/preguntas`, label: t('questions.title'), icon: 'help' } as NavItem] : []),
    ...(g.mode !== 'ninguno' ? [{ hash: `${base}/datos`, label: t('home.data'), icon: 'user' } as NavItem] : []),
    { hash: `${base}/alimentacion`, label: t('home.diet'), icon: 'chef' },
    ...(g.mode === 'ses' ? [{ hash: `${base}/firma`, label: t('home.sign'), icon: 'edit' } as NavItem] : []),
  ];
  return { nav, more };
}
