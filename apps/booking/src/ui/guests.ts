/** Huéspedes (canon §10): recuentos, registro de viajeros, firma del parte y cola de envío a SES.Hospedajes. */
import type { RowOperation, SyncedRow, TableName } from '@ikisai/sync-client';
import { compressImage, compressedFilename, confirmDialog, el, formatDate, icon, isImageFile, listRow, openSheet, plural, replace, toast, type Child, type Sheet } from '@ikisai/ui-kit';
import { OPERATIVE_GUEST_FIELDS, READS, TABLES, canSeeGuests, dayNumber, fieldSource, guestCompleteness, guestModeOf, missingForSes, reservationCompleteness, signsOwnEntry, type GuestLike } from '@ikisai/domain-booking';
import { EVENTS, GUESTS, RESERVATIONS, FINANCE, canRead, canWrite, dateRange, describeError, today, type ReservationRow } from '../app/client.ts';
import { OPTIONS, label } from '../app/labels.ts';
import { PV_IN_PROCESS, fetchSes, guestReports, type SesCommunication } from '../app/ses.ts';
import { guestReminder, missingLabels, organizerReminder, SOURCE_LABELS, SOURCE_TITLES } from '../app/reminders.ts';
import { openRowSheet, type FieldMark, type FieldSpec } from './form.ts';
import { RESTRICTION_SPECS } from './reservation.ts';
import type { ViewMount } from './shell.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';

type Row = SyncedRow & Record<string, any>;
const RESTRICTIONS: TableName = TABLES.restrictions;
/** Restricciones de un huésped concreto: la regla del dominio es `guest_id` o `servings`, nunca los dos. */
const GUEST_RESTRICTION_SPECS: FieldSpec[] = RESTRICTION_SPECS.filter((spec) => spec.key !== 'servings');

const PERSONAL_KEYS = new Set(['first_name', 'last_name_1', 'last_name_2', 'birth_date', 'nationality', 'document_type', 'document_number', 'document_support_number', 'residence_address', 'residence_postal_code', 'residence_city', 'residence_country', 'guardian_name', 'kinship', 'notes']);
const GUEST_SPECS: FieldSpec[] = [  { key: 'first_name', label: 'Nombre', type: 'text', max: 120, section: 'Identidad' },
  { key: 'last_name_1', label: 'Primer apellido', type: 'text', max: 120 },
  { key: 'last_name_2', label: 'Segundo apellido', type: 'text', max: 120 },
  { key: 'sex', label: 'Sexo', type: 'select', options: OPTIONS.sex, optional: true },
  { key: 'birth_date', label: 'Fecha de nacimiento', type: 'date' },
  { key: 'nationality', label: 'Nacionalidad (código de tres letras)', type: 'text', max: 3, upper: true, hint: 'ESP, FRA, DEU…' },
  { key: 'document_type', label: 'Tipo de documento', type: 'select', options: OPTIONS.documentType, optional: true, section: 'Documento' },
  { key: 'document_number', label: 'Número de documento', type: 'text', max: 40, upper: true },
  { key: 'document_support_number', label: 'Número de soporte', type: 'text', max: 40, upper: true, hint: 'Obligatorio con DNI o NIE.' },
  { key: 'residence_address', label: 'Dirección', type: 'text', max: 300, section: 'Residencia y contacto' },
  { key: 'residence_postal_code', label: 'Código postal', type: 'text', max: 20 },
  { key: 'residence_city', label: 'Municipio', type: 'text', max: 120 },
  { key: 'residence_country', label: 'País (código de tres letras)', type: 'text', max: 3, upper: true },
  { key: 'phone', label: 'Teléfono', type: 'tel', max: 40 },
  { key: 'email', label: 'Correo', type: 'email', max: 320 },
  { key: 'is_minor', label: 'Es menor de edad', type: 'check', section: 'Menores' },
  { key: 'guardian_name', label: 'Persona que le acompaña', type: 'text', max: 200 },
  { key: 'kinship', label: 'Parentesco', type: 'text', max: 80, hint: 'Obligatorio si es menor: madre, padre, abuela…' },
  { key: 'data_status', label: 'Estado de los datos', type: 'select', options: OPTIONS.dataStatus, section: 'Estado' },
  { key: 'notes', label: 'Notas', type: 'textarea' },
].map((spec): FieldSpec => (PERSONAL_KEYS.has(spec.key) ? { ...(spec as FieldSpec), personal: true } : (spec as FieldSpec)));

/** Sin SES solo se piden nombre, primer apellido, teléfono y correo (minimización: nada de documento, dirección, nacimiento ni firma). */
const OPERATIVE_SPECS: FieldSpec[] = GUEST_SPECS.filter((spec) => (OPERATIVE_GUEST_FIELDS as readonly string[]).includes(spec.key)).map((spec) => { const { section: _omit, ...rest } = spec; return spec.key === 'first_name' ? { ...rest, section: 'Contacto' } : rest; });

const SENT_SPECS: FieldSpec[] = [
  { key: 'ses_sent_by', label: 'Quién lo envió', type: 'text', max: 200, personal: true },
  { key: 'ses_receipt_ref', label: 'Referencia o enlace del justificante', type: 'text', max: 500, personal: true },
];

const fullName = (g: Row): string => [g.first_name, g.last_name_1, g.last_name_2].filter(Boolean).join(' ');
const missingText = (guest: Record<string, unknown>): string => missingLabels(missingForSes(guest)).join(', ');
const plain = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Lo que le falta a un huésped para entrar en el parte de viajeros: campos de SES, documento comprobado (adultos) y firma (14 años o más). Igual que `GET /ses/:id/pv`. */
function arrivalNeeds(guest: Row, onDate: string): string[] {
  const missing = missingForSes(guest as GuestLike);
  if (guest.is_minor !== true && !guest.document_checked_at) missing.push('document_checked');
  if (signsOwnEntry(guest as GuestLike, onDate) && !guest.signed_at) missing.push('signature');
  return missing;
}

/** Modo de la reserva para pedir datos: hoy siempre `ses`; cuando llegue el interruptor de SES se cambia solo aquí. */

/** Marca discreta con el origen de un dato (`field_sources`): Huésped, Organizador o Personal. */
function sourceChip(by: 'guest' | 'organizer' | 'staff' | null, inLabel = false): Child {
  // Dentro de la etiqueta de un campo no cuenta para su nombre accesible (sería «Nombre Personal»).
  return by ? el('small', { class: 'src', dataset: { by }, title: SOURCE_TITLES[by], ...(inLabel ? { 'aria-hidden': 'true' } : {}) }, SOURCE_LABELS[by]) : null;
}
const asSource = (value: unknown): 'guest' | 'organizer' | 'staff' | null => (value === 'guest' || value === 'organizer' || value === 'staff' ? value : null);
const fieldMark = (guest: Row | null): FieldMark | undefined => (guest ? (key) => (guest[key] === null || guest[key] === undefined || guest[key] === '' ? null : sourceChip(fieldSource(guest as { field_sources?: Record<string, { by?: string }> | null }, key), true)) : undefined);
const yesNo = (value: unknown): string => (value === true ? 'sí' : 'no');

