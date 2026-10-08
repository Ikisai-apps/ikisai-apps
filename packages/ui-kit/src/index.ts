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
  rejectedLabel,
  isUserChanged,
  type StatusBar,
  type StatusBarOptions,
  type StatusBannersOptions,
} from './status/status-bar.ts';
export { renderLogin, type LoginOptions } from './shell/login.ts';
export * from './feedback/index.ts';
export * from './usage/index.ts';
export * from './i18n/index.ts';
export { createAppLauncher, type AppLauncher, type AppLauncherOptions, type LauncherApp, type LauncherCatalog } from './shell/launcher.ts';
export { createAppShell, type AppShell, type AppShellOptions, type NavItem } from './shell/app-shell.ts';
export { renderWorkspaceBar, renderAreaTabs, renderStripTool, renderQuickViews, renderNavMenu, renderNavBackdrop, renderTabBar, type WorkspaceBarOptions, type AreaTab, type AreaTabsOptions, type QuickView, type NavMenuItem, type NavMenuGroup, type NavMenuOptions, type TabBarItem, type HookAttrs, type IconLike } from './shell/workspace.ts';
export { openSheet, closeSheet, currentSheet, type Sheet, type SheetOptions } from './overlay/sheet.ts';
export { confirmDialog, alertDialog, type DialogOptions } from './overlay/dialog.ts';
export { trapFocus, focusFirst, focusables, lockScroll } from './overlay/focus.ts';
export { renderConflict, renderConflicts, CONFLICT_MARKS, SYSTEM_COLUMNS, type ConflictDecision, type ConflictOptions } from './sync/conflict.ts';
export { renderRejected, renderRejectedList, type RejectedOptions } from './sync/rejected.ts';
export { listRow, renderList, type ListRowSpec, type ListSpec, type ListOptions } from './list.ts';
export { createThemeToggle, createThemeSelect } from './theme-switch.ts';
export { compressImage, compressedFilename, isImageFile, supportsWebp, type CompressImageOptions, type CompressedImage } from './media/compress-image.ts';
export { createCalendar, toDayKey, fromDayKey, addDays, todayKey, startOfWeek, startOfMonth, daysBetween, type Calendar, type CalendarEvent, type CalendarOptions, type CalendarView, type DayKey } from './calendar/calendar.ts';
export { createQuantityField, parseQuantity, formatQuantity, type QuantityField, type QuantityFieldOptions, type QuantityUnit, type QuantityValue } from './fields/quantity.ts';
export { openImportSheet, createJsonSource, renderImportHeader, renderImportLines, renderImportTaxes, renderImportReconciliation, renderSchemaErrors, formatMoney, TAX_TYPE_LABELS, type ImportPreviewDocument, type ImportPreviewRecalc, type ImportParseResult, type ImportSheetOptions, type ImportSheet, type JsonSource, type SchemaErrorLike } from './import/import-preview.ts';
export { renderPrintPage, createPrintView, printElement, type PrintPageSpec, type PrintSection, type PrintGroup, type PrintItem, type PrintChip, type PrintView, type PrintViewOptions } from './print/print-page.ts';
export { createSortableList, positionBetween, renumber, type Sortable, type SortableOptions } from './sortable.ts';
export { createDateField, relativeDayLabel, longDayLabel, DEFAULT_SHORTCUTS, type DateField, type DateFieldOptions, type DateShortcut } from './fields/date.ts';
export { createDayTabs, type DayTabs, type DayTabsOptions } from './calendar/day-tabs.ts';
export { createSaveState, type SaveState, type SaveStateOptions, type SaveField, type SaveStatus } from './fields/save-state.ts';
export { createSignaturePad, type SignaturePad, type SignaturePadOptions } from './fields/signature.ts';
export { createInstallPrompt, isAppInstalled, installPlatform, type InstallPrompt, type InstallPromptOptions, type InstallPlatform } from './shell/install.ts';
export { createColorField, createColorField as createColorPicker, hexToHsv, hsvToHex, normalizeHex, type ColorField, type ColorFieldOptions, type Hsv } from './fields/color.ts';
export { createLabelPicker, labelChips, type LabelPicker, type LabelPickerOptions, type LabelFamily, type LabelItem } from './fields/labels.ts';
export { renderProjectCard, ringSvg, type ProjectCardSpec } from './cards/project-card.ts';
export {
  openProposalReview, renderProposalReview, renderSecretOnce, renderRiskSummary, renderProposalRow, renderChangeList, renderAccessLog, createScopePicker,
  proposalStatusChip, relativeTime, maskSecret, PROPOSAL_STATUS_LABELS,
  type ProposalStatus, type ProposalSummary, type ProposalRowOptions, type ProposalReviewOptions, type ProposalReviewParts, type RiskReason, type RiskSummaryOptions,
  type ChangeItem, type ChangeField, type ChangeListOptions, type SecretOnceOptions, type AccessLogEntry, type ScopeArea, type ScopeValue, type ScopePicker,
} from './agents/agents.ts';
export { renderMoneyBreakdown, type MoneyBreakdownSpec, type MoneyLine } from './cards/money.ts';
export { createCommandPalette, filterPaletteItems, foldText, type CommandPalette, type PaletteItem, type PaletteOptions } from './palette.ts';
