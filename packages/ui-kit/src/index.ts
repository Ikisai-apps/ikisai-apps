/**
 * @ikisai/ui-kit · componentes base de Ikisai sin framework.
 * Estilos: importa `@ikisai/ui-kit/ui-kit.css` (o `tokens.css` + `base.css` + `components.css`) una vez por app
 * y sirve las fuentes de `@ikisai/ui-kit/fonts/` en `/fonts/`.
 */
export { el, append, clear, replace, formatDate, plural, type Attrs, type Child } from './dom.ts';
export { icon, registerIcons, hasIcon, type IconName } from './icons.ts';
export { applyTheme, setTheme, toggleTheme, themePreference, effectiveTheme, inkOn, itemColorStyle, applyAccent, type ThemePreference } from './theme.ts';
export { toast, toastWithAction, hideToast, type ToastAction } from './toast.ts';
export {
  createStatusBar,
  statusBanners,
  statusSummary,
  statusShort,
  networkLabel,
  pendingLabel,
  pendingCount,
  conflictsLabel,
  type StatusBar,
  type StatusBarOptions,
  type StatusBannersOptions,
} from './status/status-bar.ts';
export { renderLogin, type LoginOptions } from './shell/login.ts';
export { createAppShell, type AppShell, type AppShellOptions, type NavItem } from './shell/app-shell.ts';