/** Lienzo para firmar con el dedo o el ratón. Devuelve el PNG o null si está vacío. */
function signaturePad(): { element: HTMLElement; clear(): void; toBlob(): Promise<Blob | null> } {
  const canvas = el('canvas', { class: 'signature', id: 'signaturePad', 'data-feedback-id': 'booking.huespedes.firma.recuadro', 'data-feedback-label': 'Recuadro de firma', 'data-feedback-ignore': '', width: 600, height: 240, 'aria-label': 'Recuadro de firma' });
  const ctx = canvas.getContext('2d')!;
  let drawing = false;
  let empty = true;
  const point = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    return [(event.clientX - box.left) * (canvas.width / box.width), (event.clientY - box.top) * (canvas.height / box.height)] as const;
  };
  canvas.addEventListener('pointerdown', (event) => { drawing = true; canvas.setPointerCapture(event.pointerId); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#1d2a1c'; ctx.beginPath(); ctx.moveTo(...point(event)); event.preventDefault(); });
  canvas.addEventListener('pointermove', (event) => { if (!drawing) return; ctx.lineTo(...point(event)); ctx.stroke(); empty = false; });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return {
    element: canvas,
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
    toBlob: () => new Promise((resolve) => (empty ? resolve(null) : canvas.toBlob((blob) => resolve(blob), 'image/png'))),
  };
}

export function mountGuests(initialEventId: string | null): ViewMount {
  return ({ main, client, navigate }) => {
    const boot = client.bootstrap();
    const allowed = boot ? canSeeGuests(boot.membership) : false;
    const writable = allowed && canWrite(client);
    let eventId = initialEventId;
    let sheet: Sheet | null = null;
    /** Partes de viajeros de la reserva del evento abierto (solo con red); lo demás de la llegada sale de las filas locales. */
    let ses: { eventId: string; reservationId: string; comms: SesCommunication[] } | null = null;
    let sesSeq = 0;
    let marking = false;
    let busyPv = false;
    let pvResult: { eventId: string; pending: Array<{ id: string; missing: string[] }>; empty: boolean } | null = null;
    let sesTarget: { eventId: string; reservationId: string } | null = null;
    const selectHost = el('div', { 'data-feedback-id': 'booking.huespedes.evento', 'data-feedback-label': 'Selector de evento' });
    const body = el('div', { 'data-feedback-id': 'booking.huespedes.lista', 'data-feedback-label': 'Huéspedes del evento' });
    const printArea = el('div', { class: 'printarea', 'aria-hidden': 'true', 'data-feedback-ignore': '' });

    replace(main,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Huéspedes'), el('p', null, 'Registro de viajeros, firma del parte y envío a SES.Hospedajes.'))),
      selectHost, body, printArea);

    async function run(operations: RowOperation[], message: string): Promise<boolean> {
      try {
        await client.commit(operations);
        toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
        return true;
      } catch (error) {
        toast(describeError(error));
        return false;
      }
    }

    function openSign(guest: Row, onDate: string): void {
      const own = signsOwnEntry(guest as GuestLike, onDate);
      const pad = signaturePad();
      const signer = el('input', { id: 'signerName', type: 'text', 'data-feedback-id': 'booking.huespedes.firma.nombre', 'data-feedback-label': 'Quién firma', maxlength: 200, value: own ? fullName(guest) : guest.guardian_name ?? '' });
      const error = el('p', { class: 'formerror', role: 'alert', hidden: true });
      const save = el('button', { class: 'primary', type: 'button', id: 'saveSignature', 'data-feedback-id': 'booking.huespedes.firma.guardar', 'data-feedback-label': 'Guardar firma', onclick: async () => {
        const blob = await pad.toBlob();
        const name = signer.value.trim();
        if (!blob || !name) { error.hidden = false; error.textContent = !blob ? 'Falta la firma en el recuadro.' : 'Indica quién firma.'; return; }
        // La imagen espera en la cola de adjuntos; el marcador se cambia por el id del archivo al subirla.
        const sha = await client.stageBlob(blob, { filename: `firma-${guest.code ?? guest.id}.png`, mime: 'image/png' });
        const ok = await run([{ op: 'update', table: GUESTS, id: guest.id, expectedRevision: guest.revision, fields: { signature_file_id: { $blob: sha }, signed_at: new Date().toISOString(), signed_by_name: name } }], 'Firma guardada.');
        if (ok) await sheet?.close(true);
      } }, 'Guardar firma');
      sheet = openSheet({
        title: 'Firma del parte de entrada',
        body: el('div', { 'data-feedback-id': 'booking.huespedes.firma', 'data-feedback-label': 'Firma del parte' },
          el('dl', { class: 'kv', 'data-feedback-id': 'booking.huespedes.firma.datos', 'data-feedback-label': 'Datos del huésped', 'data-feedback-ignore': '' }, el('dt', null, 'Huésped'), el('dd', null, fullName(guest)), el('dt', null, 'Documento'), el('dd', null, [guest.document_type, guest.document_number].filter(Boolean).join(' ') || '—'),
            el('dt', null, 'Nacimiento'), el('dd', null, guest.birth_date ?? '—')),
          el('p', { class: 'hint' }, 'Al firmar confirmas que estos datos son correctos. Se recogen para el registro de viajeros que exige el RD 933/2021 y se comunican a las Fuerzas y Cuerpos de Seguridad. No se guarda copia de tu documento.'),
          own ? null : el('p', { class: 'hint' }, 'Por su edad, firma la persona que le acompaña.'),
          pad.element,
          el('label', { class: 'field', 'data-feedback-id': 'booking.huespedes.firma.campo_nombre', 'data-feedback-label': 'Nombre de quien firma', 'data-feedback-ignore': '' }, el('span', null, 'Firma'), signer),
          error),
        foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.huespedes.firma.borrar', 'data-feedback-label': 'Borrar', onclick: () => pad.clear() }, 'Borrar'), el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.huespedes.firma.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close(true) }, 'Cancelar')),
        onClose: () => { sheet = null; },
      });
    }

    function printEntry(guest: Row, reservation: ReservationRow, event: Row): void {
      const line = (term: string, value: unknown) => el('tr', null, el('th', null, term), el('td', null, value === null || value === undefined || value === '' ? '' : String(value)));
      replace(printArea,
        el('h1', null, 'Parte de entrada de viajeros'),
        el('p', null, `${reservation.title} · ${reservation.code ?? ''} · ${event.code ?? ''} · ${dateRange(reservation)}`),
        el('table', null, el('tbody', null,
          line('Nombre', guest.first_name), line('Primer apellido', guest.last_name_1), line('Segundo apellido', guest.last_name_2), line('Sexo', label(guest.sex)),
          line('Documento', [guest.document_type, guest.document_number].filter(Boolean).join(' ')), line('Número de soporte', guest.document_support_number),
          line('Nacionalidad', guest.nationality), line('Fecha de nacimiento', guest.birth_date),
          line('Residencia', [guest.residence_address, guest.residence_postal_code, guest.residence_city, guest.residence_country].filter(Boolean).join(', ')),
          line('Teléfono', guest.phone), line('Correo', guest.email),
          guest.is_minor ? line('Acompañante y parentesco', [guest.guardian_name, guest.kinship].filter(Boolean).join(' · ')) : null)),
        el('p', { class: 'legal' }, 'Datos recogidos para el registro de viajeros que exige el RD 933/2021. No se conserva copia del documento de identidad.'),
        el('p', { class: 'signline' }, 'Fecha y firma:'));
      window.print();
    }

    async function openRestriction(guest: Row, restriction: Row | null, context: { reservation: ReservationRow; event: Row; restrictions: Row[] }): Promise<void> {
      if (!(await sheet?.close())) return;
      sheet = openRowSheet({
        client, title: restriction ? 'Restricción de ' + fullName(guest) : 'Nueva restricción', table: RESTRICTIONS, row: restriction, specs: GUEST_RESTRICTION_SPECS, feedbackId: restriction ? 'booking.huespedes.restriccion' : 'booking.huespedes.nueva_restriccion', feedbackLabel: restriction ? 'Editar restricción' : 'Nueva restricción',
        defaults: { restriction_type: 'vegetariano', active: true }, insertFields: { event_id: context.event.id, guest_id: guest.id },
        ...(restriction ? { remove: { label: 'Quitar', operations: () => [{ op: 'delete', table: RESTRICTIONS, id: restriction.id, expectedRevision: restriction.revision } as RowOperation] } } : {}),
        savedMessage: 'Restricción guardada.',
      });
    }

    function restrictionsBlock(guest: Row, context: { reservation: ReservationRow; event: Row; restrictions: Row[] }): Child {
      const own = context.restrictions.filter((r) => r.guest_id === guest.id);
      return el('div', { id: 'guestRestrictions', class: 'formsection', 'data-feedback-id': 'booking.huespedes.ficha.restricciones', 'data-feedback-label': 'Restricciones alimentarias' },
        el('div', { class: 'sectionlabel' }, 'Restricciones alimentarias', el('span', { class: 'count' }, String(own.length))),
        own.length === 0 ? el('p', { class: 'hint' }, 'Ninguna registrada.') : el('ul', { class: 'list' }, own.map((r) => el('li', { class: 'row', 'data-feedback-id': 'booking.huespedes.ficha.restricciones.fila', 'data-feedback-label': 'Restricción' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, `${label(r.restriction_type)}${r.subject ? ` · ${r.subject}` : ''}`),
            r.severity ? el('span', { class: `chip${r.severity === 'grave' ? ' alert' : ''}` }, label(r.severity)) : null, r.active ? null : el('span', { class: 'chip' }, 'Inactiva'), sourceChip(asSource(r.source))),
          el('div', { class: 'row-actions' },
            el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar restricción ${label(r.restriction_type)}`, 'data-feedback-id': 'booking.huespedes.ficha.restricciones.editar', 'data-feedback-label': 'Editar restricción', onclick: () => void openRestriction(guest, r, context) }, icon('edit', 16)))))),
        el('p', null, el('button', { class: 'ghost small', type: 'button', id: 'addGuestRestriction', 'data-feedback-id': 'booking.huespedes.ficha.restricciones.anadir', 'data-feedback-label': 'Añadir restricción', onclick: () => void openRestriction(guest, null, context) }, 'Añadir restricción')));
    }

    /** «Ver justificante»: el archivo está en el almacén remoto; la URL firmada solo se pide con red. */
    function receiptLink(guest: Row): Child {
      const fileId = guest.ses_receipt_file_id;
      if (typeof fileId !== 'string' || !fileId) return null;
      return el('p', null, el('button', { class: 'linkbtn', type: 'button', id: 'viewReceipt', 'data-feedback-id': 'booking.huespedes.ficha.justificante', 'data-feedback-label': 'Ver justificante', onclick: async () => {
        if (!navigator.onLine) return void toast('Ver el justificante necesita conexión.');
        try { window.open(await client.fileUrl(fileId), '_blank', 'noopener'); } catch (error) { toast(describeError(error)); }
      } }, 'Ver justificante'));
    }

    /** «Ver firma»: la firma puede haberse subido desde Guests; la URL firmada solo se pide con red. */
    function signatureLink(guest: Row): Child {
      const fileId = guest.signature_file_id;
      if (typeof fileId !== 'string' || !fileId) return null;
      return el('button', { class: 'ghost small', type: 'button', id: 'viewSignature', 'data-feedback-id': 'booking.huespedes.ficha.ver_firma', 'data-feedback-label': 'Ver firma', onclick: async () => {
        if (!navigator.onLine) return void toast('Ver la firma necesita conexión.');
        try {
          const { url } = await client.api<{ url: string; mime: string }>(`/guest-signature/${encodeURIComponent(guest.id)}`);
          void sheet?.close(true);
          sheet = openSheet({
            title: `Firma · ${fullName(guest)}`,
            body: el('div', { id: 'signatureView', 'data-feedback-id': 'booking.huespedes.firma_ver', 'data-feedback-label': 'Firma guardada', 'data-feedback-ignore': '' }, el('img', { class: 'sigimg', src: url, alt: `Firma de ${fullName(guest)}` }),
              guest.signed_by_name ? el('p', { class: 'hint' }, `Firmado por ${guest.signed_by_name}.`) : null),
            foot: el('div', { class: 'choices' }, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.huespedes.firma_ver.cerrar', 'data-feedback-label': 'Cerrar', onclick: () => void sheet?.close(true) }, 'Cerrar')),
            onClose: () => { sheet = null; },
          });
        } catch (error) { toast(describeError(error)); }
      } }, 'Ver firma');
    }

    /** Consentimientos que solo cambia el huésped desde su portal: el personal los ve, no los edita. */
    function consentBlock(guest: Row): Child {
      return el('div', { class: 'consent', id: 'guestConsent', 'data-feedback-id': 'booking.huespedes.ficha.consentimientos', 'data-feedback-label': 'Consentimientos' },
        el('span', null, `Alergias visibles para el organizador: ${yesNo(guest.allergies_visible_to_organizer)}`),
        guest.privacy_ack_at ? el('span', null, `Aviso legal visto el ${formatDate(guest.privacy_ack_at)}`) : null);
    }

    function openGuest(guest: Row | null, context: { reservation: ReservationRow; event: Row; restrictions: Row[] }): void {
      const onDate = context.reservation.start_date ?? today();
      const operative = guestModeOf(context.reservation) === 'operativo';
      sheet = openRowSheet({
        client, title: guest ? fullName(guest) || 'Huésped' : 'Nuevo huésped', table: GUESTS, row: guest, specs: operative ? OPERATIVE_SPECS : GUEST_SPECS, mark: fieldMark(guest), feedbackId: guest ? 'booking.huespedes.ficha' : 'booking.huespedes.nuevo', feedbackLabel: guest ? 'Ficha del huésped' : 'Nuevo huésped',
        defaults: operative ? {} : { data_status: 'pendiente_datos', residence_country: 'ESP', nationality: 'ESP' }, insertFields: { event_id: context.event.id },
        check: (merged) => operative ? null : (merged.data_status === 'datos_revisados' && missingForSes(merged).length ? `Para dar los datos por revisados falta: ${missingText(merged)}.` : null),
        extra: (merged) => {
          if (operative) return (guest ? restrictionsBlock(guest, context) : el('p', { class: 'hint' }, 'Guarda al huésped para añadirle restricciones alimentarias.')) as Child;
          const missing = missingText(merged);
          return [
            el('p', { class: missing ? 'banner warn' : 'banner ok', id: 'sesMissing', 'data-feedback-id': 'booking.huespedes.ficha.completitud', 'data-feedback-label': 'Completitud para SES' }, missing ? `Falta para SES: ${missing}.` : 'Datos completos para SES.Hospedajes.'),
            guest ? consentBlock(guest) : null,
            guest ? restrictionsBlock(guest, context) : null,
            guest ? receiptLink(guest) : null,
            guest ? el('div', { class: 'choices', style: 'margin-top:10px' },
              guest.signed_at ? el('span', { class: 'chip ok', id: 'signedChip', 'data-feedback-id': 'booking.huespedes.ficha.firmado', 'data-feedback-label': 'Estado de la firma' }, `Firmado ${formatDate(guest.signed_at)}${guest.signature_file_id ? '' : ' (en papel)'}`) : null,
              el('button', { class: 'ghost small', type: 'button', id: 'signOnScreen', 'data-feedback-id': 'booking.huespedes.ficha.firmar', 'data-feedback-label': 'Firmar en pantalla', onclick: async () => { if (await sheet?.close()) openSign(guest, onDate); } }, guest.signed_at ? 'Volver a firmar' : 'Firmar en pantalla'),
              el('button', { class: 'ghost small', type: 'button', id: 'printEntry', 'data-feedback-id': 'booking.huespedes.ficha.imprimir', 'data-feedback-label': 'Imprimir parte', onclick: () => printEntry(guest, context.reservation, context.event) }, 'Imprimir parte'),
              signatureLink(guest),
              guest.signed_at ? null : el('button', { class: 'ghost small', type: 'button', id: 'signedOnPaper', 'data-feedback-id': 'booking.huespedes.ficha.firma_papel', 'data-feedback-label': 'Firmado en papel', onclick: async () => {
                const ok = await run([{ op: 'update', table: GUESTS, id: guest.id, expectedRevision: guest.revision, fields: { signed_at: new Date().toISOString(), signed_by_name: signsOwnEntry(guest as GuestLike, onDate) ? fullName(guest) : guest.guardian_name ?? fullName(guest) } }], 'Anotado como firmado en papel.');
                if (ok) await sheet?.close(true);
              } }, 'Firmado en papel')) : el('p', { class: 'hint' }, 'Guarda al huésped para poder firmar el parte. No se guardan copias ni fotos del documento.'),
          ] as Child;
        },
        ...(guest ? { remove: {
          label: 'Quitar', confirm: 'El huésped va a la papelera. Sus restricciones alimentarias se conservan sin identificar.',
          // Las restricciones del huésped pasan a ser «de una persona» sin identificar: la invariante no admite enlaces a un huésped borrado.
          operations: () => [
            ...context.restrictions.filter((r) => r.guest_id === guest.id).map((r): RowOperation => ({ op: 'update', table: RESTRICTIONS, id: r.id, expectedRevision: r.revision, fields: { guest_id: null, servings: 1 } })),
            { op: 'delete', table: GUESTS, id: guest.id, expectedRevision: guest.revision },
          ],
        } } : {}),
        savedMessage: 'Huésped guardado.',
      });
    }

    /** Hoja de solo lectura con todo lo que hay que teclear en SES.Hospedajes (API §2.3.1), cada dato con su botón «Copiar». */
    async function openSesData(guest: Row, context: { reservation: ReservationRow; event: Row }): Promise<void> {
      const { reservation, event } = context;
      const finance = canRead(client, FINANCE) ? ((await client.get(FINANCE, reservation.id)) as Row | null) : null;
      const alive = ((await client.list(GUESTS)) as Row[]).filter((g) => g.event_id === event.id && !g.preview).length;
      const joined = (date: unknown, hour: unknown) => [date, typeof hour === 'string' ? hour.slice(0, 5) : hour].filter((v) => v !== null && v !== undefined && v !== '').join(' ');
      const traveler: Array<[string, unknown]> = [
        ['Nombre', guest.first_name], ['Apellidos', [guest.last_name_1, guest.last_name_2].filter(Boolean).join(' ')], ['Sexo', guest.sex ? label(guest.sex) : null],
        ['Tipo de documento', guest.document_type ? label(guest.document_type) : null], ['Número de documento', guest.document_number], ['Número de soporte', guest.document_support_number],
        ['Nacionalidad', guest.nationality], ['Fecha de nacimiento', guest.birth_date], ['Dirección', guest.residence_address], ['Código postal', guest.residence_postal_code],
        ['Municipio', guest.residence_city], ['País', guest.residence_country], ['Teléfono', guest.phone], ['Correo', guest.email],
        ...(guest.is_minor ? [['Parentesco', guest.kinship]] as Array<[string, unknown]> : []),
      ];
      const transaction: Array<[string, unknown]> = [
        ['Referencia', reservation.code], ['Fecha del contrato', typeof event.created_at === 'string' ? event.created_at.slice(0, 10) : null],
        ['Entrada', joined(reservation.start_date, event.arrival_time)], ['Salida', joined(reservation.end_date, event.departure_time)],
        ['Número de personas', alive], ['Habitaciones', event.rooms_count],
        ...(finance ? [['Tipo de pago', finance.payment_type ? label(finance.payment_type) : null]] as Array<[string, unknown]> : []),
      ];
      const list = (pairs: Array<[string, unknown]>, fbId: string, fbLabel: string) => el('dl', { class: 'kv sesdata', 'data-feedback-id': fbId, 'data-feedback-label': fbLabel, 'data-feedback-ignore': '' }, pairs.flatMap(([term, raw]) => {
        const value = raw === null || raw === undefined || raw === '' ? '' : String(raw);
        return [el('dt', null, term), el('dd', null, el('span', { class: 'value' }, value || '—'),
          value ? el('button', { class: 'ghost small', type: 'button', 'aria-label': `Copiar ${term.toLowerCase()}`, onclick: () => {
            void navigator.clipboard.writeText(value).then(() => toast('Copiado'), () => toast('No se pudo copiar.'));
          } }, 'Copiar') : null)];
      }));
      void sheet?.close(true);
      sheet = openSheet({
        title: `Datos para SES · ${fullName(guest)}`,
        body: el('div', { id: 'sesData', 'data-feedback-id': 'booking.huespedes.ses_datos', 'data-feedback-label': 'Datos para SES' }, el('div', { class: 'sectionlabel' }, 'Viajero'), list(traveler, 'booking.huespedes.ses_datos.viajero', 'Datos del viajero'), el('div', { class: 'sectionlabel' }, 'Transacción'), list(transaction, 'booking.huespedes.ses_datos.transaccion', 'Datos de la transacción')),
        foot: el('div', { class: 'choices' }, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.huespedes.ses_datos.cerrar', 'data-feedback-label': 'Cerrar', onclick: () => void sheet?.close(true) }, 'Cerrar')),
        onClose: () => { sheet = null; },
      });
    }

    function openSent(guest: Row): void {
      const file = el('input', { type: 'file', id: 'receiptFile', 'data-feedback-id': 'booking.huespedes.envio_ses.justificante', 'data-feedback-label': 'Justificante', accept: 'application/pdf,image/*' });
      const fileField = el('label', { class: 'field' }, el('span', null, 'Justificante (PDF o imagen)'), file,
        el('span', { class: 'hint' }, 'Opcional. Las imágenes se reducen antes de guardarse.'));
      sheet = openRowSheet({
        client, title: `Envío a SES · ${fullName(guest)}`, table: GUESTS, row: null, specs: SENT_SPECS, feedbackId: 'booking.huespedes.envio_ses', feedbackLabel: 'Registrar envío a SES',
        defaults: { ses_sent_by: boot?.profile.displayName ?? '' }, submitLabel: 'Registrar envío', savedMessage: 'Envío a SES registrado.',
        extra: () => fileField,
        buildOperations: async (values) => {
          const fields: Record<string, unknown> = { ...values, ses_status: 'enviado_SES', ses_sent_at: new Date().toISOString() };
          const chosen = file.files?.[0];
          if (chosen) {
            // El archivo espera en la cola de adjuntos; el marcador se cambia por el id al subirlo.
            let blob: Blob = chosen;
            let filename = chosen.name;
            let mime = chosen.type || 'application/octet-stream';
            if (isImageFile(chosen)) {
              const image = await compressImage(chosen, { thumbSide: 0 });
              blob = image.full; mime = image.mime; filename = compressedFilename(chosen.name, image.mime);
            }
            fields.ses_receipt_file_id = { $blob: await client.stageBlob(blob, { filename, mime }) };
          }
          return [{ op: 'update', table: GUESTS, id: guest.id, expectedRevision: guest.revision, fields }];
        },
      });
    }

    function copyText(value: string, message: string): void {
      void navigator.clipboard.writeText(value).then(() => toast(message), () => toast('No se pudo copiar.'));
    }

    /** Quién es del personal de Booking: `GET /members` (completo solo para propietarios); null si no se sabe. */
    let staffIds: Set<string> | null | undefined;
    async function loadStaffIds(): Promise<Set<string> | null> {
      if (staffIds !== undefined) return staffIds;
      const me = boot?.profile.userId;
      try {
        const items = await client.api<Array<{ userId?: string; user_id?: string }>>('/members');
        const ids = new Set(items.map((m) => m.userId ?? m.user_id).filter((id): id is string => typeof id === 'string'));
        if (me) ids.add(me);
        // Un editor solo ve su propia pertenencia: con eso no se puede afirmar que otro usuario no sea del personal.
        staffIds = boot?.membership.role === 'owner' || ids.size > 1 ? ids : null;
      } catch { staffIds = null; }
      return staffIds;
    }

    async function restoreGuest(guest: Row, restrictions: Row[]): Promise<void> {
      const own = restrictions.filter((r) => r.guest_id === guest.id && r.deleted_at !== null);
      await run([{ op: 'restore', table: GUESTS, id: guest.id, expectedRevision: guest.revision } as RowOperation,
        ...own.map((r): RowOperation => ({ op: 'restore', table: RESTRICTIONS, id: r.id, expectedRevision: r.revision }))], 'Huésped restaurado.');
    }

    let trashOpen = false;
    function trashBlock(deleted: Row[], restrictionsAll: Row[], staff: Set<string> | null): Child {
      if (deleted.length === 0) return null;
      return el('details', { id: 'guestTrash', open: trashOpen, 'data-feedback-id': 'booking.huespedes.papelera', 'data-feedback-label': 'Papelera de huéspedes', ontoggle: (event: Event) => { trashOpen = (event.target as HTMLDetailsElement).open; } }, el('summary', { class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera de huéspedes', el('span', { class: 'count', id: 'guestTrashCount' }, String(deleted.length))),
        el('ul', { class: 'list', 'aria-label': 'Huéspedes en la papelera' }, deleted.map((g) => {
          const byOrganizer = !!staff && typeof g.updated_by === 'string' && !staff.has(g.updated_by);
          return fbIgnoreWithin(fbMark(listRow({
            id: g.id, title: fullName(g) || 'Sin nombre', deleted: true, pending: g._pending === true,
            chips: byOrganizer ? [el('span', { class: 'chip missing' }, 'Dado de baja por el organizador')] : [],
            meta: [g.code ?? 'código pendiente', g.deleted_at ? `quitado ${formatDate(g.deleted_at)}` : null],
            actions: writable ? [el('button', { class: 'ghost small', type: 'button', 'aria-label': `Restaurar a ${fullName(g)}`, 'data-feedback-id': 'booking.huespedes.papelera.restaurar', 'data-feedback-label': 'Restaurar', onclick: () => void restoreGuest(g, restrictionsAll) }, icon('restore', 16), 'Restaurar')] : [],
          }), 'booking.huespedes.papelera.fila', 'Huésped en la papelera'), '.name, .row-meta');
        })));
    }

    /** Trae los partes de viajeros y marca en Booking a los huéspedes de los aceptados, para que el resto de la app lo vea sin red. */
    async function refreshSes(): Promise<void> {
      const target = sesTarget;
      if (!target || !writable || !navigator.onLine) return;
      const seq = ++sesSeq;
      try {
        const comms = await fetchSes(client, target.reservationId);
        if (seq !== sesSeq || sesTarget?.eventId !== target.eventId) return;
        ses = { ...target, comms };
        await markCommunicated(comms);
      } catch { /* sin red o sin permiso: la pantalla sigue con lo local */ }
      if (seq === sesSeq) void paint(false);
    }

    async function markCommunicated(comms: SesCommunication[]): Promise<void> {
      if (marking) return;
      const accepted = new Map<string, string | null>();
      for (const c of guestReports(comms)) if (c.status === 'aceptada') for (const id of c.guest_ids ?? []) accepted.set(id, c.accepted_at);
      if (accepted.size === 0) return;
      const rows = ((await client.list(GUESTS)) as Row[]).filter((g) => !g.deleted_at && accepted.has(g.id) && g.ses_status !== 'enviado_SES');
      if (rows.length === 0) return;
      marking = true;
      try {
        await client.commit(rows.map((g): RowOperation => ({ op: 'update', table: GUESTS, id: g.id, expectedRevision: g.revision, fields: { ses_status: 'enviado_SES', ses_sent_at: accepted.get(g.id) ?? new Date().toISOString() } })));
      } catch { /* se reintentará en la próxima consulta */ } finally { marking = false; }
    }

    async function sendPv(ids: string[] | null): Promise<void> {
      const target = sesTarget;
      if (!target || busyPv) return;
      busyPv = true;
      void paint(false);
      try {
        const out = await client.api<{ id: string | null; status: string; pending: Array<{ id: string; missing: string[] }> }>(`/ses/${encodeURIComponent(target.reservationId)}/pv`, { method: 'POST', json: ids ? { guest_ids: ids } : {} });
        if (!ids) pvResult = { eventId: target.eventId, pending: out.pending ?? [], empty: out.status === 'sin_listos' };
        toast(out.status === 'sin_listos' ? 'Nadie estaba listo: revisa lo que falta.' : `Parte de viajeros enviado a SES${out.pending?.length && !ids ? `; quedan fuera ${out.pending.length}.` : '.'}`);
      } catch (error) {
        toast(describeError(error));
      } finally {
        busyPv = false;
        await refreshSes();
        void paint(false);
      }
    }

    async function paint(fetch = true): Promise<void> {
      const reservations = new Map(((await client.list(RESERVATIONS)) as ReservationRow[]).map((r) => [r.id, r]));
      const now = dayNumber(today())!;
      const events = ((await client.list(EVENTS)) as Row[]).filter((e) => reservations.has(e.reservation_id))
        .map((event) => ({ event, reservation: reservations.get(event.reservation_id)! }))
        .sort((a, b) => {
          const key = (r: ReservationRow) => { const end = dayNumber(r.end_date) ?? Infinity; return end >= now ? (dayNumber(r.start_date) ?? Infinity) : 1e9 + (now - end); };
          return key(a.reservation) - key(b.reservation);
        });
      if (events.length === 0) {
        replace(selectHost);
        replace(body, el('div', { class: 'empty' }, el('strong', null, 'Sin eventos todavía'), 'Los huéspedes se registran en el evento operativo, que nace al confirmar una reserva.'));
        return;
      }
      if (!eventId || !events.some((e) => e.event.id === eventId)) eventId = events[0]!.event.id;
      const current = events.find((e) => e.event.id === eventId)!;
      const select = el('select', { id: 'eventSelect', 'data-feedback-id': 'booking.huespedes.evento.selector', 'data-feedback-label': 'Evento', 'aria-label': 'Evento', onchange: () => navigate(`#/huespedes/${select.value}`) },
        events.map(({ event, reservation }) => el('option', { value: event.id }, `${reservation.title} · ${dateRange(reservation)}`)));
      select.value = eventId;
      replace(selectHost, el('label', { class: 'field' }, el('span', null, 'Evento'), select));

      if (!allowed) {
        const counts = el('div', { class: 'card', id: 'guestSummary', 'data-feedback-id': 'booking.huespedes.recuentos', 'data-feedback-label': 'Recuentos' }, el('p', { class: 'hint' }, 'Cargando recuentos…'));
        replace(body, counts, el('div', { class: 'empty plain' }, el('strong', null, 'Acceso restringido'), 'El detalle de huéspedes solo lo ven los responsables designados. Aquí tienes los recuentos.'));
        try {
          const s = await client.api<any>(`/read/${READS.guestSummary}`, { method: 'POST', json: { event_id: eventId } });
          replace(counts, el('h3', null, plural(s.total, 'huésped', 'huéspedes')), el('dl', { class: 'kv' },
            el('dt', null, 'Mujeres'), el('dd', null, s.bySex.M), el('dt', null, 'Hombres'), el('dd', null, s.bySex.H), el('dt', null, 'Otro o sin indicar'), el('dd', null, s.bySex.X + s.bySex.sinDato),
            el('dt', null, 'Menores'), el('dd', null, s.minors), el('dt', null, 'Firmados'), el('dd', null, s.signed)));
        } catch {
          replace(counts, el('p', { class: 'hint' }, 'Los recuentos necesitan conexión.'));
        }
        return;
      }

      const mode = guestModeOf(current.reservation);
      if (mode === 'ninguno') {
        replace(body, el('div', { class: 'empty', id: 'guestsNone' }, el('strong', null, 'Esta reserva no pide datos de huéspedes'),
          'No hay lista de huéspedes ni enlaces de huésped. Se cambia en el bloque «Registro de viajeros» de la ficha.',
          el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'goSesBlock', 'data-feedback-id': 'booking.huespedes.sin_datos.ir_ficha', 'data-feedback-label': 'Ir al registro de viajeros', onclick: () => navigate(`#/reservas/${current.reservation.id}`) }, 'Ir al registro de viajeros de la ficha'))));
        return;
      }
      const sesMode = mode === 'ses';
      const everyGuest = ((await client.list(GUESTS, { includeDeleted: true })) as Row[]).filter((g) => g.event_id === eventId && !g.preview);
      const guests = everyGuest.filter((g) => g.deleted_at === null || g.deleted_at === undefined).sort((a, b) => fullName(a).localeCompare(fullName(b), 'es'));
      const deletedGuests = everyGuest.filter((g) => g.deleted_at !== null && g.deleted_at !== undefined).sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
      const everyRestriction = ((await client.list(RESTRICTIONS, { includeDeleted: true })) as Row[]).filter((r) => r.event_id === eventId);
      const restrictions = everyRestriction.filter((r) => r.deleted_at === null || r.deleted_at === undefined);
      const staff = deletedGuests.length ? await loadStaffIds() : null;
      const totals = reservationCompleteness(guests as GuestLike[], mode);
      const onDate = current.reservation.start_date ?? today();
      const pendingGuests = guests.filter((g) => guestCompleteness(g as GuestLike, mode).missing.length > 0);
      const reservationTitle = current.reservation.title;
      const context = { reservation: current.reservation, event: current.event, restrictions };
      const queue = guests.filter((g) => g.data_status === 'datos_revisados' && g.ses_status === 'listo_para_envio');
      const reviewed = guests.filter((g) => g.data_status === 'datos_revisados' && g.ses_status === 'pendiente_envio');
      const completenessChips = (g: Row): Child[] => {
        const c = guestCompleteness(g as GuestLike, mode);
        return [c.complete
          ? el('span', { class: 'chip ok', dataset: { chip: 'complete' } }, 'Completo')
          : c.missing.length ? el('span', { class: 'chip missing', dataset: { chip: 'missing' } }, `Falta: ${missingLabels(c.missing).join(', ')}`) : null,
        c.needsSignature && !c.signed
          ? (sesMode && g.arrived_at && signsOwnEntry(g as GuestLike, onDate) ? el('span', { class: 'chip missing', dataset: { chip: 'signature' } }, 'Firma pendiente') : el('span', { class: 'chip missing', dataset: { chip: 'unsigned' } }, 'Sin firmar'))
          : null];
      };
      const count = (filter: (g: Row) => boolean) => String(guests.filter(filter).length);
      // Llegada (solo modo `ses`, editor o propietario): lo que falta de cada huésped sale de las filas locales; los partes, de la API.
      const arrivalOn = sesMode && writable;
      sesTarget = arrivalOn ? { eventId: current.event.id, reservationId: current.reservation.id } : null;
      if (ses && ses.eventId !== eventId) ses = null;
      const reports = ses ? guestReports(ses.comms) : [];
      const reportOf = (id: string) => reports.find((c) => (c.guest_ids ?? []).includes(id)) ?? null;
      const inReport = (g: Row) => { const pv = reportOf(g.id); return !!pv && pv.status !== 'rechazada'; };
      const hasReport = reports.some((c) => c.status !== 'rechazada');
      const waiting = guests.filter((g) => g.arrived_at && !inReport(g));
      const needsOf = (g: Row) => arrivalNeeds(g, onDate);
      const ready = waiting.filter((g) => needsOf(g).length === 0);
      const left = waiting.filter((g) => needsOf(g).length > 0);
      const online = navigator.onLine;
      const reportChip = (g: Row): Child => {
        const pv = reportOf(g.id);
        if (!pv) return g.ses_status === 'enviado_SES' ? el('span', { class: 'chip ok' }, 'Enviado a SES') : null;
        if (pv.status === 'aceptada') return el('span', { class: 'chip ok', dataset: { chip: 'pv' } }, 'Comunicado');
        if (pv.status === 'rechazada') { const why = pv.error_text || 'SES rechazó el parte.'; return el('span', { class: 'chip alert', dataset: { chip: 'pv' }, title: why }, `Rechazado: ${why}`); }
        return el('span', { class: 'chip pending', dataset: { chip: 'pv' } }, 'En proceso en SES');
      };
      const arrivalActions = (g: Row): Child[] => {
        if (!arrivalOn) return [];
        const name = fullName(g);
        if (!g.arrived_at) return [el('button', { class: 'primary small', type: 'button', dataset: { act: 'arrived' }, 'aria-label': `Ha llegado: ${name}`, 'data-feedback-id': 'booking.huespedes.llegada.ha_llegado', 'data-feedback-label': 'Ha llegado', onclick: () => void run([{ op: 'update', table: GUESTS, id: g.id, expectedRevision: g.revision, fields: { arrived_at: new Date().toISOString() } }], 'Llegada anotada.') }, 'Ha llegado')];
        const out: Child[] = [];
        if (!inReport(g) && g.ses_status !== 'enviado_SES') {
          out.push(el('button', { class: 'ghost small', type: 'button', dataset: { act: 'notArrived' }, 'aria-label': `No ha llegado: ${name}`, 'data-feedback-id': 'booking.huespedes.llegada.no_ha_llegado', 'data-feedback-label': 'No ha llegado', onclick: () => void run([{ op: 'update', table: GUESTS, id: g.id, expectedRevision: g.revision, fields: { arrived_at: null } }], 'Llegada deshecha.') }, 'No ha llegado'));
        }
        if (g.is_minor !== true) {
          const box = el('input', { type: 'checkbox', checked: !!g.document_checked_at, 'aria-label': `Documento comprobado de ${name}`, onchange: async () => {
            const on = box.checked;
            const ok = await run([{ op: 'update', table: GUESTS, id: g.id, expectedRevision: g.revision, fields: { document_checked_at: on ? new Date().toISOString() : null, document_checked_by: on ? boot?.profile.userId ?? null : null } }], on ? 'Documento comprobado.' : 'Documento sin comprobar.');
            if (!ok) void paint(false);
          } });
          out.push(el('label', { class: 'check', title: 'Compruébalo a la vista: no se fotografía ni se guarda copia', 'data-feedback-id': 'booking.huespedes.llegada.documento', 'data-feedback-label': 'Documento comprobado' }, box, el('span', null, 'Documento comprobado')));
        }
        if (hasReport && ses && online && !inReport(g) && needsOf(g).length === 0) {
          out.push(el('button', { class: 'primary small', type: 'button', dataset: { act: 'late' }, disabled: busyPv, 'aria-label': `Comunicar su llegada: ${name}`, 'data-feedback-id': 'booking.huespedes.llegada.comunicar_tardio', 'data-feedback-label': 'Comunicar su llegada', onclick: () => void sendPv([g.id]) }, 'Comunicar su llegada'));
        }
        return out;
      };
      const closeEntry = async (): Promise<void> => {
        if (ready.length === 0) return void toast(left.length ? 'Nadie está listo todavía: mira lo que falta a cada huésped.' : 'Nadie ha llegado todavía.');
        const leftText = left.map((g) => `${fullName(g)} (${missingLabels(needsOf(g)).join(', ')})`).join('; ');
        const text = `Van ${plain(ready.length, 'huésped', 'huéspedes')} en el parte de viajeros.${left.length ? ` Quedan fuera ${left.length} porque les falta algo: ${leftText}. Se podrán comunicar más tarde.` : ''}`;
        if (await confirmDialog({ title: 'Cerrar la entrada y comunicar', text, confirmLabel: 'Comunicar' })) await sendPv(null);
      };
      const result = pvResult && pvResult.eventId === eventId ? pvResult : null;
      const outside = result ? result.pending.map((p) => guests.find((g) => g.id === p.id)).filter((g): g is Row => !!g && left.includes(g)) : [];
      const planned = current.event.final_guests ?? current.reservation.expected_guests;
      const arrivalPanel: Child = !arrivalOn ? null : [
        el('div', { class: 'sectionlabel' }, 'Llegada'),
        el('p', { class: 'completeness', id: 'arrivalSummary', 'data-feedback-id': 'booking.huespedes.llegada.resumen', 'data-feedback-label': 'Resumen de llegada' },
          `${planned ?? '—'} ${planned === 1 ? 'previsto' : 'previstos'} · ${plain(guests.filter((g) => g.arrived_at).length, 'llegado', 'llegados')} · ${guests.filter((g) => missingForSes(g as GuestLike).length === 0).length} con datos completos · ${plain(guests.filter((g) => g.signed_at).length, 'firmado', 'firmados')} · ${plain(guests.filter((g) => reportOf(g.id)?.status === 'aceptada' || g.ses_status === 'enviado_SES').length, 'comunicado', 'comunicados')}`),
        el('p', { class: 'hint' }, 'Al llegar cada persona, pulsa «Ha llegado» y marca «Documento comprobado» (adultos). Compruébalo a la vista: no se fotografía ni se guarda copia.'),
        el('div', { class: 'choices' },
          el('button', { class: 'primary', type: 'button', id: 'closeEntry', disabled: !online || busyPv || !ses || waiting.length === 0, 'data-feedback-id': 'booking.huespedes.llegada.cerrar', 'data-feedback-label': 'Cerrar la entrada y comunicar', onclick: () => void closeEntry() }, 'Cerrar la entrada y comunicar'),
          reports.some((c) => PV_IN_PROCESS.includes(c.status)) ? el('button', { class: 'ghost small', type: 'button', id: 'refreshSes', disabled: !online, 'data-feedback-id': 'booking.huespedes.llegada.actualizar', 'data-feedback-label': 'Actualizar estado', onclick: () => void refreshSes() }, 'Actualizar estado') : null),
        online ? null : el('p', { class: 'hint', id: 'arrivalOffline', role: 'status' }, 'Sin conexión: se puede anotar la llegada, pero comunicar a SES necesita red.'),
        !result ? null : outside.length
          ? el('div', { class: 'banner warn', id: 'pvResult', role: 'status', 'data-feedback-id': 'booking.huespedes.llegada.fuera', 'data-feedback-label': 'Huéspedes fuera del parte' },
            el('div', null, result.empty ? 'Nadie estaba listo. Falta algo a cada huésped:' : 'Quedaron fuera del parte, por ahora:'),
            el('ul', null, outside.map((g) => el('li', { dataset: { guest: g.id } }, `${fullName(g)}: falta ${missingLabels(needsOf(g)).join(', ')}`))))
          : result.empty ? null : el('p', { class: 'banner ok', id: 'pvResult', role: 'status' }, 'Todos los que han llegado van en el parte.'),
      ];


      replace(body,
        el('div', { class: 'card', id: 'guestSummary', 'data-feedback-id': 'booking.huespedes.recuentos', 'data-feedback-label': 'Recuentos' }, el('h3', null, plural(guests.length, 'huésped', 'huéspedes')), el('dl', { class: 'kv' },
          el('dt', null, 'Mujeres'), el('dd', null, count((g) => g.sex === 'M')), el('dt', null, 'Hombres'), el('dd', null, count((g) => g.sex === 'H')),
          el('dt', null, 'Otro o sin indicar'), el('dd', null, count((g) => g.sex !== 'M' && g.sex !== 'H')), el('dt', null, 'Menores'), el('dd', null, count((g) => g.is_minor === true)),
          ...(sesMode ? [el('dt', null, 'Firmados'), el('dd', null, count((g) => !!g.signed_at)), el('dt', null, 'Enviados a SES'), el('dd', null, count((g) => g.ses_status === 'enviado_SES'))] : []))),
        arrivalPanel,
        !sesMode || queue.length + reviewed.length === 0 ? null : [
          el('div', { class: 'sectionlabel' }, 'Envío a SES.Hospedajes', el('span', { class: 'count' }, String(queue.length))),
          el('p', { class: 'hint' }, 'El plazo es de 24 horas desde la entrada. El envío se hace en la web de SES; aquí se anota.'),
          el('ul', { class: 'list', id: 'sesQueue', 'data-feedback-id': 'booking.huespedes.cola_ses', 'data-feedback-label': 'Cola de envío a SES' }, [...queue, ...reviewed].map((g) => fbIgnoreWithin(fbMark(listRow({
            id: g.id, title: fullName(g), meta: [[g.document_type, g.document_number].filter(Boolean).join(' ') || 'menor sin documento', label(g.ses_status)], pending: g._pending === true,
            actions: [el('button', { class: 'ghost small', type: 'button', 'aria-label': `Datos para SES de ${fullName(g)}`, 'data-feedback-id': 'booking.huespedes.cola_ses.datos', 'data-feedback-label': 'Datos para SES', onclick: () => void openSesData(g, context) }, 'Datos para SES'), ...(writable ? [g.ses_status === 'listo_para_envio'
              ? el('button', { class: 'ghost small', type: 'button', 'aria-label': `Registrar envío de ${fullName(g)}`, 'data-feedback-id': 'booking.huespedes.cola_ses.registrar', 'data-feedback-label': 'Registrar envío', onclick: () => openSent(g) }, 'Registrar envío')
              : el('button', { class: 'ghost small', type: 'button', 'aria-label': `Marcar listo para envío a ${fullName(g)}`, 'data-feedback-id': 'booking.huespedes.cola_ses.listo', 'data-feedback-label': 'Listo para envío', onclick: () => void run(
                  [{ op: 'update', table: GUESTS, id: g.id, expectedRevision: g.revision, fields: { ses_status: 'listo_para_envio' } }], 'Listo para envío.') }, 'Listo para envío')] : [])],
          }), 'booking.huespedes.cola_ses.fila', 'Huésped en la cola'), '.name, .row-meta')))],
        el('div', { class: 'sectionlabel' }, 'Registro', el('span', { class: 'count', id: 'guestCount' }, String(guests.length))),
        guests.length === 0 ? null : el('p', { class: 'completeness', id: 'completeness', 'data-feedback-id': 'booking.huespedes.completitud', 'data-feedback-label': 'Completitud del registro' },
          `${totals.complete} de ${totals.total} completos · ${totals.missingData} con datos pendientes · ${totals.unsigned} sin firmar`),
        pendingGuests.length === 0 ? null : el('p', null, el('button', { class: 'ghost small', type: 'button', id: 'copyOrganizerReminder', 'data-feedback-id': 'booking.huespedes.recordatorio_organizador', 'data-feedback-label': 'Copiar recordatorio para el organizador', onclick: () => copyText(
          organizerReminder({ contact: current.reservation.contact_name, title: reservationTitle, guests: pendingGuests }), 'Recordatorio copiado') }, 'Copiar recordatorio para el organizador')),
        guests.length === 0
          ? el('div', { class: 'empty' }, el('strong', null, 'Nadie registrado todavía'), sesMode ? 'Añade a cada persona alojada con los datos de su documento. No se guardan copias ni fotos.' : 'Añade a cada persona con su nombre y contacto. Esta reserva no se comunica a SES.')
          : el('ul', { class: 'list', id: 'guestList', 'data-feedback-id': 'booking.huespedes.registro', 'data-feedback-label': 'Registro de huéspedes', 'aria-label': 'Huéspedes' }, guests.map((g) => fbIgnoreWithin(fbMark(listRow({
              id: g.id, title: fullName(g) || 'Sin nombre',
              meta: [g.code ?? 'código pendiente', g.is_minor && sesMode ? 'menor' : null, sesMode && missingForSes(g as GuestLike).length ? 'faltan datos para SES' : null, !sesMode ? [g.phone, g.email].filter(Boolean).join(' · ') || null : null],
              chips: sesMode ? [el('span', { class: 'chip' }, label(g.data_status)), g.signed_at ? el('span', { class: 'chip ok' }, 'Firmado') : null,
                arrivalOn && g.arrived_at ? el('span', { class: 'chip', dataset: { chip: 'arrived' } }, 'Llegó') : null,
                reportChip(g), ...completenessChips(g)] : completenessChips(g),
              actions: [...arrivalActions(g), ...(guestCompleteness(g as GuestLike, mode).complete ? [] : [el('button', { class: 'ghost small', type: 'button', dataset: { act: 'copyReminder' }, 'data-feedback-id': 'booking.huespedes.registro.recordatorio', 'data-feedback-label': 'Copiar recordatorio', 'aria-label': `Copiar recordatorio para ${fullName(g)}`, onclick: () => {
                const c = guestCompleteness(g as GuestLike, mode);
                copyText(guestReminder({ guest: g, title: reservationTitle, start: current.reservation.start_date, end: current.reservation.end_date, missing: c.missing, unsigned: c.needsSignature && !c.signed }), 'Recordatorio copiado');
              } }, 'Copiar recordatorio')])],
              pending: g._pending === true,
              ...(writable ? { onClick: () => openGuest(g, context), label: `Editar ${fullName(g)}` } : {}),
            }), 'booking.huespedes.registro.fila', 'Huésped'), '.name, .row-meta'))),
        trashBlock(deletedGuests, everyRestriction, staff),
        writable ? el('div', { class: 'fab-gap', 'aria-hidden': 'true' }) : null,
        writable ? el('button', { class: 'fab', type: 'button', id: 'newGuest', 'data-feedback-id': 'booking.huespedes.nuevo_huesped', 'data-feedback-label': 'Nuevo huésped', onclick: () => openGuest(null, context) }, icon('plus'), 'Nuevo huésped') : null,
      );
      if (fetch && arrivalOn) void refreshSes();
    }

    void paint();
    const offs = [RESERVATIONS, EVENTS, ...(allowed ? [GUESTS, RESTRICTIONS] : [])].map((table) => client.onTable(table, () => void paint()));
    // Con un parte en proceso se consulta cada 30 s; al volver la red, también.
    const timer = setInterval(() => { if (navigator.onLine && ses?.comms.some((c) => c.kind === 'PV' && PV_IN_PROCESS.includes(c.status))) void refreshSes(); }, 30_000);
    const onOnline = () => void refreshSes();
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
      offs.forEach((off) => off());
      void sheet?.close(true);
    };
  };
}
