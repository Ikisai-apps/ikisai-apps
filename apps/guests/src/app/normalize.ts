/**
 * Formas de Organizers (docs/organizers/API.md §15) → formas de Guests (API.md §13). Organizers modela la experiencia como
 * filas de `organizers.experience_modules` con nombres en español (`programa`, `ver`, `antes`…) y `params`; Guests la
 * pinta con su propia forma. Se aceptan las dos mientras el contrato se cierra (petición O2), sin pedir a nadie que cambie.
 */
import type { Experience, LodgingCapability, Material, Question, QuestionType, Window } from './portal-types.ts';

const WINDOW: Record<string, Window> = { antes: 'before', durante: 'during', despues: 'after', después: 'after', siempre: 'always', before: 'before', during: 'during', after: 'after', always: 'always' };
const MODULE: Record<string, keyof Experience['modules']> = {
  programa: 'program', program: 'program', menu: 'menu', materiales: 'materials', materials: 'materials', preguntas: 'questions', questions: 'questions',
  alojamiento: 'lodging', lodging: 'lodging', info_practica: 'map', mapa: 'map', map: 'map',
};
const CAPABILITY: Record<string, LodgingCapability> = { ver: 'view', view: 'view', preferencia: 'prefer', prefer: 'prefer', elegir: 'choose', choose: 'choose', request: 'request', solicitar: 'request' };
const QUESTION_TYPE: Record<string, QuestionType> = {
  texto: 'text', text: 'text', opcion: 'choice', choice: 'choice', varias: 'multi', multi: 'multi', si_no: 'yes_no', yes_no: 'yes_no', numero: 'number', number: 'number', fecha: 'date', date: 'date',
};
const MATERIAL_KIND: Record<string, Material['kind']> = { archivo: 'file', file: 'file', enlace: 'link', link: 'link', texto: 'text', text: 'text' };

type Raw = Record<string, any>;

/** Experiencia: `{modules: {program: {...}}}` (Guests) o `{items|modules: [{module, visible, capability, window, params, position}]}` (Organizers). */
export function normalizeExperience(raw: unknown): Experience | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const rows: Raw[] | null = Array.isArray(r.items) ? r.items : Array.isArray(r.modules) ? r.modules : null;
  if (!rows) return r.modules && typeof r.modules === 'object' ? (r as Experience) : null;
  const out: Experience = { revision: Number(r.revision ?? 0), modules: {}, organizer_message: r.organizer_message ?? null };
  for (const row of [...rows].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))) {
    const key = MODULE[String(row.module ?? '')];
    if (!key) continue;
    const visible = row.visible !== false;
    const window = WINDOW[String(row.window ?? 'siempre')] ?? 'always';
    const params = (row.params ?? {}) as Raw;
    if (key === 'lodging') {
      const capability = CAPABILITY[String(row.capability ?? params.mode ?? 'ver')] ?? 'view';
      const note = typeof params.guest_price_text === 'string' ? params.guest_price_text : null;
      out.modules.lodging = { visible, capability, choose_until: params.choose_until ?? null, options: note ? [{ key: '', label: '', guest_note: note }] : [] };
    } else if (key === 'program' || key === 'menu') {
      out.modules[key] = { visible, window };
    } else {
      out.modules[key] = { visible };
    }
  }
  return out;
}

/** Pregunta: `{type, label, options: [{value, label}]}` (Guests) o `{kind, prompt, options: [texto]}` (Organizers). */
export function normalizeQuestion(raw: Raw): Question {
  const type = QUESTION_TYPE[String(raw.type ?? raw.kind ?? 'texto')] ?? 'text';
  const options = (Array.isArray(raw.options) ? raw.options : []).map((o: unknown) =>
    typeof o === 'string' ? { value: o, label: o } : { value: String((o as Raw).value), label: String((o as Raw).label ?? (o as Raw).value) });
  const answer = raw.answer !== undefined ? raw.answer : raw.value !== undefined ? { value: raw.value } : null;
  return {
    id: String(raw.id), revision: raw.revision, type, label: String(raw.label ?? raw.prompt ?? ''), help: raw.help ?? null, options,
    required: raw.required === true, open: raw.open !== false, answer: answer && typeof answer === 'object' && 'value' in answer ? answer : answer === null ? null : { value: answer },
  };
}

/** Material: `{kind: 'file', file: {...}}` (Guests) o `{kind: 'archivo', file_id, file_name?, mime?, size?}` (Organizers). */
export function normalizeMaterial(raw: Raw): Material {
  const kind = MATERIAL_KIND[String(raw.kind ?? 'texto')] ?? 'text';
  const fileId = raw.file?.id ?? raw.file_id ?? null;
  return {
    id: String(raw.id), kind, title: String(raw.title ?? ''), description: raw.description ?? null, window: WINDOW[String(raw.window ?? 'siempre')] ?? 'always',
    file: kind === 'file' && fileId ? { id: String(fileId), name: String(raw.file?.name ?? raw.file_name ?? raw.filename ?? raw.title ?? ''),
      mime: String(raw.file?.mime ?? raw.mime ?? 'application/octet-stream'), size: Number(raw.file?.size ?? raw.size ?? 0) } : null,
    url: raw.url ?? null, body: raw.body ?? null,
  };
}
