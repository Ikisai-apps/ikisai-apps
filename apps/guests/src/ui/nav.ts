/**
 * Módulos visibles y navegación (API.md §13.1; O4a, decisión del usuario del 13-10-2026).
 * - **Barra inferior:** «Calendario · Retiros · Más».
 * - **Secciones de cada retiro:** Resumen y los módulos que el organizador haya activado en su ventana (antes, durante o
 *   después): Programa, Menú y Alojamiento, en el mismo orden que la barra de antes.
 * - **«Más»:** lo del retiro que se está viendo, como antes (información práctica, materiales, preguntas, datos,
 *   alimentación y firma).
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

export type Section = 'inicio' | 'programa' | 'menu' | 'alojamiento';

/** Secciones de la pestaña de un retiro. Solo Resumen si el organizador no ha activado módulos (fase 1). */
export function sectionsOf(mods: Modules): Section[] {
  return ['inicio', ...(mods.program ? ['programa' as const] : []), ...(mods.menu ? ['menu' as const] : []), ...(mods.lodging ? ['alojamiento' as const] : [])];
}

export function sectionLabel(section: Section): string {
  return section === 'inicio' ? t('nav.summary') : section === 'programa' ? t('nav.program') : section === 'menu' ? t('nav.menu') : t('nav.lodging');
}

/** Barra inferior: Calendario y Retiros (la pestaña del retiro que se está viendo o el de entrada). */
export function barItems(retreats: { hash: string; matches: string[] } | null): NavItem[] {
  return [
    { hash: '#/calendario', label: t('nav.calendar'), icon: 'calendar', matches: ['#/calendario'] },
    ...(retreats ? [{ hash: retreats.hash, label: t('nav.retreats'), icon: 'home', matches: retreats.matches } as NavItem] : []),
  ];
}

/** «Más» del retiro que se está viendo. Con la familia junta (`family`), solo lo común; lo de cada persona sale en su Resumen. */
export function moreItems(ctx: GuestContext, base: string, mods: Modules, family = false): NavItem[] {
  const g = ctx.guest();
  return [
    { hash: `${base}/info`, label: t('guide.title'), icon: 'info' },
    ...(mods.materials ? [{ hash: `${base}/materiales`, label: t('materials.title'), icon: 'attach' } as NavItem] : []),
    ...(mods.questions && !family ? [{ hash: `${base}/preguntas`, label: t('questions.title'), icon: 'help' } as NavItem] : []),
    ...(g.mode !== 'ninguno' && !family ? [{ hash: `${base}/datos`, label: t('home.data'), icon: 'user' } as NavItem] : []),
    ...(!family ? [{ hash: `${base}/alimentacion`, label: t('home.diet'), icon: 'chef' } as NavItem] : []),
    ...(g.mode === 'ses' && !family ? [{ hash: `${base}/firma`, label: t('home.sign'), icon: 'edit' } as NavItem] : []),
  ];
}
