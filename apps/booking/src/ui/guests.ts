/** Huéspedes (canon §10): recuentos, registro de viajeros, firma del parte y cola de envío a SES.Hospedajes. */
import type { RowOperation, SyncedRow, TableName } from '@ikisai/sync-client';
import { compressImage, compressedFilename, el, formatDate, icon, isImageFile, listRow, openSheet, plural, replace, toast, type Child, type Sheet } from '@ikisai/ui-kit';
import { READS, TABLES, canSeeGuests, dayNumber, missingForSes, signsOwnEntry, type GuestLike } from '@ikisai/domain-booking';
import { EVENTS, GUESTS, RESERVATIONS, FINANCE, canRead, canWrite, dateRange, describeError, today, type ReservationRow } from '../app/client.ts';
import { OPTIONS, label } from '../app/labels.ts';
import { openRowSheet, type FieldSpec } from './form.ts';
import { RESTRICTION_SPECS } from './reservation.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;
const RESTRICTIONS: TableName = TABLES.restrictions;
/** Restricciones de un huésped concreto: la regla del dominio es `guest_id` o `servings`, nunca los dos. */
const GUEST_RESTRICTION_SPECS: FieldSpec[] = RESTRICTION_SPECS.filter((spec) => spec.key !== 'servings');

const GUEST_SPECS: FieldSpec[] = [
  { key: 'first_name', label: 'Nombre', type: 'text', max: 120, section: 'Identidad' },
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
];

const SENT_SPECS: FieldSpec[] = [
  { key: 'ses_sent_by', label: 'Quién lo envió', type: 'text', max: 200 },
  { key: 'ses_receipt_ref', label: 'Referencia o enlace del justificante', type: 'text', max: 500 },
];

const MISSING_LABELS: Record<string, string> = {
  first_name: 'nombre', last_name_1: 'primer apellido', last_name_2: 'segundo apellido', birth_date: 'fecha de nacimiento', residence_address: 'dirección',
  residence_postal_code: 'código postal', residence_city: 'municipio', residence_country: 'país', contact: 'teléfono o correo', kinship: 'parentesco',
  document_type: 'tipo de documento', document_number: 'número de documento', document_support_number: 'número de soporte',
};
const fullName = (g: Row): string => [g.first_name, g.last_name_1, g.last_name_2].filter(Boolean).join(' ');
const missingText = (guest: Record<string, unknown>): string => missingForSes(guest).map((key) => MISSING_LABELS[key] ?? key).join(', ');

