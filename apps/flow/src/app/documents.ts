/**
 * Documentos de un flujo (guías del Inicio). Decisión de VG del 26-10: después del sábado se subirán al crear el flujo,
 * como archivos del proyecto (core.files, bucket de Flow); hoy vienen del código, solo para el flujo de la barra. El
 * Inicio lee esta lista y no sabe de dónde sale, así que pasar a archivos solo cambia esta función.
 */
export interface ProjectDocument {
  id: string;
  title: string;
  /** Miniatura (se precarga). */
  thumb: string;
  /** Tamaño completo (solo al ampliar). */
  full: string;
}

const BAR_PROJECT = '0f10a000-0000-4000-8000-000000000001';

const BAR_GUIDES: ProjectDocument[] = [
  ['montaditos', 'Montaditos · montaje y estaciones'],
  ['barra', 'Barra · bebidas y extras'],
  ['frigorifico', 'Frigorífico · almacenamiento y frío'],
  ['mesa', 'Mesa de trabajo · disposición y orden'],
].map(([slug, title]) => ({ id: slug!, title: title!, thumb: `/guias/${slug}-mini.webp`, full: `/guias/${slug}.webp` }));

export async function projectDocuments(projectId: string | null): Promise<ProjectDocument[]> {
  return projectId === BAR_PROJECT ? BAR_GUIDES : [];
}
