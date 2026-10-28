// @ts-nocheck
/**
 * «Avance por aplicación» tal como era en el artefacto original (VG, 28-10: el de Flow se quedaba corto en colores, iconos,
 * filtros, hitos y gráfico). Es el código de la vista «Carriles» del artefacto casi sin tocar; solo cambia de dónde vienen
 * los datos (las unidades del flujo, sus hitos y su historial, ya en la forma del original) y que una tarjeta abierta deja
 * marcarla Pendiente, En curso o Hecha (`onState`). Sus estilos están en `styles/avance-original.css`, limitados a
 * `.avance-orig`. Todo texto de las tarjetas pasa por `esc` antes de pintarse.
 */
export interface OrigCard { id: string; uid: string; agente: string; estado: string; nombre: string; nota?: string | null; ref?: string | null;
  url?: string | null; urlTexto?: string | null; pasos?: string[]; prio?: string | null; tipo?: string | null; recurrente?: boolean; orden?: number;
  hito?: { id: string; paso?: number | null } | null;
  /** Aplicaciones en las que se hace (vista «Por app»): las puestas a mano o las de sus enlaces; si no, su agente. */
  apps?: string[]; appsManual?: boolean }
export interface OrigHito { id: string; nombre: string; orden: number; done_at: number | null }
export interface OrigSnap { t: number; hecho: number; pr: number; curso: number; pend: number; backlog: number; total: number }

