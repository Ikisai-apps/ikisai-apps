/** Central · ámbitos de Flow (encargo de VG del 27-10): reglas puras de `_domain/central/scopes.ts`. Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { flowProjectsOf, flowScopeSummary, sortFlowProjects, withFlowProjects } from '../../supabase/functions/_domain/central/mod.ts';

const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';
const c = '00000000-0000-4000-8000-00000000000c';

test('ámbitos de Flow · leer y escribir scopes.projects sin tocar el resto', () => {
  assert.equal(flowProjectsOf(null), null);
  assert.equal(flowProjectsOf({ grants: [] }), null);
  assert.deepEqual(flowProjectsOf({ projects: [a, 3, b] }), [a, b]);
  assert.deepEqual(withFlowProjects(null, [a, a, b]), { projects: [a, b] });
  assert.deepEqual(withFlowProjects({ projects: [c], otra: true }, [b]), { projects: [b], otra: true });
  assert.deepEqual(withFlowProjects([1, 2], []), { projects: [] });
});

test('ámbitos de Flow · el más actual arriba y el resumen en palabras', () => {
  const projects = [
    { id: a, name: 'Retiro de primavera', starts_on: '2026-03-01', ends_on: '2026-03-03' },
    { id: b, name: 'Boda de noviembre', starts_on: '2026-11-20', ends_on: '2026-11-21' },
    { id: c, name: 'Barra · Evento de octubre', starts_on: '2026-10-30', ends_on: '2026-11-01' },
    { id: 'x', name: 'Cerrado', status: 'closed', starts_on: '2026-12-01' },
  ];
  assert.deepEqual(sortFlowProjects(projects, '2026-10-27').map((p) => p.name), ['Barra · Evento de octubre', 'Boda de noviembre', 'Cerrado', 'Retiro de primavera']);
  assert.equal(flowScopeSummary('owner', null, projects), 'Todos los proyectos (propietario)');
  assert.equal(flowScopeSummary('editor', null, projects), 'Ningún proyecto');
  assert.equal(flowScopeSummary('editor', { projects: [] }, projects), 'Ningún proyecto');
  assert.equal(flowScopeSummary('editor', { projects: [b, c] }, projects), 'Boda de noviembre y Barra · Evento de octubre');
  assert.equal(flowScopeSummary('outsider', { projects: [a, b, c] }, projects), 'Retiro de primavera, Boda de noviembre y 1 más');
  assert.equal(flowScopeSummary('reader', { projects: ['zz'] }, projects), 'un proyecto que ya no está');
});
