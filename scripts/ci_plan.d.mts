/** Tipos de scripts/ci_plan.mjs para las pruebas (tests/core/ci-plan.test.ts). */
export interface PgliteGroup { name: string; folders: string; shard?: string }
export interface CiPlan { code: boolean; full: boolean; folders: string[]; groups: PgliteGroup[] }
export function isDoc(file: string): boolean;
export function testFolders(root?: string): string[];
export function ownerOf(file: string, apps: readonly string[]): string | null;
export function groups(folders: readonly string[], root?: string, split?: number, pack?: number): PgliteGroup[];
export function plan(options?: { event?: string; files?: string[]; root?: string }): CiPlan;