export function createAvanceOriginal(HOST: HTMLElement, HORA_EL: HTMLElement, SW_SLOT: HTMLElement, CAN_EDIT: boolean,
  ON_STATE: (uid: string, estado: string) => void, MINE: string[] = [], ON_APPS: (uid: string) => void = () => {}): { setData(ruta: OrigCard[], hitos: OrigHito[], hist: OrigSnap[], agentes: string[]): void } {
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  var RUTA=[],RMETA=null;var CV='';var CSEL='';try{CV=localStorage.getItem('avance-car-vista')||'';CSEL=localStorage.getItem('avance-car-sel')||'';}catch(e){}
  var CMORE={};
  var HITOS=[];
  var IK={board:'<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="8" rx="1.5"/>',chef:'<path d="M8 15v5h8v-5"/><path d="M6.5 15a3.5 3.5 0 0 1-1-6.9A4.5 4.5 0 0 1 14 5.6 4 4 0 0 1 18.5 8a3.5 3.5 0 0 1-1 7z"/>',bed:'<path d="M3 18V7"/><path d="M3 12h18v6"/><path d="M3 15h18"/><circle cx="7.5" cy="9.5" r="1.8"/>',invoice:'<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9.5 12h5M9.5 16h5"/>',tasks:'<path d="M9 6h12M9 12h12M9 18h12"/><path d="M3 6l1.2 1.2L6.5 4.8M3 12l1.2 1.2 2.3-2.4M3 18l1.2 1.2 2.3-2.4"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',organizer:'<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><path d="M12 12.3l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z"/>',guest:'<path d="M4 20V10l8-6 8 6v10"/><circle cx="12" cy="12.3" r="2.4"/><path d="M8.3 20c.5-2.5 1.9-3.9 3.7-3.9s3.2 1.4 3.7 3.9"/>',tag:'<path d="M3 3h8.5L21 12.5 12.5 21 3 11.5z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/>',mark:'<path d="M7 3h7l4 4v14H7z" fill="rgba(127,127,127,.18)"/><path d="M14 3v4h4"/><path d="M9.5 12h5M9.5 16h3"/>',home:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/>',list:'<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>'};
  var AGI={Flow:'board',Food:'chef',Booking:'bed',Finance:'invoice',Tasks:'tasks',Central:'grid',Organizers:'organizer',Guests:'guest','UI-kit':'tag',Core:'mark','Core Ops':'list','Víctor':'home'};
  function kico(name,size){var d=IK[name];if(!d)return '';return '<svg class="ik" viewBox="0 0 24 24" width="'+(size||16)+'" height="'+(size||16)+'" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';}
  function agIco(a){return kico(AGI[a]||'grid',15)+' ';}
  var ESTI={hecho:'✔',pr:'⤴',curso:'◐',pend:'○',backlog:'⛔'};
  var TIPOS=[['arreglo','Arreglo','🔧','#c0392b'],['funcion','Función','⚒','#56663f'],['prueba','Prueba','🧪','#3a7cc4'],['decision','Decisión','🧭','#d19a3a'],['ajuste','Ajuste','⚙','#9a9a9a']];var TIPO={};TIPOS.forEach(function(t){TIPO[t[0]]=t;});
  var PRI={urgente:'<i class="st">★</i>',importante:'<i class="st half">★</i>',secundario:'<i class="st">☆</i>',opcional:'<i class="st dim">·</i>',sin:''};
  var CF={ag:{},est:{},pr:{},tipo:{},hito:{},flag:{}};try{var _cf=JSON.parse(localStorage.getItem('avance-car-filtro')||'null');if(_cf&&_cf.ag&&_cf.est&&_cf.pr){CF=_cf;if(!CF.tipo)CF.tipo={};if(!CF.hito)CF.hito={};if(!CF.flag)CF.flag={};}}catch(e){}
  function cfSave(){try{localStorage.setItem('avance-car-filtro',JSON.stringify(CF));}catch(e){}}
  function cfAny(o){for(var k in o)if(o[k])return true;return false;}
  function cfToggle(g,k){if(CF[g][k])delete CF[g][k];else CF[g][k]=true;for(var q in CF[g])if(!CF[g][q])delete CF[g][q];cfSave();rRender();}
  var COPEN={};var HX={};var HFOLD={};try{HFOLD=JSON.parse(localStorage.getItem('avance-hitos-plegados')||'{}')||{};}catch(e){};

  // ── Historial de estados: una foto {t, hecho, pr, curso, pend, backlog, total} cuando cambian los recuentos (≥10 min) o cada 6 h ──
  // «Actualizado a las»: la última vez que llegaron datos del tablero (cualquier cambio de tarjeta, mío o de Core Ops), no una fecha fija.
  var HORA0=false;function horaAhora(){if(HORA0){HORA0=false;return;}var H=HORA_EL;if(!H)return;var d=new Date();H.textContent='Actualizado a las '+d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Madrid'});H.title=d.toLocaleDateString('es-ES',{day:'numeric',month:'short',timeZone:'Europe/Madrid'})+' · último cambio recibido (hora de España)';H.hidden=false;}
  var WOPEN={};
  var HIST=[],HDB=null,HREC=0,GOPEN=false;try{GOPEN=localStorage.getItem('avance-graf')==='1';}catch(e){}
  var HK=['hecho','pr','curso','pend','backlog'];
  function recHist(n,total){if(!HDB||!RUTA.length)return;var now=Date.now();if(now-HREC<600e3)return;var last=HIST.length?HIST[HIST.length-1]:null;
    var same=!!last&&HK.every(function(k){return (last[k]||0)===(n[k]||0);})&&(last.total||0)===total;
    if(last&&(same?now-last.t<6*3600e3:now-last.t<600e3))return;HREC=now;
    var id=new Date(now).toISOString().slice(0,16).replace(/[-:T]/g,'');var doc={t:now,total:total};HK.forEach(function(k){doc[k]=n[k]||0;});
    try{var w=HDB.collection('historial').doc(id).set(doc);if(w&&w.catch)w.catch(function(){});}catch(e){}}
  var HDONE={};
  function grafHtml(n){var S=HIST;var ult=S.length?S[S.length-1]:null;
    var at=function(ms){var r=S[0];for(var i=0;i<S.length;i++){if(S[i].t<=ms)r=S[i];else break;}return r;};
    var sg=function(v){return (v>0?'+':'')+v;};var nums='';
    if(ult){var a24=at(ult.t-86400e3),a7=at(ult.t-7*86400e3);var dias=Math.max((ult.t-a7.t)/86400e3,1/24);var ritmo=(ult.hecho-a7.hecho)/dias;var maxPr=0;S.forEach(function(p){if((p.pr||0)>maxPr)maxPr=p.pr||0;});var d0=new Date(S[0].t);var hd=HITOS.filter(function(q){return q.done_at;}).length;
      nums='<div class="gnums"><div class="gbig"><b>'+sg(ult.hecho-a24.hecho)+'</b><span>hechas en 24 h</span><i>'+(ritmo>=10?Math.round(ritmo):ritmo.toFixed(1))+' al día (7 d)</i></div>'
        +'<div class="gside"><div><b>'+n.pr+'</b> esperando fusión <small>máx. '+maxPr+'</small></div><div><b>'+n.curso+'</b> en marcha ahora</div></div>'
        +'<div class="gfoot"><span><b>'+sg(ult.pend-a24.pend)+'</b> pendientes en 24 h</span><span><b>'+hd+'</b> hitos cumplidos</span><span><b>'+(ult.total-ult.backlog)+'</b> tareas en total</span><span><b>'+S.length+'</b> fotos desde el '+d0.getDate()+'/'+(d0.getMonth()+1)+'</span></div></div>';}
    if(S.length<2)return '<section class="graf"><p class="gnote">Registrando desde hoy: el tablero guarda una foto de los estados cada vez que cambian (como mucho una cada 10 minutos) y, si no cambian, cada 6 horas. Las banderas marcarán cada hito cumplido. El gráfico se irá llenando con los días.</p>'+nums+'</section>';
    var W=680,H=190,L=34,R=44,T=30,B=22;var t0=S[0].t,t1=Math.max(ult.t,t0+3600e3);
    // Tiempo de actividad (VG, 28-10): entre dos fotos solo cuenta el rato si algo cambió (y como mucho media hora); las noches y los
    // ratos sin tocar el tablero no ocupan sitio. Todo el historial cabe siempre en el ancho: se va comprimiendo al crecer.
    var KS=['hecho','pr','curso','pend','backlog','total'];var TA=[0];for(var ti=1;ti<S.length;ti++){var ch=KS.some(function(k){return (S[ti][k]||0)!==(S[ti-1][k]||0);});TA.push(TA[ti-1]+(ch?Math.min(S[ti].t-S[ti-1].t,1800e3):0));}
    var tN=TA[TA.length-1];var lin=!(tN>0);
    var tau=function(t){if(lin)return t-t0;if(t<=S[0].t)return 0;for(var k=1;k<S.length;k++){if(t<=S[k].t){var f=(t-S[k-1].t)/((S[k].t-S[k-1].t)||1);return TA[k-1]+(TA[k]-TA[k-1])*f;}}return tN;};
    var X=function(t){return L+(W-L-R)*tau(t)/(lin?(t1-t0):tN);};
    var flags=HITOS.filter(function(q){return q.done_at&&q.done_at>=t0-1&&q.done_at<=t1+1;}).sort(function(a,b){return a.done_at-b.done_at;});
    // curva suave (Catmull-Rom → Bézier)
    var smooth=function(P){if(P.length<3)return P.map(function(q,i){return (i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1);}).join(' ');var d='M'+P[0][0].toFixed(1)+' '+P[0][1].toFixed(1);for(var i=0;i<P.length-1;i++){var p0=P[i-1]||P[i],p1=P[i],p2=P[i+1],p3=P[i+2]||p2;var c1x=p1[0]+(p2[0]-p0[0])/6,c1y=p1[1]+(p2[1]-p0[1])/6,c2x=p2[0]-(p3[0]-p1[0])/6,c2y=p2[1]-(p3[1]-p1[1])/6;d+=' C'+c1x.toFixed(1)+' '+c1y.toFixed(1)+' '+c2x.toFixed(1)+' '+c2y.toFixed(1)+' '+p2[0].toFixed(1)+' '+p2[1].toFixed(1);}return d;};
    var uid=0;
    var panel=function(keys,title,full){var mx=1;S.forEach(function(p){keys.forEach(function(k){if((p[k[0]]||0)>mx)mx=p[k[0]]||0;});});mx=Math.ceil(mx*1.15)||1;var Y=function(v){return T+(H-T-B)*(1-v/mx);};var y0=Y(0);
      var g='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+title+'"><defs>'+keys.map(function(k){uid++;k.g='gg'+uid;return '<linearGradient id="'+k.g+'" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="'+k[1]+'" stop-opacity=".28"/><stop offset="1" stop-color="'+k[1]+'" stop-opacity="0"/></linearGradient>';}).join('')+'</defs>';
      for(var i=0;i<=4;i++){var v=mx*i/4,y=Y(v);g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y.toFixed(1)+'" y2="'+y.toFixed(1)+'" stroke="currentColor" stroke-opacity="'+(i?'.07':'.22')+'"/><text x="'+(L-6)+'" y="'+(y+3).toFixed(1)+'" text-anchor="end" font-size="9.5" fill="currentColor" opacity=".55">'+Math.round(v)+'</text>';}
      // Fechas en el eje: el primer momento de cada día (o de cada hora si todo es de un día), sin pisarse.
      var oneDay=new Date(t0).toDateString()===new Date(ult.t).toDateString();var lastX=-99,lastKey='';
      S.forEach(function(p){var dd=new Date(p.t);var key=oneDay?dd.getHours():dd.toDateString();if(key===lastKey)return;lastKey=key;var x=X(p.t);if(x-lastX<34)return;lastX=x;
        var lab=oneDay?('0'+dd.getHours()).slice(-2)+':00':dd.getDate()+'/'+(dd.getMonth()+1);g+='<text x="'+x.toFixed(1)+'" y="'+(H-6)+'" text-anchor="middle" font-size="9.5" fill="currentColor" opacity=".55">'+lab+'</text>';});
      keys.forEach(function(k){var P=S.map(function(p){return [X(p.t),Y(p[k[0]]||0)];});var ln=smooth(P);var area=ln+' L'+P[P.length-1][0].toFixed(1)+' '+y0.toFixed(1)+' L'+P[0][0].toFixed(1)+' '+y0.toFixed(1)+' Z';
        g+='<path class="ar" d="'+area+'" fill="url(#'+k.g+')"/><path class="ln" pathLength="1" d="'+ln+'" fill="none" stroke="'+k[1]+'" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"'+(k[3]?' stroke-dasharray=".012 .008"':'')+'/>';});
      // banderas de hitos cumplidos
      flags.forEach(function(q,i){var x=X(q.done_at);var nm=q.nombre.length>22?q.nombre.slice(0,21)+'…':q.nombre;g+='<line class="fl" x1="'+x.toFixed(1)+'" x2="'+x.toFixed(1)+'" y1="'+(full?T-4:T)+'" y2="'+y0.toFixed(1)+'" stroke="currentColor" stroke-opacity=".45" stroke-width="1.2" stroke-dasharray="3 3"/>';
        if(full){var fy=T-6-(i%3)*0;var wdt=nm.length*5.6+22;var fx=Math.min(x+1,W-R-wdt);g+='<g class="flag"><path d="M'+x.toFixed(1)+' '+(fy-20)+'h'+wdt.toFixed(0)+'a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-'+wdt.toFixed(0)+'z" transform="translate('+(fx-x).toFixed(1)+',0)" fill="var(--ink)"/><text x="'+(fx+7).toFixed(1)+'" y="'+(fy-7)+'" font-size="9.5" font-weight="600" fill="var(--bg)">⚑ '+esc(nm)+'</text></g>';}
        else g+='<text x="'+x.toFixed(1)+'" y="'+(T-6)+'" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">⚑</text>';});
      // valor final de cada serie, a la derecha
      var ends=keys.map(function(k){return {k:k,y:Y(ult[k[0]]||0),v:ult[k[0]]||0};}).sort(function(a,b){return a.y-b.y;});for(var j=1;j<ends.length;j++){if(ends[j].y-ends[j-1].y<11)ends[j].y=ends[j-1].y+11;}
      ends.forEach(function(e){g+='<circle cx="'+X(ult.t).toFixed(1)+'" cy="'+Y(e.v).toFixed(1)+'" r="3.5" fill="'+e.k[1]+'" stroke="var(--paper)" stroke-width="1.5"/><text x="'+(W-R+8)+'" y="'+(e.y+3.5).toFixed(1)+'" font-size="11" font-weight="700" fill="'+e.k[1]+'">'+e.v+'</text>';});
      g+='</svg><div class="gleg">'+keys.map(function(k){return '<span><i style="background:'+k[1]+'"></i>'+k[2]+'</span>';}).join('')+(full&&flags.length?'<span><i class="fli"></i>hito cumplido</span>':'')+'</div>';return '<div class="gp"><h3>'+title+'</h3>'+g+'</div>';};
    return '<section class="graf" aria-label="Evolución de los estados">'+nums
      +panel([['pend','#6b6b6b','Por hacer'],['pr','#3a7cc4','Esperando fusión'],['curso','#d19a3a','En marcha'],['backlog','#c0392b','Backlog']],'Trabajo por hacer y en curso, con los hitos cumplidos',true)+'</section>';}
  function rRender(){var v=HOST;
    var meta=RMETA||{};var ags=(meta.agentes||[]).slice();RUTA.forEach(function(x){if(x.agente&&ags.indexOf(x.agente)<0)ags.push(x.agente);});
    var mobile=window.matchMedia('(max-width: 700px)').matches;var vista=CV||(mobile?'tabs':'lado');
    var PRK={urgente:0,importante:1,secundario:2,opcional:3};var prk=function(x){return x.estado==='backlog'?9:(PRK[x.prio]!=null?PRK[x.prio]:5);};
    var hok=function(x){if(!x.hito||!x.hito.id)return 1e9;var ho=0;HITOS.forEach(function(q){if(q.id===x.hito.id)ho=q.orden||0;});return ho*1000+(+x.hito.paso||0);};
    var wfor=function(x){if(!x.hito||!x.hito.id||x.estado==='hecho')return null;var p=+x.hito.paso||0;var w=null;RUTA.forEach(function(y){if(y!==x&&y.hito&&y.hito.id===x.hito.id&&(+y.hito.paso||0)<p&&y.estado!=='hecho'&&y.estado!=='backlog'){if(!w||(+y.hito.paso||0)<(+w.hito.paso||0))w=y;}});return w;};
    var items=RUTA.slice().sort(function(a,b){return (prk(a)-prk(b))||((wfor(a)?1:0)-(wfor(b)?1:0))||(hok(a)-hok(b))||((a.orden||0)-(b.orden||0));});
    var isOpen=function(x){return x.estado!=='hecho';};
    var fAg=ags.some(function(a){return !!CF.ag[a];}),fEst=['hecho','pr','curso','pend','backlog'].some(function(k){return !!CF.est[k];}),fPr=['urgente','importante','secundario','opcional','sin'].some(function(k){return !!CF.pr[k];}),fTi=TIPOS.some(function(t){return !!CF.tipo[t[0]];}),fHi=HITOS.some(function(q){return !!CF.hito[q.id];});var fFl=!!(CF.flag.bloquea||CF.flag.espera);var anyF=fAg||fEst||fPr||fTi||fHi||fFl;
    // claves viejas (estados o hitos que ya no existen) no pueden dejar un filtro encendido sin botón para apagarlo
    (function(){var ok={ag:function(k){return ags.indexOf(k)>=0;},est:function(k){return ['hecho','pr','curso','pend','backlog'].indexOf(k)>=0;},pr:function(k){return ['urgente','importante','secundario','opcional','sin'].indexOf(k)>=0;},tipo:function(k){return TIPOS.some(function(t){return t[0]===k;});},hito:function(k){return HITOS.some(function(q){return q.id===k;});},flag:function(k){return k==='bloquea'||k==='espera';}};var ch=false;for(var g in ok){for(var k in CF[g]){if(!CF[g][k]||(g==='hito'&&!HITOS.length)?false:!ok[g](k)){delete CF[g][k];ch=true;}}}if(ch)cfSave();})();
    var hid=function(x){return x.hito&&x.hito.id?x.hito.id:null;};
    var BLK={};(function(){var byH={};RUTA.forEach(function(y){if(y.hito&&y.hito.id&&y.estado!=='hecho'&&y.estado!=='backlog'){var c=byH[y.hito.id];if(!c||(+y.hito.paso||0)<(+c.hito.paso||0))byH[y.hito.id]=y;}});for(var k in byH)BLK[byH[k].id]=1;})();
    var flagOk=function(x){return (CF.flag.bloquea&&BLK[x.id])||(CF.flag.espera&&!!wfor(x));};
    var pass=function(x){var e=x.estado||'pend';if(fEst&&!CF.est[e])return false;if(fPr&&!CF.pr[x.prio||'sin'])return false;if(fTi&&!CF.tipo[x.tipo||'sin'])return false;if(fHi&&!CF.hito[hid(x)])return false;if(fFl&&!flagOk(x))return false;return true;};
    var shown=items.filter(pass);
    var agsF=ags.filter(function(a){return !fAg||CF.ag[a];});
    var base=anyF?shown.filter(function(x){return !fAg||CF.ag[x.agente];}):items;
    var n={hecho:0,pr:0,curso:0,pend:0,backlog:0};items.forEach(function(x){if(n[x.estado]!=null)n[x.estado]++;else n.pend++;});
    var scope=items.length-n.backlog||1;var gpct=Math.round(100*n.hecho/scope);
    var nVis=base.filter(function(x){return x.estado!=='backlog';}).length;
    recHist(n,items.length);
    var seg;seg=function(c,t){return ['hecho','pr','curso','pend','backlog'].map(function(k){return c[k]?'<i class="s-'+k+'" style="width:'+(100*c[k]/t)+'%"></i>':'';}).join('');}
    var maxN=1;ags.forEach(function(a){var q=items.filter(function(x){return x.agente===a;}).length;if(q>maxN)maxN=q;});
    var EST=[['hecho','#56663f','Hecho','✔'],['pr','#3a7cc4','Fusión','⤴'],['curso','#d19a3a','Activa','◐'],['pend','#9a9a9a','Pendiente','○'],['backlog','#c0392b','Backlog','⛔']];
    var PRL=[['urgente','Urgente','#c0392b'],['importante','Importante','#e3a008'],['secundario','Secundario','#3a7cc4'],['opcional','Opcional','#9a9a9a'],['sin','Ninguna','#56663f']];
    var np={};items.forEach(function(x){var k=x.prio||'sin';np[k]=(np[k]||0)+1;});
    var seg=function(c,t){return EST.map(function(e){return c[e[0]]?'<i class="s-'+e[0]+'" style="width:'+(100*c[e[0]]/t)+'%"></i>':'';}).join('');};
    // Intersección: lo que pasaría cada botón con los demás filtros activos (para atenuar lo que no cruza con nada).
    var passEx=function(x,skip){var e=x.estado||'pend';if(skip!=='est'&&fEst&&!CF.est[e])return false;if(skip!=='pr'&&fPr&&!CF.pr[x.prio||'sin'])return false;if(skip!=='tipo'&&fTi&&!CF.tipo[x.tipo||'sin'])return false;if(skip!=='hito'&&fHi&&!CF.hito[hid(x)])return false;if(skip!=='flag'&&fFl&&!flagOk(x))return false;if(skip!=='ag'&&fAg&&!CF.ag[x.agente])return false;return true;};
    var nE={},nP={},nA={},nT={},nTt={};items.forEach(function(x){var e=x.estado||'pend',k=x.prio||'sin',ti=x.tipo||'sin';nTt[ti]=(nTt[ti]||0)+1;if(passEx(x,'est'))nE[e]=(nE[e]||0)+1;if(passEx(x,'pr'))nP[k]=(nP[k]||0)+1;if(passEx(x,'tipo'))nT[ti]=(nT[ti]||0)+1;if(passEx(x,'ag'))nA[x.agente]=(nA[x.agente]||0)+1;});
    var h='<div class="gprog'+(GOPEN?' open':'')+'" role="button" tabindex="0" aria-expanded="'+GOPEN+'" aria-label="Estado del proyecto; pulsa para ver la evolución"><div class="gl"><b>'+gpct+'%</b><span class="gt">'+n.hecho+' hechas de '+scope+'</span>'+(anyF?'<span class="gf" title="Con los filtros activos">'+nVis+' visibles de '+(scope-n.hecho)+' por hacer de '+scope+'</span>':'')+'<span class="bar gbar">'+seg(n,items.length||1)+'</span><span class="gc">'+EST.map(function(e){return '<em style="color:'+e[1]+'" title="'+e[2]+'">'+e[3]+'<u>'+n[e[0]]+'</u></em>';}).join('')+'</span></div>'
      +'</div>'+(GOPEN?grafHtml(n):'');
    var chip=function(attr,k,color,label,glyph,cnt,tot,on){var num=anyF?cnt+'<span class="de"> de '+tot+'</span>':String(tot);return '<button type="button" class="fc'+(cnt?'':' off')+'" '+attr+'="'+k+'" aria-pressed="'+on+'" style="--c:'+color+'" title="'+label+(anyF?': '+cnt+' con los filtros, '+tot+' en total':'')+'"><span class="g">'+glyph+'</span><strong>'+num+'</strong><small>'+label+'</small></button>';};
    var FILAS=[['Dirección',['Víctor'],'👤'],['Núcleo',['Core','Core Ops','UI-kit'],'⚙️'],['Generales',['Central','Flow'],'🧭'],['Específicas',['Food','Finance','Tasks','Booking'],'🧰'],['Personas',['Guests','Organizers'],'👥']];var CAT={};FILAS.forEach(function(f){f[1].forEach(function(a){CAT[a]=f;});});
    var usados={};var filas=FILAS.map(function(f){return [f[0],f[1].filter(function(a){if(ags.indexOf(a)>=0){usados[a]=1;return true;}return false;})];}).filter(function(f){return f[1].length;});
    var resto=ags.filter(function(a){return !usados[a];});if(resto.length)filas.push(['Otros',resto,'·']);
    var tile=function(a){var m=items.filter(function(x){return x.agente===a;});var c={hecho:0,pr:0,curso:0,pend:0,backlog:0};m.forEach(function(x){if(c[x.estado]!=null)c[x.estado]++;else c.pend++;});var t=(m.length-c.backlog)||1;var pct=Math.round(100*c.hecho/t);
      var tot=m.length||1;var acc=0;var stops=EST.map(function(e){var from=acc;acc+=100*c[e[0]]/tot;return e[1]+' '+from.toFixed(2)+'% '+acc.toFixed(2)+'%';}).join(',');
      var full=m.length>0&&(m.length-c.backlog)>0&&c.hecho===(m.length-c.backlog);
      var cls='circ'+(full?' full':'')+(!(nA[a]||0)?' off':'')+(fAg&&!CF.ag[a]?' dim':'');
      var dH=100*c.hecho/maxN,dT=100*(m.length-c.backlog)/maxN;var H=dH.toFixed(1),T=dT.toFixed(1);var tank='background:'+(c.hecho?'linear-gradient(#56663f,#56663f) 0 calc(100% - '+H+'%)/100% 2px no-repeat,':'')+(dT>dH?'linear-gradient(#d19a3a,#d19a3a) 0 calc(100% - '+T+'%)/100% 2px no-repeat,':'')+'linear-gradient(to top,var(--tk-h) 0 '+H+'%,var(--tk-p) '+H+'% '+T+'%,var(--tk-a) '+T+'% 100%)';
      var cat=CAT[a];
      return '<button type="button" class="'+cls+'" style="'+tank+'" data-sum="'+esc(a)+'" aria-pressed="'+!!CF.ag[a]+'" title="'+(cat?cat[0]+' · ':'')+esc(a)+': '+c.hecho+' hechas, '+c.pr+' esperando fusión, '+c.curso+' en marcha, '+c.pend+' pendientes'+(c.backlog?', '+c.backlog+' en backlog':'')+'">'
        +'<span class="ring" style="background:conic-gradient('+stops+')"><span class="in">'+kico(AGI[a]||'grid',24)+'</span></span>'
        +(cat?'<span class="cat" aria-hidden="true">'+cat[2]+'</span>':'')+'<span class="dt"><span class="nm">'+esc(a)+'</span><b>'+pct+'%</b><small>'+(anyF?(nA[a]||0)+' de '+m.length:'✔'+c.hecho+' ○'+(m.length-c.backlog-c.hecho)+(c.backlog?' ⛔'+c.backlog:''))+'</small></span></button>';};
    h+='<div class="sum" aria-label="Resumen por agente">';
    var ARR=['Dirección','Núcleo','Generales'];var r1=[],r2=[];filas.forEach(function(f){(ARR.indexOf(f[0])>=0?r1:r2).push.apply(ARR.indexOf(f[0])>=0?r1:r2,f[1]);});
    [r1,r2].forEach(function(r){if(r.length)h+='<div class="sr2">'+r.map(tile).join('')+'</div>';});
    h+='</div>';
    h+='<div class="fwrap"><div class="fgrp"><small class="fl">Estado</small><div class="frow" role="group" aria-label="Filtrar por estado">'+EST.map(function(e){return chip('data-est',e[0],e[1],e[2],e[3],nE[e[0]]||0,n[e[0]]||0,!!CF.est[e[0]]);}).join('')+'</div></div>';
    h+='<div class="fgrp"><small class="fl">Urgencia</small><div class="frow" role="group" aria-label="Filtrar por prioridad">'+PRL.map(function(e){return chip('data-pr',e[0],e[2],e[1],PRI[e[0]]||'<i class="st dim">–</i>',nP[e[0]]||0,np[e[0]]||0,!!CF.pr[e[0]]);}).join('')+'</div></div>';
    h+='<div class="fgrp"><small class="fl">Oficio</small><div class="frow" role="group" aria-label="Filtrar por oficio">'+TIPOS.map(function(t){return chip('data-tipo',t[0],t[3],t[1],t[2],nT[t[0]]||0,nTt[t[0]]||0,!!CF.tipo[t[0]]);}).join('')+'</div></div></div>';
    var vis={};shown.forEach(function(x){if(!fAg||CF.ag[x.agente])vis[x.id]=1;});
    // Hitos ordenados por la urgencia de sus pasos sin hacer (el más urgente primero; los completos al final) y numerados; el número no cambia al filtrar.
    var hrk=function(z){var r=99;z.ps.forEach(function(x){if(x.estado!=='hecho'&&x.estado!=='backlog'){var k=prk(x);if(k<r)r=k;}});return r;};
    var hl=HITOS.slice().map(function(q){var ps=items.filter(function(x){return hid(x)===q.id;}).sort(function(a,b){return (a.hito.paso||0)-(b.hito.paso||0);});return {q:q,ps:ps,vis:ps.some(function(x){return vis[x.id];})};}).filter(function(z){return z.ps.length;})
      .sort(function(a,b){return (hrk(a)-hrk(b))||((a.q.orden||0)-(b.q.orden||0));});
    hl.forEach(function(z,i){z.num=i+1;});
    hl.forEach(function(z){var act=z.ps.filter(function(x){return x.estado!=='backlog';});var all=act.length>0&&act.every(function(x){return x.estado==='hecho';});if(!HDB||HDONE[z.q.id])return;var patch=null;if(all&&!z.q.done_at)patch={done_at:Date.now()};else if(!all&&z.q.done_at)patch={done_at:null};if(patch){HDONE[z.q.id]=1;try{var w=HDB.doc('hitos/'+z.q.id).update(patch);if(w&&w.catch)w.catch(function(){});}catch(e){}}});
    hl=hl.filter(function(z){return z.vis||CF.hito[z.q.id];});
    if(hl.length){h+='<section class="hitos" aria-label="Hitos"><h2>Hitos <small>por urgencia y numerados; el número no cambia al filtrar</small></h2>'+(function(){var lb=function(cls,inner,g,k){var on=!!CF[g][k];return '<button type="button" class="hp '+cls+(on?' on':'')+'" data-leg="'+g+':'+k+'" aria-pressed="'+on+'">'+inner+'</button>';};return '<div class="hleg" aria-label="Leyenda y filtros">'+lb('hecho','<i class="ok">✔</i><span>hecho</span>','est','hecho')+lb('curso','<span>en marcha</span>','est','curso')+lb('pr','<span>esperando fusión</span>','est','pr')+lb('pend','<span>pendiente</span>','est','pend')+lb('pend blk','<span>bloquea</span>','flag','bloquea')+lb('pend','<span>⏳ en espera</span>','flag','espera')+lb('pend','<i class="pu">★</i><span>urgente</span>','pr','urgente')+lb('pend yo','<span>tuyo</span>','ag','Víctor')+'<span class="hp pend dim"><span>fuera de los filtros</span></span></div>';})()+'';
      hl.forEach(function(z){var done=z.ps.filter(function(x){return x.estado==='hecho';}).length;var blk=null;z.ps.forEach(function(x){if(!blk&&x.estado!=='hecho'&&x.estado!=='backlog')blk=x;});
        h+='<div class="hito'+(CF.hito[z.q.id]?' on':'')+'"><div class="hrow">'+hfold(z.q.id)+'<button type="button" class="hh" data-hito="'+esc(z.q.id)+'" aria-pressed="'+!!CF.hito[z.q.id]+'"><b><em class="hnum">'+z.num+'</em> '+esc(z.q.nombre)+'</b><span class="bar"><i class="s-hecho" style="width:'+(100*done/z.ps.length)+'%"></i></span><small>'+done+' de '+z.ps.length+(blk?' · bloquea: '+agIco(blk.agente)+esc(blk.agente):' · completo')+'</small></button>';
        h+='</div>'+(HFOLD[z.q.id]?'':'<div class="hs">'+hsteps(z.ps,blk)+'</div>')+'</div>';});
      h+='</section>';}
    h+='<div class="sw" role="group" aria-label="Vista de los carriles"><button type="button" id="cvTabs" aria-pressed="'+(vista==='tabs')+'">Pestañas</button><button type="button" id="cvLado" aria-pressed="'+(vista==='lado')+'">Lado a lado</button><button type="button" id="cvHitos" aria-pressed="'+(vista==='hitos')+'">Por hitos</button><button type="button" id="cvApp" aria-pressed="'+(vista==='app')+'">Por app</button></div>';
    if(vista==='hitos'){
    // Por hitos: lo que no tiene hito va en «Sin hito», que se pliega y filtra igual.
    var sinH=items.filter(function(x){return !hid(x);}).sort(function(a,b){return ((isOpen(a)?0:1)-(isOpen(b)?0:1))||(prk(a)-prk(b))||((a.orden||0)-(b.orden||0));});
    var sinV=sinH.some(function(x){return vis[x.id];});
    if(sinV){var sd=sinH.filter(function(x){return x.estado==='hecho';}).length;
      h+='<section class="hitos sinhito" aria-label="Sin hito"><div class="hito"><div class="hrow">'+hfold('_sin')+'<div class="hh"><b>Sin hito</b><span class="bar"><i class="s-hecho" style="width:'+(100*sd/sinH.length)+'%"></i></span><small>'+sd+' de '+sinH.length+'</small></div></div>'+(HFOLD._sin?'':'<div class="hs">'+hsteps(sinH,null)+'</div>')+'</div></section>';}
    if(!hl.length&&!sinV)h+='<div class="vacio" style="padding:12px">Nada coincide con los filtros.</div>';
    } else {
    // Por app (VG, 28-10): cada tarjeta, en el carril de cada aplicación en la que se hace; las tuyas sin aplicación, en el tuyo.
    var inL=function(x,a){return vista==='app'?(x.apps&&x.apps.length?x.apps:[x.agente]).indexOf(a)>=0:x.agente===a;};
    var sel=agsF.indexOf(CSEL)>=0?CSEL:(agsF[0]||'');
    var busy=agsF.filter(function(a){return shown.some(function(x){return inL(x,a)&&(anyF||isOpen(x));});});
    if(anyF)busy=busy.filter(function(a){return shown.some(function(x){return inL(x,a);});});
    var idle=anyF?[]:agsF.filter(function(a){return busy.indexOf(a)<0;});
    h+='<div class="lanes'+(vista==='tabs'?' one':'')+'">';
    if(!busy.length)h+='<div class="vacio" style="padding:12px">Nada coincide con los filtros.</div>';
    busy.forEach(function(a){if(!a)return;var mine=shown.filter(function(x){return inL(x,a);});var open=mine.filter(isOpen);var done=mine.filter(function(x){return !isOpen(x);});
      h+='<section class="lane" aria-label="'+esc(a)+'"><h2><span>'+agIco(a)+esc(a)+'</span><small>'+open.filter(function(x){return x.estado!=='backlog';}).length+' por hacer</small></h2><div class="ls">';
      if(!open.length&&!done.length)h+='<div class="vacio">Nada.</div>';
      // Con filtros, las bloqueadas por un paso anterior de su hito van aparte, plegadas, con quién las bloquea (VG, 27-10 noche).
      // Solo se pliega si quien bloquea es un agente que NO está en el filtro de agentes (VG, 27-10 noche): si te bloqueas tú o alguien
      // seleccionado, la tarjeta sale en su sitio con su «en espera».
      // Se pliega si el paso que la bloquea no pasa TODOS los filtros activos (agentes, estado, urgencia, oficio, hito, leyenda); VG, 27-10 noche.
      var outside=function(x){var w=wfor(x);return !!w&&anyF&&!(pass(w)&&(!fAg||CF.ag[w.agente]));};
      // Las bloqueadas se cuentan sobre todas las abiertas del carril (pasen o no el filtro): cuanto más estrecho el filtro, más cosas esperan a alguien de fuera.
      var allOpen=items.filter(function(x){return inL(x,a)&&isOpen(x);});
      var ready=open.filter(function(x){return !outside(x);}), wait=anyF?allOpen.filter(outside):[];
      ready.forEach(function(x){h+=item(x,null,false,null,a);});
      if(wait.length){h+='<details class="wait" data-wait="'+esc(a)+'"'+(WOPEN[a]?' open':'')+'><summary>⏳ '+wait.length+' bloqueada'+(wait.length>1?'s':'')+' por pasos fuera del filtro</summary>';wait.forEach(function(x){var w=wfor(x);h+='<div class="wby">bloqueada por: paso '+esc(String(w.hito.paso||''))+' · '+agIco(w.agente)+esc(w.agente)+' · '+esc(w.nombre.length>60?w.nombre.slice(0,58)+'…':w.nombre)+'</div>'+item(x);});h+='</details>';}
      done.forEach(function(x){h+=item(x,null,false,null,a);});
      h+='</div></section>';});
    if(vista!=='tabs'&&idle.length){h+='<section class="lane mini" aria-label="Agentes sin tareas"><h2>Sin tareas</h2><div class="ls">';idle.forEach(function(a){h+='<button type="button" data-idle="'+esc(a)+'">'+esc(a)+'</button>';});h+='</div></section>';}
    h+='</div>';
    }
    function hfold(id){var f=!!HFOLD[id];return '<button type="button" class="hfold" data-hfold="'+esc(id)+'" aria-expanded="'+!f+'" aria-label="'+(f?'Desplegar':'Plegar')+' el hito">'+(f?'▸':'▾')+'</button>';}
    // Icono del paso: el de su tipo de actividad (VG, 28-10); sin tipo, el del agente.
    function tico(x){return x.tipo&&TIPO[x.tipo]?'<i class="ti" style="--c:'+TIPO[x.tipo][3]+'" aria-label="'+TIPO[x.tipo][1]+'">'+TIPO[x.tipo][2]+'</i>':agIco(x.agente);}
    function hsteps(ps,blk){var out='',hn=0;var flush=function(){if(hn){out+='<span class="hp hid" title="Ocultas por los filtros: quita alguno para verlas">+'+hn+' oculta'+(hn>1?'s':'')+'</span>';hn=0;}};
      ps.forEach(function(x,i){if(!vis[x.id]){if(x.estado!=='hecho')hn++;return;}flush();out+=hstep(x,i,blk);});flush();return out;}
    // Un toque despliega la tarjeta; si es tuya, otro la abre del todo (pasos y estados) y el tercero la recoge. Las de otros: dos toques.
    function hstep(x,i,blk){var st=HX[x.id]||0;var mine=MINE.indexOf(x.agente)>=0;
      if(st>0)return item(x,mine?st===2:true,!mine,'data-hx');
      var isB=blk&&blk.id===x.id;var cls='hp '+esc(x.estado||'pend')+(isB?' blk':'')+(mine?' yo':'');
      return '<button type="button" class="'+cls+'" data-hx="'+esc(x.id)+'" aria-expanded="false" title="'+esc(x.agente+' · '+x.nombre+(isB?' · bloquea el hito':''))+'"><em>'+esc(String((x.hito&&x.hito.paso)||i+1))+'</em>'+tico(x)+(x.estado==='hecho'?'<i class="ok" aria-label="hecho">✔</i>':'')+(x.prio==='urgente'?'<i class="pu" aria-label="urgente">★</i>':'')+'<span>'+esc(x.nombre)+'</span>'+(isB?'<small class="bk">bloquea</small>':'')+'</button>';}
    v.innerHTML=h;
    (function(){var sw=v.querySelector('.sw'),sl=SW_SLOT;if(sw&&sl){sl.innerHTML='';sl.appendChild(sw);}})();
    function item(x,fo,noActs,attr,lane){var steps=Array.isArray(x.pasos)&&x.pasos.length;var open=fo!=null?fo:!!COPEN[x.id];var cls='it '+esc(x.estado||'pend')+' tap'+(x.recurrente?' rec':'');
      var PR={urgente:'Urgente',importante:'Importante',secundario:'Secundario',opcional:'Opcional'};
      var inner='<button type="button" class="cid" data-cid="'+esc(x.id)+'" title="Copiar el código de la tarjeta">'+esc(x.id)+'</button>'+(x.tipo&&TIPO[x.tipo]?'<span class="tipo" style="--c:'+TIPO[x.tipo][3]+'" title="'+TIPO[x.tipo][1]+'">'+TIPO[x.tipo][2]+' '+TIPO[x.tipo][1]+'</span>':'')+(x.prio&&PR[x.prio]?'<span class="prio p-'+esc(x.prio)+'">'+PRI[x.prio]+PR[x.prio]+'</span>':'')+'<b>'+(x.recurrente?'⟳ ':'')+esc(x.nombre)+'</b>'+((x.nota||x.ref)?'<div class="n">'+esc(x.nota||'')+(x.ref?(x.nota?' · ':'')+esc(x.ref):'')+'</div>':'')+(x.url&&/^https:\/\//.test(x.url)?'<div class="n"><a href="'+esc(x.url)+'" target="_blank" rel="noopener">'+esc(x.urlTexto||'Abrir')+' ↗</a></div>':'');
      if(x.hito&&x.hito.id){var hh=null;HITOS.forEach(function(q){if(q.id===x.hito.id)hh=q;});var w=wfor(x);if(hh)inner+='<div class="n hn'+(w?' wt':'')+'">⛳ '+esc(hh.nombre)+' · paso '+esc(String(x.hito.paso||''))+(w?' · <b>⏳ en espera</b> del paso '+esc(String(w.hito.paso||''))+' ('+esc(w.agente)+')':'')+'</div>';}
      if(vista==='app'&&lane){var otras=(x.apps||[]).filter(function(n){return n!==lane;});var ajena=lane!==x.agente;if(ajena||otras.length)inner+='<div class="n tb">'+(ajena?'👤 '+esc(x.agente):'')+(ajena&&otras.length?' · ':'')+(otras.length?'también en '+esc(otras.join(', ')):'')+'</div>';}
      if(steps){inner+=open?'<ol class="pasos">'+x.pasos.map(function(p){return '<li>'+esc(p)+'</li>';}).join('')+'</ol>':'<div class="hint">Toca para ver los pasos</div>';}
      if(open&&CAN_EDIT&&!x.recurrente&&!noActs&&MINE.indexOf(x.agente)>=0)inner+='<div class="acts"><button type="button" class="act" data-apps="'+esc(x.uid)+'">Aplicaciones'+(x.appsManual?' (a mano)':'')+'…</button></div>';
      if(open&&CAN_EDIT&&!x.recurrente&&!noActs){inner+='<div class="acts">'+[['pend','Pendiente'],['curso','En curso'],['hecho','Hecha']].map(function(s){return '<button type="button" class="act'+(x.estado===s[0]?' on':'')+'" data-state="'+s[0]+'" data-card="'+esc(x.uid)+'" aria-pressed="'+(x.estado===s[0])+'">'+s[1]+'</button>';}).join('')+'</div>';}
      return '<div class="'+cls+'" role="button" tabindex="0" aria-expanded="'+open+'" '+(attr||'data-item')+'="'+esc(x.id)+'"><span class="dot" aria-hidden="true"></span><div>'+inner+'</div></div>';}
    SW_SLOT.querySelector('#cvApp').onclick=function(){CV='app';try{localStorage.setItem('avance-car-vista',CV);}catch(e){}rRender();};
    v.querySelectorAll('[data-apps]').forEach(function(b){b.onclick=function(e){e.stopPropagation();ON_APPS(b.getAttribute('data-apps'));};});
    SW_SLOT.querySelector('#cvHitos').onclick=function(){CV='hitos';try{localStorage.setItem('avance-car-vista',CV);}catch(e){}rRender();};
    v.querySelectorAll('[data-hfold]').forEach(function(b){b.onclick=function(){var id=b.getAttribute('data-hfold');HFOLD[id]=!HFOLD[id];try{localStorage.setItem('avance-hitos-plegados',JSON.stringify(HFOLD));}catch(e){}rRender();};});
    v.querySelectorAll('[data-hx]').forEach(function(b){var f=function(){var id=b.getAttribute('data-hx');var x=null;items.forEach(function(y){if(y.id===id)x=y;});var mine=!!x&&MINE.indexOf(x.agente)>=0;var st=HX[id]||0;HX[id]=mine?(st+1)%3:(st?0:1);rRender();};b.onclick=f;if(b.tagName!=='BUTTON')b.onkeydown=function(e){if(e.target===b&&(e.key==='Enter'||e.key===' ')){e.preventDefault();f();}};});
    v.querySelectorAll('.hs .it a').forEach(function(a){a.onclick=function(e){e.stopPropagation();};});
    SW_SLOT.querySelector('#cvTabs').onclick=function(){CV='tabs';try{localStorage.setItem('avance-car-vista',CV);}catch(e){}rRender();};
    SW_SLOT.querySelector('#cvLado').onclick=function(){CV='lado';try{localStorage.setItem('avance-car-vista',CV);}catch(e){}rRender();};
    function pick(a){CSEL=a;try{localStorage.setItem('avance-car-sel',CSEL);}catch(e){}CV='tabs';try{localStorage.setItem('avance-car-vista',CV);}catch(e){}rRender();}
    v.querySelectorAll('[data-ag]').forEach(function(b){b.onclick=function(){CSEL=b.getAttribute('data-ag');try{localStorage.setItem('avance-car-sel',CSEL);}catch(e){}rRender();};});
    v.querySelectorAll('[data-sum]').forEach(function(b){b.onclick=function(){cfToggle('ag',b.getAttribute('data-sum'));};});
    var gpb=v.querySelector('.gprog');if(gpb){var tg=function(){GOPEN=!GOPEN;try{localStorage.setItem('avance-graf',GOPEN?'1':'0');}catch(e){}rRender();};gpb.onclick=tg;gpb.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();tg();}};}
    v.querySelectorAll('[data-est]').forEach(function(b){b.onclick=function(){cfToggle('est',b.getAttribute('data-est'));};});
    v.querySelectorAll('[data-pr]').forEach(function(b){b.onclick=function(){cfToggle('pr',b.getAttribute('data-pr'));};});
    v.querySelectorAll('[data-tipo]').forEach(function(b){b.onclick=function(){cfToggle('tipo',b.getAttribute('data-tipo'));};});
    v.querySelectorAll('[data-hito]').forEach(function(b){b.onclick=function(){cfToggle('hito',b.getAttribute('data-hito'));};});
    v.querySelectorAll('[data-leg]').forEach(function(b){b.onclick=function(){var gk=b.getAttribute('data-leg').split(':');cfToggle(gk[0],gk[1]);};});
    // El apartado de bloqueadas recuerda si está abierto aunque se repinte el carril (VG, 28-10).
    v.querySelectorAll('details.wait').forEach(function(d){d.addEventListener('toggle',function(){WOPEN[d.getAttribute('data-wait')]=d.open;});});
    // Código de la tarjeta: un toque lo copia (VG, 28-10), sin abrir ni cerrar la tarjeta.
    v.querySelectorAll('[data-cid]').forEach(function(b){b.onclick=function(e){e.stopPropagation();var id=b.getAttribute('data-cid');var ok=function(){b.textContent='copiado ✓';b.classList.add('ok');setTimeout(function(){b.textContent=id;b.classList.remove('ok');},900);};try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(id).then(ok,function(){window.getSelection().selectAllChildren(b);});}else{window.getSelection().selectAllChildren(b);}}catch(err){}};});
    v.querySelectorAll('[data-clear]').forEach(function(b){b.onclick=function(){CF={ag:{},est:{},pr:{},tipo:{},hito:{},flag:{}};cfSave();rRender();};});
    v.querySelectorAll('[data-idle]').forEach(function(b){b.onclick=function(){pick(b.getAttribute('data-idle'));};});
    v.querySelectorAll('[data-more]').forEach(function(b){b.onclick=function(){CMORE[b.getAttribute('data-more')]=true;rRender();};});
    v.querySelectorAll('[data-less]').forEach(function(b){b.onclick=function(){CMORE[b.getAttribute('data-less')]=false;rRender();};});
    v.querySelectorAll('[data-state]').forEach(function(b){b.onclick=function(e){e.stopPropagation();ON_STATE(b.getAttribute('data-card'),b.getAttribute('data-state'));};});
    v.querySelectorAll('[data-item]').forEach(function(b){var f=function(){var id=b.getAttribute('data-item');COPEN[id]=!COPEN[id];rRender();};b.onclick=f;b.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();f();}};});}
  return {
    setData(ruta, hitos, hist, agentes) { RUTA = ruta; HITOS = hitos; HIST = hist; RMETA = { agentes }; horaAhora(); rRender(); },
  };
}
