/**
 * «Lo que te falta por rellenar» del diseño (pasada única, zona 2). Puro: sale de los campos del borrador que ya existen
 * y no se guarda nunca. **No promete nada**: no dice que con esto llegue la propuesta.
 * - Lo usan Diseño (`ui/design.ts`) y el Resumen del retiro (paso «Diseña tu retiro», con `designPending`).
 * - Fuera, a propósito: menores (0 por defecto, no se distingue de «sin contestar»), espacios (casillas), extras y notas.
 * - Sin dependencias del navegador, para las pruebas de Node: los textos se traducen con el `t` que se pase (la clave es
 *   el español, como en el resto de la app) y los nombres del régimen y del menú, con `mealPlan` y `menuStyle`.
 */
import type { PortalDates, ReservationDetail } from './api.ts';

type Tr = (spanish: string, vars?: Record<string, string | number>) => string;
const plain: Tr = (s, vars) => s.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));

export type DesignCheckKey = 'fechas' | 'personas' | 'regimen' | 'menu';

/** A dónde lleva el botón: a la pestaña Fechas o a un campo del propio Diseño. */
export type DesignCheckTarget =
  | { kind: 'tab'; tab: 'fechas' }
  | { kind: 'field'; field: 'd-expected_guests' | 'd-meal_plan_requested' | 'd-menu_style_requested' };

export interface DesignCheck {
  key: DesignCheckKey;
  ok: boolean;
  text: string;
  detail: string;
  /** Botón para resolverla; el id de feedback va literal (catálogo de la publicación). */
  action: { label: string } & Record<'feedbackId', string>;
  target: DesignCheckTarget;
}

/** Lo que miran las comprobaciones (los nombres de los campos del borrador). */
export interface DesignCheckState {
  expected_guests: number | null;
  requires_meals: boolean;
  meal_plan_requested: string | null;
  menu_style_requested: string | null;
}

export function designStateOf(detail: Pick<ReservationDetail, 'expected_guests' | 'requires_meals' | 'meal_plan' | 'menu_style'>): DesignCheckState {
  return { expected_guests: detail.expected_guests ?? null, requires_meals: !!detail.requires_meals, meal_plan_requested: detail.meal_plan ?? null, menu_style_requested: detail.menu_style ?? null };
}

/** Fechas que ya le vienen bien al organizador: las de Ikisai marcadas y las que propuso él. */
export function markedDates(dates: PortalDates | null): number {
  return (dates?.options ?? []).filter((o) => o.organizer_ok || o.proposed_by === 'organizer').length;
}

export function designChecks(state: DesignCheckState, dates: PortalDates | null, options: { t?: Tr; mealPlan?: (v: string) => string; menuStyle?: (v: string) => string } = {}): DesignCheck[] {
  const t = options.t ?? plain;
  const fixed = dates?.mode === 'fixed' && !!dates.definitive;
  const marked = markedDates(dates);
  const guests = state.expected_guests ?? 0;
  const meals = !!state.requires_meals;
  return [
    {
      key: 'fechas', ok: fixed || marked > 0, text: t('Fechas posibles'),
      detail: fixed ? t('Fecha fijada por Ikisai.') : marked === 1 ? t('Has marcado 1 fecha posible.') : marked > 1 ? t('Has marcado {n} fechas posibles.', { n: marked }) : t('Marca al menos una fecha que te venga bien.'),
      action: { label: t('Ir a Fechas'), feedbackId: 'organizers.diseno.falta.fechas' }, target: { kind: 'tab', tab: 'fechas' },
    },
    {
      key: 'personas', ok: guests > 0, text: t('Cuántas personas venís'),
      detail: guests > 0 ? (guests === 1 ? t('1 persona prevista.') : t('{n} personas previstas.', { n: guests })) : t('Indica cuántas personas venís, aunque sea aproximado.'),
      action: { label: t('Ir a Personas'), feedbackId: 'organizers.diseno.falta.personas' }, target: { kind: 'field', field: 'd-expected_guests' },
    },
    {
      key: 'regimen', ok: !meals || !!state.meal_plan_requested, text: t('Régimen de comidas'),
      detail: !meals ? t('Sin comidas en Ikisai.') : state.meal_plan_requested ? (options.mealPlan?.(state.meal_plan_requested) ?? state.meal_plan_requested) : t('Elige el régimen: pensión completa, media pensión…'),
      action: { label: t('Ir a Comidas'), feedbackId: 'organizers.diseno.falta.regimen' }, target: { kind: 'field', field: 'd-meal_plan_requested' },
    },
    {
      key: 'menu', ok: !meals || !!state.menu_style_requested, text: t('Orientación del menú'),
      detail: !meals ? t('Sin comidas en Ikisai.') : state.menu_style_requested ? (options.menuStyle?.(state.menu_style_requested) ?? state.menu_style_requested) : t('Elige la orientación del menú: vegetariano, omnívoro…'),
      action: { label: t('Ir a Comidas'), feedbackId: 'organizers.diseno.falta.menu' }, target: { kind: 'field', field: 'd-menu_style_requested' },
    },
  ];
}

/**
 * Cuántas cosas faltan por rellenar del formulario de diseño (para el paso «Diseña tu retiro» del Resumen). Las fechas no
 * cuentan: en el Resumen tienen su propio paso, y contarlas dos veces inflaría lo que falta.
 */
export function designPending(detail: Pick<ReservationDetail, 'expected_guests' | 'requires_meals' | 'meal_plan' | 'menu_style'>, dates: PortalDates | null): number {
  return designChecks(designStateOf(detail), dates).filter((c) => !c.ok && c.key !== 'fechas').length;
}
