/* Tema claro/oscuro con un solo botón sol/luna en la cabecera del menú. Sin elegir nada, sigue al sistema.
   También reordena el menú: Etiquetas pasa a Trabajo y desaparece el grupo Organización (las áreas se editan desde la barra de áreas). */
const THEME_KEY='ikisai-theme';
const themeMedia=matchMedia('(prefers-color-scheme: dark)');
Object.assign(menuPaths,{
  sun:'M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6l1.4 1.4 M17 17l1.4 1.4 M5.6 18.4l1.4-1.4 M17 7l1.4-1.4 M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
  moon:'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z'
});
function themePreference(){try{const v=localStorage.getItem(THEME_KEY);return ['light','dark'].includes(v)?v:'system'}catch(e){return 'system'}}
function isDarkTheme(){const pref=themePreference();return pref==='dark'||pref==='system'&&themeMedia.matches}
function applyTheme(){const dark=isDarkTheme();document.documentElement.classList.toggle('dark',dark);document.documentElement.dataset.theme=themePreference();document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#1b1e19':'#46513b');document.querySelectorAll('#themeToggle').forEach(drawThemeToggle)}
function setTheme(pref){try{if(pref==='system')localStorage.removeItem(THEME_KEY);else localStorage.setItem(THEME_KEY,pref)}catch(e){}applyTheme()}
function toggleTheme(){setTheme(isDarkTheme()?'light':'dark')}
function drawThemeToggle(button){const dark=isDarkTheme();button.innerHTML=menuIcon(dark?'sun':'moon');button.setAttribute('aria-label',dark?'Cambiar a tema claro':'Cambiar a tema oscuro');button.dataset.tip=dark?'Tema claro':'Tema oscuro';button.classList.toggle('dark',dark)}
function themeToggleButton(){const dark=isDarkTheme();return `<button type="button" class="iconbtn themetoggle ${dark?'dark':''}" id="themeToggle" aria-label="${dark?'Cambiar a tema claro':'Cambiar a tema oscuro'}" data-tip="${dark?'Tema claro':'Tema oscuro'}">${menuIcon(dark?'sun':'moon')}</button>`}
themeMedia.addEventListener('change',applyTheme);applyTheme();
const groupsBeforeTheme=navigationGroups;
navigationGroups=function(){const groups=groupsBeforeTheme(),work=groups.find(g=>g.id==='work'),organize=groups.find(g=>g.id==='organize');if(organize)organize.items=organize.items.filter(i=>i[0]!=='areas');if(work){const at=work.items.findIndex(i=>i[0]==='tasks');work.items.splice(at+1,0,['labels','Etiquetas','tag','view']);work.items.push(['areas','Áreas de trabajo','areas'])}return groups};
const bindBeforeTheme=bind;
bind=function(){bindBeforeTheme();document.querySelectorAll('#themeToggle').forEach(b=>b.onclick=toggleTheme)};
// Sin conexión, el primer pintado desde IndexedDB puede adelantarse a la carga de estos módulos: al terminar de cargar, se repinta una vez.
if(document.getElementById('app')?.childElementCount&&typeof render==='function')setTimeout(()=>{try{render()}catch(e){}},0);
// Un re-render por sincronización no debe cerrar el menú que el usuario tiene abierto.
const renderBeforeTheme=render;
render=function(){const open=document.getElementById('kebab')?.classList.contains('show');const result=renderBeforeTheme();if(open){document.getElementById('kebab')?.classList.add('show');document.getElementById('menuBackdrop')?.classList.add('show');document.getElementById('moreBtn')?.setAttribute('aria-expanded','true')}return result};
