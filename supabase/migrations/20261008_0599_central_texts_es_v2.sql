-- Ikisai Central · textos en español v2, revisados por el usuario el 8-10-2026 (coordinacion/central/textos_es_v2.md).
-- Solo el cuerpo en español de las 18 claves de legal, mensajes e información práctica; el inglés, los títulos y el contacto no
-- cambian. Los datos de la Entidad y del contacto van como marcadores (el repositorio es público).
-- Una clave solo se actualiza si **nadie la ha editado a mano en la app**: todas sus versiones en español las escribieron
-- semillas o migraciones (`updated_by` nulo). Si no, se respeta y se lista en `skipped` (y en un aviso de la migración).
-- `payment.instructions` va sin la línea de Bizum (aún no hay número). Toca solo el schema central.

create or replace function central.apply_texts_es_v2()
returns jsonb language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; v_skipped text[] := '{}'; s record; t central.texts;
begin
  for s in select * from (values
    ('organizers' || '.declaration', $v2$Facilito estos datos con conocimiento de mis asistentes y únicamente para organizar su estancia en Ikisai. Cada asistente recibirá la información sobre protección de datos al abrir su enlace personal.$v2$),
    ('portal.privacy', $v2$**Información sobre protección de datos**

**Responsable:** {{entidad.razon_social}} (NIF {{entidad.nif}}), {{entidad.domicilio}}. Contacto: {{contacto.huespedes}} · {{contacto.telefono}}.

**Para qué usamos tus datos:** para organizar tu estancia en Ikisai (alojamiento, comidas y actividades) y, cuando se trata de un servicio de alojamiento, cumplir la obligación legal de registrar a los viajeros y comunicarlo al Ministerio del Interior (Real Decreto 933/2021).

**Base legal:** la prestación del servicio que has contratado, directamente o a través de quien organiza tu retiro, y el cumplimiento de una obligación legal.

**Quién los ve:** el equipo de Ikisai que gestiona tu estancia. Quien organiza tu retiro solo puede ver tu nombre, si has completado tus datos y lo que esa persona haya escrito; tus alergias, únicamente si tú lo permites. Cuando la ley lo exige, comunicamos los datos al Ministerio del Interior (SES.HOSPEDAJES). No vendemos ni cedemos tus datos para publicidad.

**Cuánto tiempo:** conservamos los datos del registro de viajeros durante tres años desde el final de tu estancia, como exige la ley. El resto, como máximo seis meses después de tu estancia. Después los borramos o anonimizamos.

**Tus derechos:** puedes solicitar acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a {{contacto.huespedes}}. Si consideras que no hemos atendido correctamente tu solicitud, puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es).$v2$),
    ('guests' || '.signature_statement', $v2$Declaro que los datos que he facilitado son ciertos y completos. Con mi firma acepto el parte de entrada del alojamiento, que Ikisai conservará durante el plazo exigido por la ley (Real Decreto 933/2021).$v2$),
    ('organizers' || '.dates_note', $v2$Marca las fechas que te vengan bien y nosotros te confirmaremos la definitiva. Por ahora son posibilidades, que los calendarios también tienen sus cosas.$v2$),
    ('organizers' || '.quote_note', $v2$El precio es orientativo e incluye el IVA. Cada retiro tiene un importe mínimo, que el equipo de Ikisai te confirmará en la propuesta. Así tendrás las cuentas claras desde el principio.$v2$),
    ('organizers' || '.proposal_note', $v2$¿Te encaja la propuesta? Pulsa «Quiero confirmar» y el equipo de Ikisai se pondrá en contacto contigo para seguir adelante.$v2$),
    ('payment.instructions', $v2$**Por transferencia:** a la cuenta {{entidad.iban}}, a nombre de {{entidad.razon_social}}.

En el concepto, indica el código de tu reserva y tu nombre. Por ejemplo: «RSV_2026_012 Ana López».

Si tienes cualquier duda con el pago, escríbenos a {{contacto.organizadores}} y te echamos una mano.$v2$),
    ('portal.menu_note', $v2$El menú puede cambiar para adaptarse a alergias e intolerancias.$v2$),
    ('guests' || '.data_why', $v2$Te pedimos estos datos para preparar tu estancia (alojamiento y comidas). Además, la ley obliga a los alojamientos a registrar a sus huéspedes y comunicarlo al Ministerio del Interior. Solo pedimos lo necesario, y quien organiza tu retiro no ve tus datos de identidad.$v2$),
    ('guests' || '.allergies_notice', $v2$Cuéntanos tus alergias e intolerancias para que la cocina pueda tenerlas en cuenta. Hacemos todo lo posible por adaptar los menús, pero en una cocina compartida no podemos garantizar la ausencia total de trazas. Si tu alergia es grave, avísanos también en persona al llegar.$v2$),
    ('guests' || '.menu_notice', $v2$El menú puede cambiar para adaptarse a las alergias e intolerancias del grupo. Si tienes alguna, comprueba que la has indicado en tus datos para que podamos tenerla en cuenta.$v2$),
    ('portal.practical', $v2$**Antes del retiro:** cada asistente recibirá en su enlace personal lo necesario para preparar su estancia: cómo llegar, qué traer y algunas pautas para convivir a gusto.

**Durante el retiro:** el equipo de Ikisai atenderá las necesidades del grupo en el {{contacto.telefono}} y a través de la aplicación para organizadores y huéspedes.

**Dónde:** {{entidad.lugar}}.$v2$),
    ('info.map_link', $v2${{entidad.mapa}}$v2$),
    ('info.arrival', $v2$Los horarios de llegada y salida los acuerda quien organiza tu retiro. Si vas a llegar fuera de ese horario o te retrasas, avísanos al {{contacto.telefono}}. Así podremos organizarnos mejor.

**Dirección:** {{entidad.lugar}}.$v2$),
    ('info.parking', $v2$¿Vienes en coche? Pregunta a quien organiza tu retiro o escríbenos a {{contacto.huespedes}} y te indicaremos dónde aparcar. Y, si podéis, compartid coche: mejor conversación por el camino y menos coches en la sierra.$v2$),
    ('info.facilities', $v2$Cuando llegues, el equipo de Ikisai te enseñará los espacios reservados para tu grupo: alojamiento, comedor y salas de actividad. Si necesitas algo durante la estancia, pregúntanos con confianza. Para eso estamos.$v2$),
    ('info.rules', $v2$Cuida los espacios y respeta el descanso de los demás, que así disfrutamos todos. Sigue las indicaciones del equipo de Ikisai y de quien organiza tu retiro. Si algo se rompe o no funciona, avísanos cuanto antes para poder solucionarlo.$v2$),
    ('info.bring', $v2$Ropa cómoda, calzado para caminar, algo de abrigo para la noche, tu medicación habitual y lo que te indique quien organiza tu retiro. Y no subestimes el abrigo: las noches en la sierra tienen su carácter.$v2$)
  ) as x(key, body) loop
    select * into t from central.texts where key = s.key and lang = 'es' and deleted_at is null;
    if t.id is null or t.body = s.body then continue; end if;
    if t.updated_by is not null or exists (select 1 from central.text_versions v where v.text_id = t.id and v.updated_by is not null) then
      v_skipped := v_skipped || s.key;
      continue;
    end if;
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'central.texts', 'id', t.id, 'expectedRevision', t.revision,
      'fields', jsonb_build_object('body', s.body));
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-0599-texts-es-v2', v_ops);
  end if;
  if array_length(v_skipped, 1) > 0 then
    raise notice 'central 0599: textos editados a mano, sin cambiar: %', array_to_string(v_skipped, ', ');
  end if;
  return jsonb_build_object('applied', jsonb_array_length(v_ops), 'skipped', to_jsonb(v_skipped));
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.apply_texts_es_v2(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
