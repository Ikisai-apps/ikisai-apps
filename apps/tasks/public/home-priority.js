/* Inicio · «La cola» (MUELA-055): de más a menos urgente, sin línea de motivos. Funciones puras (sin DOM ni estado), probadas en
   tests/tasks/home-priority.test.ts. El orden:
   1. vencidas, más cuanto más tiempo llevan vencidas;
   2. las de hoy;
   3. las críticas;
   4. las que bloquean a otras (más cuantas más bloquean);
   5. las paradas desde hace 10 días o más (sin cambios en `updatedAt`);
   y después el resto (alta antes que normal; la que vence antes, antes). Las bloqueadas no entran: van a «Bloqueos».
   Dentro de cada escalón suma un poco la prioridad, para que una vencida crítica vaya delante de una vencida normal. */
const PRIORITY_STEP={overdue:50000,today:40000,critical:30000,blocking:20000,stalled:10000};
const PRIORITY_BONUS={critical:30,high:10,normal:0};
/* Días enteros entre dos fechas `AAAA-MM-DD` (b − a), en el calendario, sin horas. */
function homeDaysBetween(a,b){const pa=String(a||'').split('-').map(Number),pb=String(b||'').split('-').map(Number);if(pa.length!==3||pb.length!==3||pa.some(isNaN)||pb.some(isNaN))return null;return Math.round((Date.UTC(pb[0],pb[1]-1,pb[2])-Date.UTC(pa[0],pa[1]-1,pa[2]))/86400000)}
/* La urgencia de una tarea pendiente (`null` si no entra en la cola: hecha o bloqueada).
   task: {done, blocked (n.º de lo que la bloquea), due ('AAAA-MM-DD' o ''), prio, blocksOthers (n.º), updatedAt (ISO)};
   today: 'AAAA-MM-DD' en hora local; now: milisegundos (para lo parado). */
function priorityOf(task,today,now=Date.now()){
  if(!task||task.done||task.blocked)return null;
  const bonus=PRIORITY_BONUS[task.prio]||0,days=task.due?homeDaysBetween(task.due,today):null;
  if(days!=null&&days>0)return PRIORITY_STEP.overdue+Math.min(days,999)*10+bonus;
  if(days===0)return PRIORITY_STEP.today+bonus;
  if(task.prio==='critical')return PRIORITY_STEP.critical+(days!=null?Math.max(0,60+days):0);
  if(task.blocksOthers>0)return PRIORITY_STEP.blocking+Math.min(task.blocksOthers,99)*10+bonus;
  const updated=task.updatedAt?Date.parse(task.updatedAt):NaN,stalled=isNaN(updated)?0:Math.floor((now-updated)/86400000);
  if(stalled>=10)return PRIORITY_STEP.stalled+Math.min(stalled,999)+bonus;
  // El resto: lo que vence en las próximas semanas, antes; la prioridad, después.
  return bonus*20+(days!=null?Math.max(0,90+days):0);
}
/* Ordena (de más a menos urgente) las que entran en la cola; a igual urgencia, la que vence antes y después por título. */
function homeQueue(items,today,now=Date.now(),get=x=>x){
  return items.map(item=>({item,score:priorityOf(get(item),today,now)})).filter(x=>x.score!=null)
    .sort((a,b)=>b.score-a.score||String(get(a.item).due||'9999').localeCompare(String(get(b.item).due||'9999'))||String(get(a.item).title||'').localeCompare(String(get(b.item).title||''),'es'))
}
