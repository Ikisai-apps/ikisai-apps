/**
 * Administración común (contrato §3.5) desde Central: cuentas, accesos, altas, agentes y registro de todas las apps.
 * Todo necesita red: se lee y escribe en Core en el momento. La última lectura se guarda en memoria (no en el
 * dispositivo: lleva correos) para pintarla sin red mientras dure la sesión.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { offlineError } from './client.ts';

export type Role = 'reader' | 'editor' | 'owner';

export interface CatalogApp {
  id: string;
  name: string;
  domain: string;
  aliasDomain: string | null;
  kind: string;
  description: string | null;
}

export interface AccountMembership {
  app: string;
  role: Role;
  scopes: unknown;
  revision: number;
  updatedAt?: string;
}

export interface Account {
  userId: string;
  email: string | null;
  displayName: string;
  kind: 'human' | 'agent';
  createdAt: string;
  lastSignInAt: string | null;
  disabled?: boolean;
  bannedUntil?: string | null;
  memberships: AccountMembership[];
  agentKeys: number;
}

export interface AgentKey {
  keyId: string;
  userId: string;
  name: string;
  hint: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  memberships: Array<{ app: string; role: Role; scopes: unknown }>;
}

export interface AccessEvent {
  id: number;
  at: string;
  app: string | null;
  event: string;
  actorId: string | null;
  keyId: string | null;
  meta: Record<string, unknown> | null;
}

export interface InviteResult {
  userId: string;
  email: string;
  created: boolean;
  temporaryPassword: string | null;
}

export const ROLE_LABELS: Record<Role, string> = { reader: 'Lector', editor: 'Editor', owner: 'Propietario' };

/** Lo que significa cada evento del registro de accesos de Core. */
export const EVENT_LABELS: Record<string, string> = {
  member_changed: 'Acceso cambiado',
  member_invited: 'Alta de acceso',
  key_issued: 'Clave de agente emitida',
  key_revoked: 'Clave de agente revocada',
  proposal_prepared: 'Propuesta de agente preparada',
  proposal_approved: 'Propuesta aprobada',
  proposal_rejected: 'Propuesta rechazada',
  proposal_consumed: 'Propuesta aplicada',
  password_reset: 'Contraseña temporal nueva',
  account_disabled: 'Cuenta desactivada',
  account_enabled: 'Cuenta reactivada',
};

export function createAdminApi(client: SyncClient) {
  const memory: { accounts?: { at: string; items: Account[] }; catalog?: CatalogApp[]; agents?: { at: string; items: AgentKey[] } } = {};

  async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
    if (!navigator.onLine) throw offlineError();
    return client.api<T>(path, init);
  }

  return {
    cached: memory,
    async catalog(): Promise<CatalogApp[]> {
      if (memory.catalog) return memory.catalog;
      const out = await call<{ items: CatalogApp[] }>('/catalog/apps');
      memory.catalog = out.items;
      return out.items;
    },
    async accounts(): Promise<Account[]> {
      const out = await call<{ items: Account[] }>('/admin/accounts');
      memory.accounts = { at: new Date().toISOString(), items: out.items };
      return out.items;
    },
    setMembership: (body: { app: string; userId: string; role: Role | null; scopes?: unknown; displayName?: string }) =>
      call<AccountMembership | { removed: true }>('/admin/memberships', { method: 'POST', json: body }),
    invite: (body: { email: string; displayName?: string; memberships: Array<{ app: string; role: Role; scopes?: unknown }> }) =>
      call<InviteResult>('/admin/invite', { method: 'POST', json: body }),
    resetPassword: (userId: string) => call<{ userId: string; temporaryPassword: string }>(`/admin/accounts/${userId}/password`, { method: 'POST', json: {} }),
    setDisabled: (userId: string, disabled: boolean) => call<{ userId: string; disabled: boolean }>(`/admin/accounts/${userId}/${disabled ? 'disable' : 'enable'}`, { method: 'POST', json: {} }),
    async agents(): Promise<AgentKey[]> {
      const out = await call<{ items: AgentKey[] }>('/admin/agents');
      memory.agents = { at: new Date().toISOString(), items: out.items };
      return out.items;
    },
    revokeAgent: (keyId: string) => call<{ keyId: string; revoked: boolean; proposalsRevoked: number }>(`/admin/agents/${keyId}`, { method: 'DELETE' }),
    accessLog: (params: { app?: string; before?: number; limit?: number }) => {
      const q = new URLSearchParams();
      if (params.app) q.set('app', params.app);
      if (params.before) q.set('before', String(params.before));
      q.set('limit', String(params.limit ?? 50));
      return call<{ items: AccessEvent[]; hasMore: boolean; nextBefore: number | null }>(`/admin/access-log?${q}`);
    },
    clear(): void {
      delete memory.accounts; delete memory.catalog; delete memory.agents;
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

/**
 * Resumen legible de los ámbitos de una pertenencia. Cada app interpreta los suyos (contrato §3); aquí solo se
 * describen los conocidos y se edita únicamente el de Central (decisión del usuario, ronda 2: el resto, en su app).
 */
export function describeScopes(app: string, scopes: unknown): string | null {
  if (scopes === null || scopes === undefined) return null;
  const s = scopes as Record<string, unknown>;
  if (app === 'central') return s.people === true ? 'Ve datos reservados de personas' : null;
  if (app === 'booking') return s.guests === true ? 'Ve huéspedes' : null;
  if (typeof s === 'object' && Object.keys(s).length === 0) return null;
  return 'Acceso limitado (se edita en la app)';
}
