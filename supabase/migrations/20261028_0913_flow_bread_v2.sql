-- Ikisai Flow · pan v2 (visión V0.2 aprobada por VG, 27-10; cola de Core «A»). Métrica `bread_v2` para el puesto «Pan»
-- de la v2; `bread_ahead` (0908) no cambia.
-- - Demanda FIRME: montaditos cobrados cuya unidad aún no está hecha (pendiente o en curso), × `bread_per_unit`.
-- - Demanda PREVISTA: ritmo × horizonte (calentar + adelanto). Ritmo = unidades de los pedidos cobrados en la ventana
--   (`lookback_min`, como mucho `per_order_cap` por pedido) / ventana; suavizado con una ventana larga (`smooth_min`,
--   peso `smooth_weight`) para que no salte con cada pedido. 7 montaditos en 5 min = 1,4/min (sin suavizado).
-- - Política de confianza: los tramos de siempre (`tiers`, descuento por ritmo) se aplican SOLO a la prevista.
-- - target = mín(capacidad de la máquina `machine_capacity`, firme + ⌊prevista × (1 − pct/100)⌋). Sin conteo manual.
-- - Histéresis (`hysteresis`, en panes): la app solo cambia la cifra mostrada si se mueve al menos eso o si quedaría por
--   debajo de lo firme (ver app/data.ts, steadyMetrics).

create or replace function flow.metric_bread_v2(p_project uuid, p_params jsonb) returns jsonb language plpgsql stable as $$
declare
  v_lookback numeric := greatest(coalesce((p_params->>'lookback_min')::numeric, 5), 0.5);
  v_smooth numeric := greatest(coalesce((p_params->>'smooth_min')::numeric, 15), 0.5);
  v_weight numeric := least(greatest(coalesce((p_params->>'smooth_weight')::numeric, 0.3), 0), 1);
  v_cap int := greatest(coalesce((p_params->>'per_order_cap')::int, 4), 1);
  v_ahead numeric := coalesce((p_params->>'warmup_min')::numeric, 1) + coalesce((p_params->>'lead_min')::numeric, 1);
  v_per numeric := greatest(coalesce((p_params->>'bread_per_unit')::numeric, 1), 0);
  v_machine int := nullif(p_params->>'machine_capacity', '')::int;
  v_units int; v_units_long int; v_rate numeric; v_firm int; v_forecast numeric; v_pct numeric := 0; v_tier jsonb; v_target int;
begin
  -- Entradas de la ventana corta y de la larga (mismo tope por pedido).
  select coalesce(sum(least(n, v_cap)) filter (where paid_at >= now() - make_interval(secs => (v_lookback * 60)::double precision)), 0),
         coalesce(sum(least(n, v_cap)), 0)
    into v_units, v_units_long
    from (select o.paid_at, count(*) as n from flow.units u join flow.orders o on o.id = u.order_id
           where u.project_id = p_project and u.kind = 'prep' and u.deleted_at is null and u.status <> 'cancelled'
             and o.paid_at >= now() - make_interval(secs => (greatest(v_lookback, v_smooth) * 60)::double precision)
           group by o.id, o.paid_at) x;
  v_rate := (1 - v_weight) * (v_units / v_lookback) + v_weight * (v_units_long / greatest(v_lookback, v_smooth));
  -- Firme: lo cobrado que aún no está hecho.
  select ceil(count(*) * v_per)::int into v_firm from flow.units u join flow.orders o on o.id = u.order_id
   where u.project_id = p_project and u.kind = 'prep' and u.deleted_at is null and u.status in ('pending','in_progress') and o.status = 'paid';
  for v_tier in select * from jsonb_array_elements(coalesce(p_params->'tiers', '[{"upto": null, "pct": 0}]'::jsonb)) loop
    if v_tier->>'upto' is null or v_rate <= (v_tier->>'upto')::numeric then v_pct := coalesce((v_tier->>'pct')::numeric, 0); exit; end if;
  end loop;
  v_forecast := v_rate * v_ahead * v_per * (1 - v_pct / 100);
  v_target := v_firm + floor(v_forecast)::int;
  if v_machine is not null and v_machine >= 0 then v_target := least(v_target, v_machine); end if;
  return jsonb_build_object('target', v_target, 'firm', v_firm, 'forecast', round(v_forecast, 1), 'rate', round(v_rate, 2), 'window', v_lookback,
    'units', v_units, 'pct', v_pct, 'machine_capacity', v_machine, 'hysteresis', coalesce((p_params->>'hysteresis')::numeric, 2));
end $$;

-- La plantilla de la v2 pasa a bread_v2 (con los parámetros nuevos), y también el «Pan» de las versiones ya creadas y no
-- congeladas, conservando los parámetros que ya tuviera.
update flow.template_units set payload = payload || jsonb_build_object(
    'metric', 'bread_v2',
    'params', coalesce(payload->'params', '{}'::jsonb) || jsonb_build_object('smooth_min', 15, 'smooth_weight', 0.3, 'bread_per_unit', 1, 'hysteresis', 2),
    'text', 'Ahora deben estar calentándose {target} panes ({firm} ya cobrados + {forecast} previstos) · {rate} montaditos/min',
    'notice', 'Pan: {target} calentándose')
 where template_key = 'barra' and kind = 'station' and payload->>'metric' = 'bread_ahead' and deleted_at is null;

update flow.units u set payload = u.payload || jsonb_build_object(
    'metric', 'bread_v2',
    'params', jsonb_build_object('smooth_min', 15, 'smooth_weight', 0.3, 'bread_per_unit', 1, 'hysteresis', 2) || coalesce(u.payload->'params', '{}'::jsonb),
    'text', 'Ahora deben estar calentándose {target} panes ({firm} ya cobrados + {forecast} previstos) · {rate} montaditos/min')
  from flow.projects pr
 where pr.id = u.project_id and not pr.frozen and pr.deleted_at is null and u.kind = 'station' and u.payload->>'metric' = 'bread_ahead' and u.deleted_at is null;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