/** Lienzo para firmar con el dedo o el ratón. Devuelve el PNG o null si está vacío. */
function signaturePad(): { element: HTMLElement; clear(): void; toBlob(): Promise<Blob | null> } {
  const canvas = el('canvas', { class: 'signature', id: 'signaturePad', width: 600, height: 240, 'aria-label': 'Recuadro de firma' });
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
    const selectHost = el('div');
    const body = el('div');
    const printArea = el('div', { class: 'printarea', 'aria-hidden': 'true' });

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
      const signer = el('input', { id: 'signerName', type: 'text', maxlength: 200, value: own ? fullName(guest) : guest.guardian_name ?? '' });
      const error = el('p', { class: 'formerror', role: 'alert', hidden: true });
      const save = el('button', { class: 'primary', type: 'button', id: 'saveSignature', onclick: async () => {
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
        body: el('div', null,
          el('dl', { class: 'kv' }, el('dt', null, 'Huésped'), el('dd', null, fullName(guest)), el('dt', null, 'Documento'), el('dd', null, [guest.document_type, guest.document_number].filter(Boolean).join(' ') || '—'),
            el('dt', null, 'Nacimiento'), el('dd', null, guest.birth_date ?? '—')),
          el('p', { class: 'hint' }, 'Al firmar confirmas que estos datos son correctos. Se recogen para el registro de viajeros que exige el RD 933/2021 y se comunican a las Fuerzas y Cuerpos de Seguridad. No se guarda copia de tu documento.'),
          own ? null : el('p', { class: 'hint' }, 'Por su edad, firma la persona que le acompaña.'),
          pad.element,
          el('label', { class: 'field' }, el('span', null, 'Firma'), signer),
          error),
        foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => pad.clear() }, 'Borrar'), el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close(true) }, 'Cancelar')),
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
        client, title: restriction ? 'Restricción de ' + fullName(guest) : 'Nueva restricción', table: RESTRICTIONS, row: restriction, specs: GUEST_RESTRICTION_SPECS,
        defaults: { restriction_type: 'vegetariano', active: true }, insertFields: { event_id: context.event.id, guest_id: guest.id },
        ...(restriction ? { remove: { label: 'Quitar', operations: () => [{ op: 'delete', table: RESTRICTIONS, id: restriction.id, expectedRevision: restriction.revision } as RowOperation] } } : {}),
        savedMessage: 'Restricción guardada.',
      });
    }

    function restrictionsBlock(guest: Row, context: { reservation: ReservationRow; event: Row; restrictions: Row[] }): Child {
      const own = context.restrictions.filter((r) => r.guest_id === guest.id);
      return el('div', { id: 'guestRestrictions', class: 'formsection' },
        el('div', { class: 'sectionlabel' }, 'Restricciones alimentarias', el('span', { class: 'count' }, String(own.length))),
        own.length === 0 ? el('p', { class: 'hint' }, 'Ninguna registrada.') : el('ul', { class: 'list' }, own.map((r) => el('li', { class: 'row' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, `${label(r.restriction_type)}${r.subject ? ` · ${r.subject}` : ''}`),
            r.severity ? el('span', { class: `chip${r.severity === 'grave' ? ' alert' : ''}` }, label(r.severity)) : null, r.active ? null : el('span', { class: 'chip' }, 'Inactiva')),
          el('div', { class: 'row-actions' },
            el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar restricción ${label(r.restriction_type)}`, onclick: () => void openRestriction(guest, r, context) }, icon('edit', 16)))))),
        el('p', null, el('button', { class: 'ghost small', type: 'button', id: 'addGuestRestriction', onclick: () => void openRestriction(guest, null, context) }, 'Añadir restricción')));
    }

    /** «Ver justificante»: el archivo está en el almacén remoto; la URL firmada solo se pide con red. */
    function receiptLink(guest: Row): Child {
      const fileId = guest.ses_receipt_file_id;
      if (typeof fileId !== 'string' || !fileId) return null;
      return el('p', null, el('button', { class: 'linkbtn', type: 'button', id: 'viewReceipt', onclick: async () => {
        if (!navigator.onLine) return void toast('Ver el justificante necesita conexión.');
        try { window.open(await client.fileUrl(fileId), '_blank', 'noopener'); } catch (error) { toast(describeError(error)); }
      } }, 'Ver justificante'));
    }

    function openGuest(guest: Row | null, context: { reservation: ReservationRow; event: Row; restrictions: Row[] }): void {
      const onDate = context.reservation.start_date ?? today();
      sheet = openRowSheet({
        client, title: guest ? fullName(guest) || 'Huésped' : 'Nuevo huésped', table: GUESTS, row: guest, specs: GUEST_SPECS,
        defaults: { data_status: 'pendiente_datos', residence_country: 'ESP', nationality: 'ESP' }, insertFields: { event_id: context.event.id },
        check: (merged) => (merged.data_status === 'datos_revisados' && missingForSes(merged).length ? `Para dar los datos por revisados falta: ${missingText(merged)}.` : null),
        extra: (merged) => {
          const missing = missingText(merged);
          return [
            el('p', { class: missing ? 'banner warn' : 'banner ok', id: 'sesMissing' }, missing ? `Falta para SES: ${missing}.` : 'Datos completos para SES.Hospedajes.'),
            guest ? restrictionsBlock(guest, context) : null,
            guest ? receiptLink(guest) : null,
            guest ? el('div', { class: 'choices', style: 'margin-top:10px' },
              guest.signed_at ? el('span', { class: 'chip ok', id: 'signedChip' }, `Firmado ${formatDate(guest.signed_at)}${guest.signature_file_id ? '' : ' (en papel)'}`) : null,
              el('button', { class: 'ghost small', type: 'button', id: 'signOnScreen', onclick: async () => { if (await sheet?.close()) openSign(guest, onDate); } }, guest.signed_at ? 'Volver a firmar' : 'Firmar en pantalla'),
              el('button', { class: 'ghost small', type: 'button', id: 'printEntry', onclick: () => printEntry(guest, context.reservation, context.event) }, 'Imprimir parte'),
              guest.signed_at ? null : el('button', { class: 'ghost small', type: 'button', id: 'signedOnPaper', onclick: async () => {
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
      const alive = ((await client.list(GUESTS)) as Row[]).filter((g) => g.event_id === event.id).length;
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
      const list = (pairs: Array<[string, unknown]>) => el('dl', { class: 'kv sesdata' }, pairs.flatMap(([term, raw]) => {
        const value = raw === null || raw === undefined || raw === '' ? '' : String(raw);
        return [el('dt', null, term), el('dd', null, el('span', { class: 'value' }, value || '—'),
          value ? el('button', { class: 'ghost small', type: 'button', 'aria-label': `Copiar ${term.toLowerCase()}`, onclick: () => {
            void navigator.clipboard.writeText(value).then(() => toast('Copiado'), () => toast('No se pudo copiar.'));
          } }, 'Copiar') : null)];
      }));
      void sheet?.close(true);
      sheet = openSheet({
        title: `Datos para SES · ${fullName(guest)}`,
        body: el('div', { id: 'sesData' }, el('div', { class: 'sectionlabel' }, 'Viajero'), list(traveler), el('div', { class: 'sectionlabel' }, 'Transacción'), list(transaction)),
        foot: el('div', { class: 'choices' }, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close(true) }, 'Cerrar')),
        onClose: () => { sheet = null; },
      });
    }

    function openSent(guest: Row): void {
      const file = el('input', { type: 'file', id: 'receiptFile', accept: 'application/pdf,image/*' });
      const fileField = el('label', { class: 'field' }, el('span', null, 'Justificante (PDF o imagen)'), file,
        el('span', { class: 'hint' }, 'Opcional. Las imágenes se reducen antes de guardarse.'));
      sheet = openRowSheet({
        client, title: `Envío a SES · ${fullName(guest)}`, table: GUESTS, row: null, specs: SENT_SPECS,
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

    async function paint(): Promise<void> {
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
      const select = el('select', { id: 'eventSelect', 'aria-label': 'Evento', onchange: () => navigate(`#/huespedes/${select.value}`) },
        events.map(({ event, reservation }) => el('option', { value: event.id }, `${reservation.title} · ${dateRange(reservation)}`)));
      select.value = eventId;
      replace(selectHost, el('label', { class: 'field' }, el('span', null, 'Evento'), select));

      if (!allowed) {
        const counts = el('div', { class: 'card', id: 'guestSummary' }, el('p', { class: 'hint' }, 'Cargando recuentos…'));
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

      const guests = ((await client.list(GUESTS)) as Row[]).filter((g) => g.event_id === eventId).sort((a, b) => fullName(a).localeCompare(fullName(b), 'es'));
      const restrictions = ((await client.list(RESTRICTIONS)) as Row[]).filter((r) => r.event_id === eventId);
      const context = { reservation: current.reservation, event: current.event, restrictions };
      const queue = guests.filter((g) => g.data_status === 'datos_revisados' && g.ses_status === 'listo_para_envio');
      const reviewed = guests.filter((g) => g.data_status === 'datos_revisados' && g.ses_status === 'pendiente_envio');
      const count = (filter: (g: Row) => boolean) => String(guests.filter(filter).length);

      replace(body,
        el('div', { class: 'card', id: 'guestSummary' }, el('h3', null, plural(guests.length, 'huésped', 'huéspedes')), el('dl', { class: 'kv' },
          el('dt', null, 'Mujeres'), el('dd', null, count((g) => g.sex === 'M')), el('dt', null, 'Hombres'), el('dd', null, count((g) => g.sex === 'H')),
          el('dt', null, 'Otro o sin indicar'), el('dd', null, count((g) => g.sex !== 'M' && g.sex !== 'H')), el('dt', null, 'Menores'), el('dd', null, count((g) => g.is_minor === true)),
          el('dt', null, 'Firmados'), el('dd', null, count((g) => !!g.signed_at)), el('dt', null, 'Enviados a SES'), el('dd', null, count((g) => g.ses_status === 'enviado_SES')))),
        queue.length + reviewed.length === 0 ? null : [
          el('div', { class: 'sectionlabel' }, 'Envío a SES.Hospedajes', el('span', { class: 'count' }, String(queue.length))),
          el('p', { class: 'hint' }, 'El plazo es de 24 horas desde la entrada. El envío se hace en la web de SES; aquí se anota.'),
          el('ul', { class: 'list', id: 'sesQueue' }, [...queue, ...reviewed].map((g) => listRow({
            id: g.id, title: fullName(g), meta: [[g.document_type, g.document_number].filter(Boolean).join(' ') || 'menor sin documento', label(g.ses_status)], pending: g._pending === true,
            actions: [el('button', { class: 'ghost small', type: 'button', 'aria-label': `Datos para SES de ${fullName(g)}`, onclick: () => void openSesData(g, context) }, 'Datos para SES'), ...(writable ? [g.ses_status === 'listo_para_envio'
              ? el('button', { class: 'ghost small', type: 'button', 'aria-label': `Registrar envío de ${fullName(g)}`, onclick: () => openSent(g) }, 'Registrar envío')
              : el('button', { class: 'ghost small', type: 'button', 'aria-label': `Marcar listo para envío a ${fullName(g)}`, onclick: () => void run(
                  [{ op: 'update', table: GUESTS, id: g.id, expectedRevision: g.revision, fields: { ses_status: 'listo_para_envio' } }], 'Listo para envío.') }, 'Listo para envío')] : [])],
          })))],
        el('div', { class: 'sectionlabel' }, 'Registro', el('span', { class: 'count', id: 'guestCount' }, String(guests.length))),
        guests.length === 0
          ? el('div', { class: 'empty' }, el('strong', null, 'Nadie registrado todavía'), 'Añade a cada persona alojada con los datos de su documento. No se guardan copias ni fotos.')
          : el('ul', { class: 'list', id: 'guestList', 'aria-label': 'Huéspedes' }, guests.map((g) => listRow({
              id: g.id, title: fullName(g) || 'Sin nombre',
              meta: [g.code ?? 'código pendiente', g.is_minor ? 'menor' : null, missingForSes(g as GuestLike).length ? 'faltan datos para SES' : null],
              chips: [el('span', { class: 'chip' }, label(g.data_status)), g.signed_at ? el('span', { class: 'chip ok' }, 'Firmado') : null,
                g.ses_status === 'enviado_SES' ? el('span', { class: 'chip ok' }, 'Enviado a SES') : null],
              pending: g._pending === true,
              ...(writable ? { onClick: () => openGuest(g, context), label: `Editar ${fullName(g)}` } : {}),
            }))),
        writable ? el('button', { class: 'fab', type: 'button', id: 'newGuest', onclick: () => openGuest(null, context) }, icon('plus'), 'Nuevo huésped') : null,
      );
    }

    void paint();
    const offs = [RESERVATIONS, EVENTS, ...(allowed ? [GUESTS, RESTRICTIONS] : [])].map((table) => client.onTable(table, () => void paint()));
    return () => {
      offs.forEach((off) => off());
      void sheet?.close(true);
    };
  };
}
