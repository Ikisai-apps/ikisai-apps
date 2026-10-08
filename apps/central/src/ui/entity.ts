import type { RowOperation } from '@ikisai/sync-client';
import { compressImage, confirmDialog, el, formatDate, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { LOGO_MAX_BYTES, LOGO_MIME, formatIban, ibanProblem, normalizeIban, normalizeTaxId, taxIdProblem, validateOperations, type EntityRow } from '@ikisai/domain-central';
import { guard } from '../app/guard.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import { fbMark } from './feedback.ts';
import type { ViewMount } from './shell.ts';

type Row = Mirror<EntityRow & { id: string; revision: number; updated_at: string; deleted_at: string | null }>;
type LogoRef = string | { $blob: string } | null;

const text = (value: string) => value.trim() || null;
const isBlob = (ref: unknown): ref is { $blob: string } => !!ref && typeof ref === 'object' && typeof (ref as { $blob?: unknown }).$blob === 'string';

/** Logotipo listo para subir: tal cual si es PNG/JPEG/WebP de hasta 2 MB; si no, recomprimido (lado mayor 1600, WebP). */
async function prepareLogo(file: File): Promise<Blob> {
  if ((LOGO_MIME as readonly string[]).includes(file.type) && file.size <= LOGO_MAX_BYTES) return file;
  const out = await compressImage(file, { thumbSide: 0, quality: 0.9 });
  return out.full;
}

/**
 * Datos de la entidad (configuración común, API.md §2.9): razón social, NIF/CIF, domicilio fiscal y logotipo.
 * Los ve cualquier miembro de Central; solo el owner los edita. Booking y Finance los leen por su proyección.
 */
export const mountEntity: ViewMount = ({ main, client, isAdmin, usage }) => {
  let row: Row | null = null;
  let sheet: Sheet | null = null;
  const blobUrls = new Map<string, string>();
  const host = el('div', { id: 'entityView', 'data-feedback-id': 'central.entidad.contenido', 'data-feedback-label': 'Datos de la entidad' });
  replace(
    main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.entidad.cabecera', 'data-feedback-label': 'Cabecera de Entidad' }, el('div', null, el('h2', null, 'Entidad'),
      el('p', null, 'Los datos legales de Ikisai que usan las propuestas de Booking y las facturas emitidas de Finance.'))),
    host,
  );

  async function logoNode(ref: LogoRef, alt: string): Promise<HTMLElement | null> {
    if (!ref) return null;
    const img = el('img', { class: 'entitylogo', alt }) as HTMLImageElement;
    if (isBlob(ref)) {
      const url = blobUrls.get(ref.$blob);
      if (!url) return el('p', { class: 'muted' }, 'Logotipo pendiente de subir.');
      img.src = url;
      return img;
    }
    try {
      img.src = await client.fileUrl(ref);
      return img;
    } catch {
      return el('p', { class: 'muted' }, icon('offline', 16), ' El logotipo se verá con conexión.');
    }
  }

  function line(label: string, value: string | null | undefined, personal = false): HTMLElement | null {
    return value ? el('div', { class: 'kv' }, el('dt', null, label), el('dd', personal ? { 'data-feedback-ignore': '' } : null, value)) : null;
  }

  async function paint(): Promise<void> {
    if (!row) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.entidad.vacio', 'data-feedback-label': 'Entidad sin datos' },
        el('strong', null, 'Todavía no hay datos de la entidad'),
        isAdmin ? 'Escribe la razón social, el NIF/CIF y el domicilio fiscal, y sube el logotipo.' : 'Los rellena quien administra Central.',
        isAdmin ? el('button', { class: 'primary', type: 'button', id: 'editEntity', 'data-feedback-id': 'central.entidad.vacio.rellenar', 'data-feedback-label': 'Rellenar datos', onclick: () => openEditor() }, icon('edit', 18), 'Rellenar datos') : null));
      return;
    }
    const r = row;
    const address = [r.address_line, [r.postal_code, r.city].filter(Boolean).join(' '), r.province, r.country !== 'ES' ? r.country : null].filter(Boolean).join(', ');
    replace(host, el('section', { class: 'card entitycard', 'data-feedback-id': 'central.entidad.ficha', 'data-feedback-label': 'Ficha de la entidad' },
      (await logoNode(r.logo_file_id as LogoRef, `Logotipo de ${r.legal_name}`)) ?? el('p', { class: 'muted' }, 'Sin logotipo.'),
      el('dl', { class: 'kvlist', 'data-feedback-id': 'central.entidad.ficha.datos', 'data-feedback-label': 'Datos legales' },
        fbMark(line('Razón social', r.legal_name), 'central.entidad.ficha.razon_social', 'Razón social'),
        fbMark(line('Nombre comercial', r.trade_name), 'central.entidad.ficha.nombre_comercial', 'Nombre comercial'),
        fbMark(line('NIF/CIF', r.tax_id, true), 'central.entidad.ficha.nif', 'NIF/CIF'),
        fbMark(line('Domicilio fiscal', address, true), 'central.entidad.ficha.domicilio', 'Domicilio fiscal'),
        fbMark(line('Correo', r.email, true), 'central.entidad.ficha.correo', 'Correo'),
        fbMark(line('Teléfono', r.phone, true), 'central.entidad.ficha.telefono', 'Teléfono'),
        fbMark(line('Web', r.website), 'central.entidad.ficha.web', 'Web'),
        fbMark(line('IBAN', formatIban(r.iban), true), 'central.entidad.ficha.iban', 'IBAN'),
        fbMark(line('Bizum', r.bizum, true), 'central.entidad.ficha.bizum', 'Bizum')),
      el('p', { class: 'muted small', 'data-feedback-id': 'central.entidad.ficha.actualizado', 'data-feedback-label': 'Última actualización' }, `Actualizado ${formatDate(r.updated_at)}${r._pending ? ' · pendiente de sincronizar' : ''}`),
      isAdmin ? el('button', { class: 'ghost', type: 'button', id: 'editEntity', 'data-feedback-id': 'central.entidad.ficha.editar', 'data-feedback-label': 'Editar', onclick: () => openEditor() }, icon('edit', 18), 'Editar') : null));
  }

  async function load(): Promise<void> {
    const rows = (await client.list(T.entity)) as unknown as Row[];
    row = rows.find((r) => !r.deleted_at) ?? null;
    await paint();
  }

  function openEditor(): void {
    const current = row;
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.entidad.editar.error', 'data-feedback-label': 'Error del formulario' });
    const input = (id: string, value: string | null | undefined, attrs: Record<string, string | boolean> = {}) =>
      el('input', { id, type: 'text', value: value ?? '', ...attrs }) as HTMLInputElement;
    const legal = input('en-legal', current?.legal_name, { maxlength: '200', required: true });
    const trade = input('en-trade', current?.trade_name, { maxlength: '120' });
    const taxId = input('en-tax', current?.tax_id, { maxlength: '20', required: true, autocapitalize: 'characters', 'data-feedback-ignore': '' });
    const street = input('en-address', current?.address_line, { maxlength: '200', required: true, 'data-feedback-ignore': '' });
    const postal = input('en-postal', current?.postal_code, { maxlength: '12', required: true, inputmode: 'numeric' });
    const city = input('en-city', current?.city, { maxlength: '80', required: true });
    const province = input('en-province', current?.province, { maxlength: '80' });
    const country = input('en-country', current?.country ?? 'ES', { maxlength: '2' });
    const email = input('en-email', current?.email, { maxlength: '320', type: 'email', 'data-feedback-ignore': '' });
    const phone = input('en-phone', current?.phone, { maxlength: '32', type: 'tel', 'data-feedback-ignore': '' });
    const web = input('en-web', current?.website, { maxlength: '200', placeholder: 'https://' });
    const iban = input('en-iban', formatIban(current?.iban), { maxlength: '42', placeholder: 'ES00 0000 0000 0000 0000 0000', autocomplete: 'off', 'data-feedback-ignore': '' });
    const bizum = input('en-bizum', current?.bizum, { maxlength: '20', inputmode: 'tel', autocomplete: 'off', 'data-feedback-ignore': '' });
    let logo: LogoRef = (current?.logo_file_id as LogoRef) ?? null;
    let stagedLogo: Blob | null = null;
    const logoPreview = el('div', { class: 'logopreview', 'data-feedback-id': 'central.entidad.editar.logotipo_vista', 'data-feedback-label': 'Vista del logotipo' });
    const logoInput = el('input', { id: 'en-logo', type: 'file', accept: LOGO_MIME.join(','), class: 'visually-hidden', 'data-feedback-id': 'central.entidad.editar.logotipo_archivo', 'data-feedback-label': 'Archivo del logotipo' }) as HTMLInputElement;
    const paintLogo = async () => {
      if (stagedLogo) {
        const url = URL.createObjectURL(stagedLogo);
        replace(logoPreview, el('img', { class: 'entitylogo', src: url, alt: 'Logotipo nuevo' }));
      } else {
        replace(logoPreview, (await logoNode(logo, 'Logotipo actual')) ?? el('span', { class: 'muted' }, 'Sin logotipo'));
      }
    };
    logoInput.addEventListener('change', async () => {
      const file = logoInput.files?.[0];
      if (!file) return;
      try {
        stagedLogo = await prepareLogo(file);
        guard.dirtyEditor = true;
        sheet?.setFootHidden(false);
        await paintLogo();
      } catch {
        error.textContent = 'No se pudo leer esa imagen. Prueba con un PNG o un JPEG.';
      }
    });
    void paintLogo();

    const values = (): Record<string, unknown> => ({
      legal_name: legal.value.trim(), trade_name: text(trade.value), tax_id: normalizeTaxId(taxId.value), address_line: street.value.trim(),
      postal_code: postal.value.trim(), city: city.value.trim(), province: text(province.value), country: country.value.trim().toUpperCase() || 'ES',
      email: text(email.value), phone: text(phone.value), website: text(web.value),
      iban: iban.value.trim() ? normalizeIban(iban.value) : null, bizum: text(bizum.value),
    });
    const changed = (): Record<string, unknown> => {
      const all = values();
      if (!current) return all;
      return Object.fromEntries(Object.entries(all).filter(([key, value]) => (current[key] ?? null) !== (value ?? null)));
    };
    const refreshDirty = () => {
      const dirty = Object.keys(changed()).length > 0 || stagedLogo !== null;
      guard.dirtyEditor = current ? dirty : values().legal_name !== '';
      sheet?.setFootHidden(current !== null && !dirty);
      const problem = taxId.value.trim() && country.value.trim().toUpperCase() === 'ES' ? taxIdProblem(taxId.value) : null;
      taxId.setCustomValidity(problem ? `NIF/CIF: ${problem}` : '');
      const ibanIssue = iban.value.trim() ? ibanProblem(iban.value) : null;
      iban.setCustomValidity(ibanIssue ? `IBAN: ${ibanIssue}` : '');
    };

    const newId = crypto.randomUUID();
    const save = el('button', { class: 'primary', type: 'submit', id: 'saveEntity', form: 'entityForm', 'data-feedback-id': 'central.entidad.editar.guardar', 'data-feedback-label': 'Guardar' }, 'Guardar') as HTMLButtonElement;
    const form = el('form', { novalidate: true, id: 'entityForm', 'data-feedback-id': 'central.entidad.editar.formulario', 'data-feedback-label': 'Formulario de la entidad', oninput: refreshDirty, onchange: refreshDirty,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        const fields = changed();
        save.disabled = true;
        try {
          // Se valida antes de encolar el logotipo: un dato erróneo no debe dejar un archivo pendiente en la cola.
          const operationsWith = (logoRef: unknown): RowOperation[] => {
            const all = stagedLogo ? { ...fields, logo_file_id: logoRef } : fields;
            return current
              ? [{ op: 'update', table: T.entity, id: current.id, expectedRevision: current.revision, fields: all }]
              : [{ op: 'insert', table: T.entity, id: newId, fields: all }];
          };
          const issue = validateOperations(operationsWith({ $blob: 'pendiente' }), client.bootstrap()?.membership ?? { role: 'reader' }, () => current ?? undefined);
          if (issue) {
            error.textContent = issue.message.replace(/^Campo (\w+)/, (_, f: string) => `«${LABELS[f] ?? f}»`);
            error.scrollIntoView({ block: 'nearest' });
            return;
          }
          let logoRef: unknown = null;
          if (stagedLogo) {
            const mime = stagedLogo.type || 'image/png';
            const sha = await client.stageBlob(stagedLogo, { filename: `logotipo.${mime.split('/')[1] ?? 'png'}`, mime });
            blobUrls.set(sha, URL.createObjectURL(stagedLogo));
            logoRef = { $blob: sha };
          }
          const operations = operationsWith(logoRef);
          await usage.run('central.entidad.guardar', () => client.commit(operations));
          toast(!navigator.onLine ? 'Datos guardados en este dispositivo. Se sincronizarán cuando haya red.' : 'Datos de la entidad guardados.');
          guard.dirtyEditor = false;
          await sheet?.close(true);
          await load();
        } catch (e) {
          error.textContent = describeError(e);
          error.scrollIntoView({ block: 'nearest' });
        } finally {
          save.disabled = false;
        }
      } },
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_razon_social', 'data-feedback-label': 'Razón social' }, el('span', null, 'Razón social'), legal),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_nombre_comercial', 'data-feedback-label': 'Nombre comercial' }, el('span', null, 'Nombre comercial (opcional)'), trade),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_nif', 'data-feedback-label': 'NIF/CIF' }, el('span', null, 'NIF/CIF'), taxId),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_domicilio', 'data-feedback-label': 'Domicilio fiscal' }, el('span', null, 'Domicilio fiscal'), street),
      el('div', { class: 'fieldrow' },
        el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_codigo_postal', 'data-feedback-label': 'Código postal' }, el('span', null, 'Código postal'), postal),
        el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_municipio', 'data-feedback-label': 'Municipio' }, el('span', null, 'Municipio'), city)),
      el('div', { class: 'fieldrow' },
        el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_provincia', 'data-feedback-label': 'Provincia' }, el('span', null, 'Provincia'), province),
        el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_pais', 'data-feedback-label': 'País' }, el('span', null, 'País'), country)),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_correo', 'data-feedback-label': 'Correo' }, el('span', null, 'Correo (opcional)'), email),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_telefono', 'data-feedback-label': 'Teléfono' }, el('span', null, 'Teléfono (opcional)'), phone),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_web', 'data-feedback-label': 'Web' }, el('span', null, 'Web (opcional)'), web),
      el('div', { class: 'sectionlabel' }, 'Para cobrar'),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_iban', 'data-feedback-label': 'IBAN' }, el('span', null, 'IBAN (opcional)'), iban,
        el('span', { class: 'muted small' }, 'Sale en las instrucciones de pago de los portales ({{entidad.iban}}).')),
      el('label', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_bizum', 'data-feedback-label': 'Bizum' }, el('span', null, 'Bizum (opcional)'), bizum,
        el('span', { class: 'muted small' }, 'Teléfono o código Bizum ({{entidad.bizum}}).')),
      el('div', { class: 'field', 'data-feedback-id': 'central.entidad.editar.campo_logotipo', 'data-feedback-label': 'Logotipo' }, el('span', null, 'Logotipo'), logoPreview,
        el('label', { class: 'ghost btnlike', for: 'en-logo', 'data-feedback-id': 'central.entidad.editar.elegir_imagen', 'data-feedback-label': 'Elegir imagen' }, icon('upload', 18), 'Elegir imagen'), logoInput,
        el('span', { class: 'muted small' }, 'PNG, JPEG o WebP. Si pesa más de 2 MB se reduce al subirlo.')),
      error,
    );

    sheet = openSheet({
      panelAttrs: { 'data-feedback-id': 'central.entidad.editar', 'data-feedback-label': 'Editar datos de la entidad' },
      closeAttrs: { 'data-feedback-id': 'central.entidad.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
      title: current ? 'Editar datos de la entidad' : 'Datos de la entidad',
      meta: current ? `Revisión ${current.revision}` : undefined,
      body: form,
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.entidad.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, current ? 'Cerrar' : 'Cancelar'), save],
      footHidden: current !== null,
      initialFocus: legal,
      beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
    });
  }

  void load();
  const off = client.onTable(T.entity, () => void load());
  return () => {
    off();
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
  };
};

const LABELS: Record<string, string> = {
  legal_name: 'Razón social', trade_name: 'Nombre comercial', tax_id: 'NIF/CIF', address_line: 'Domicilio fiscal', postal_code: 'Código postal',
  city: 'Municipio', province: 'Provincia', country: 'País', email: 'Correo', phone: 'Teléfono', website: 'Web', logo_file_id: 'Logotipo',
};
