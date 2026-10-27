/**
 * Correo de Organizers (avisos de comentarios nuevos, 0709). Dos piezas puras y probables sin red:
 * - `commentNoticeEmail`: el aviso en texto plano, sin el texto de los comentarios ni el nombre de los asistentes;
 * - `createSmtpMailer`: un cliente SMTP mínimo con TLS desde el primer byte (465; la Edge de Supabase no deja salir por 25 ni
 *   587), AUTH PLAIN y el cuerpo en base64. Con las mismas credenciales que VG ponga en Auth (`IKISAI_SMTP_*`).
 */

export interface MailMessage { to: string; subject: string; text: string }
export interface Mailer { send(message: MailMessage): Promise<void> }

export interface NoticeReservation { title: string; comments: number }

/** El aviso de comentarios nuevos: un correo con todos sus retiros y el enlace a Mis retiros. */
export function commentNoticeEmail(reservations: readonly NoticeReservation[], link: string): { subject: string; text: string } {
  const total = reservations.reduce((n, r) => n + r.comments, 0);
  const line = (r: NoticeReservation) => `- ${oneLine(r.title) || 'Tu retiro'}: ${r.comments === 1 ? '1 comentario nuevo' : `${r.comments} comentarios nuevos`}`;
  return {
    subject: total === 1 ? 'Un comentario nuevo de tus asistentes' : `${total} comentarios nuevos de tus asistentes`,
    text: [
      'Hola:',
      '',
      'Tus asistentes te han dejado comentarios sobre tu retiro que aún no has visto:',
      '',
      ...reservations.map(line),
      '',
      `Léelos en Ikisai Organizers: ${link}`,
      '',
      'Te avisamos como mucho una vez cada hora y solo de lo que aún no has visto.',
      'Ikisai',
    ].join('\n'),
  };
}

const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
const ADDRESS = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/;

/** Una conexión ya cifrada (Deno.connectTls en la Edge; un doble en las pruebas). */
export interface SmtpConnection {
  read(buffer: Uint8Array): Promise<number | null>;
  write(data: Uint8Array): Promise<number>;
  close(): void;
}

export interface SmtpConfig {
  host: string; port?: number; user: string; pass: string;
  /** Remitente: `avisos@ikisai.com` o `Ikisai <avisos@ikisai.com>`. */
  from: string;
  connect?: (host: string, port: number) => Promise<SmtpConnection>;
  /** Para Message-ID y Date en las pruebas. */
  now?: () => Date;
}

export class SmtpError extends Error {
  constructor(public stage: string, public reply: string) { super(`SMTP ${stage}: ${reply.slice(0, 200)}`); }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));
/** Cabecera con UTF-8 (RFC 2047), en trozos para no pasar de 75 caracteres por palabra. */
const header = (s: string) => {
  const bytes = enc.encode(oneLine(s));
  const words: string[] = [];
  for (let i = 0; i < bytes.length; i += 45) words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes.slice(i, i + 45)))}?=`);
  return words.join('\r\n ') || '""';
};
const bare = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim();

/** El mensaje completo (cabeceras y cuerpo en base64, líneas de 76), sin el punto final de DATA. */
export function buildMessage(message: MailMessage, from: string, now: Date): string {
  const body = b64(message.text.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g)?.join('\r\n') ?? '';
  const domain = bare(from).split('@')[1] ?? 'ikisai.com';
  return [
    `From: ${oneLine(from)}`,
    `To: <${message.to}>`,
    `Subject: ${header(message.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const port = config.port ?? 465;
  const connect = config.connect ?? (async (hostname: string, p: number) => (globalThis as any).Deno.connectTls({ hostname, port: p }) as SmtpConnection);
  return {
    async send(message) {
      if (!ADDRESS.test(message.to)) throw new SmtpError('address', message.to);
      const conn = await connect(config.host, port);
      let pending = '';
      const reply = async (stage: string, expect: number): Promise<string> => {
        const buffer = new Uint8Array(4096);
        for (;;) {
          // Respuesta completa: la última línea es «NNN texto» (las anteriores, «NNN-texto»).
          const lines = pending.split('\r\n');
          const done = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
          if (done >= 0 && done < lines.length - 1) {
            const text = lines.slice(0, done + 1).join('\n');
            pending = lines.slice(done + 1).join('\r\n');
            if (Number(text.split('\n').at(-1)!.slice(0, 3)) !== expect) throw new SmtpError(stage, text);
            return text;
          }
          const n = await conn.read(buffer);
          if (n === null) throw new SmtpError(stage, pending || 'connection closed');
          pending += dec.decode(buffer.subarray(0, n));
        }
      };
      const say = async (line: string, stage: string, expect: number) => { await conn.write(enc.encode(line + '\r\n')); return reply(stage, expect); };
      try {
        await reply('greeting', 220);
        await say(`EHLO ${bare(config.from).split('@')[1] ?? 'ikisai.com'}`, 'ehlo', 250);
        await say(`AUTH PLAIN ${b64(`\u0000${config.user}\u0000${config.pass}`)}`, 'auth', 235);
        await say(`MAIL FROM:<${bare(config.from)}>`, 'mail', 250);
        await say(`RCPT TO:<${message.to}>`, 'rcpt', 250);
        await say('DATA', 'data', 354);
        await say(buildMessage(message, config.from, config.now?.() ?? new Date()) + '\r\n.', 'body', 250);
        await conn.write(enc.encode('QUIT\r\n')).catch(() => 0);
      } finally {
        try { conn.close(); } catch { /* ya cerrada */ }
      }
    },
  };
}

/** El SMTP de la Edge, o `null` si falta algo: `IKISAI_SMTP_HOST`, `_PORT` (465), `_USER`, `_PASS` y `_FROM`. */
export function smtpFromEnv(get: (name: string) => string | undefined): Mailer | null {
  const host = get('IKISAI_SMTP_HOST'); const user = get('IKISAI_SMTP_USER'); const pass = get('IKISAI_SMTP_PASS'); const from = get('IKISAI_SMTP_FROM');
  if (!host || !user || !pass || !from) return null;
  return createSmtpMailer({ host, port: Number(get('IKISAI_SMTP_PORT') ?? 465) || 465, user, pass, from });
}
