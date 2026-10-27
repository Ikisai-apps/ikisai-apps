/**
 * @ikisai/ui-kit · componentes base de Ikisai sin framework.
 * Estilos: importa `@ikisai/ui-kit/ui-kit.css` (o `tokens.css` + `base.css` + `components.css`) una vez por app
 * y sirve las fuentes de `@ikisai/ui-kit/fonts/` en `/fonts/`.
 */
export { el, append, clear, replace, formatDate, plural, type Attrs, type Child } from './dom.ts';
export { icon, registerIcons, hasIcon, type IconName } from './icons.ts';
export { applyTheme, setTheme, toggleTheme, themePreference, effectiveTheme, inkOn, readableColor, itemColorStyle, applyAccent, type ThemePreference } from './theme.ts';
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
export { readReturnTo, currentReturnTo, clearReturnTo, withReturnTo, type ReturnTo } from './shell/return-to.ts';
export { createAppMenu, syncLine, type AppMenu, type AppMenuOptions, type AppMenuRow, type AppMenuSection } from './shell/app-menu.ts';
export { renderWorkspaceBar, renderAreaTabs, renderStripTool, renderQuickViews, renderNavMenu, renderNavBackdrop, renderTabBar, bindTabBarAutoHide, type TabBarStandalone, type WorkspaceBarOptions, type AreaTab, type AreaTabsOptions, type QuickView, type NavMenuItem, type NavMenuGroup, type NavMenuOptions, type TabBarItem, type HookAttrs, type IconLike } from './shell/workspace.ts';
export { openSheet, closeSheet, currentSheet, type Sheet, type SheetOptions } from './overlay/sheet.ts';
export { confirmDialog, alertDialog, type DialogOptions } from './overlay/dialog.ts';
export { trapFocus, focusFirst, focusables, lockScroll } from './overlay/focus.ts';
export { renderConflict, renderConflicts, sameValue, conflictIntro, conflictRowName, conflictAuthor, CONFLICT_MARKS, SYSTEM_COLUMNS, type ConflictDecision, type ConflictOptions } from './sync/conflict.ts';
export { renderRejected, renderRejectedList, type RejectedOptions } from './sync/rejected.ts';
export { listRow, renderList, type ListRowSpec, type ListSpec, type ListOptions } from './list.ts';
export { createThemeToggle, createThemeSelect } from './theme-switch.ts';
export { compressImage, compressedFilename, isImageFile, supportsWebp, type CompressImageOptions, type CompressedImage } from './media/compress-image.ts';
export { createCalendar, toDayKey, fromDayKey, addDays, todayKey, startOfWeek, startOfMonth, daysBetween, type Calendar, type CalendarEvent, type CalendarOptions, type CalendarView, type DayKey, type CalendarLayer, type CalendarNote, type CalendarDayInfo, type CalendarRange, type CalendarSelectOptions, CALENDAR_MARKS } from './calendar/calendar.ts';
export { createProposalList, suggestionStatusChip, normalizeProposal, PROPOSAL_LIST_MARKS, type ProposalItem, type ProposalInput, type LegacyProposalItem, type ProposalList, type ProposalListOptions, type ProposalSource, type SuggestionStatus } from './proposals/list.ts';
export { createSuggestionSource, proposalFromSuggestion, changesFromPreview, suggestionErrorMessage, type SuggestionSource, type SuggestionSourceOptions } from './proposals/suggestion-source.ts';
export { createQuantityField, parseQuantity, formatQuantity, type QuantityField, type QuantityFieldOptions, type QuantityUnit, type QuantityValue } from './fields/quantity.ts';
export { openImportSheet, createJsonSource, renderImportHeader, renderImportLines, renderImportTaxes, renderImportReconciliation, renderSchemaErrors, formatMoney, TAX_TYPE_LABELS, type ImportPreviewDocument, type ImportPreviewRecalc, type ImportParseResult, type ImportSheetOptions, type ImportSheet, type JsonSource, type SchemaErrorLike } from './import/import-preview.ts';
export { renderPrintPage, createPrintView, printElement, type PrintPageSpec, type PrintSection, type PrintGroup, type PrintItem, type PrintChip, type PrintView, type PrintViewOptions } from './print/print-page.ts';
export { renderQr, type QrOptions } from './print/qr.ts';
export { createSortableList, positionBetween, renumber, type Sortable, type SortableOptions } from './sortable.ts';
export { deadlineText, deadlineInfo, type DeadlineInfo, type DeadlineOptions } from './fields/deadline.ts';
export { renderMedal, initialsOf, type MedalOptions } from './pieces/medal.ts';
export { renderStages, stageStates, type Stage, type StageState, type StagesOptions } from './pieces/stages.ts';
export { renderGroups, worstOf, type Group, type GroupsOptions, type GroupsView, type Tone } from './pieces/groups.ts';
export { renderStats, type Stat } from './pieces/stats.ts';
export { renderChecks, type CheckItem, type ChecksOptions } from './pieces/checks.ts';
export { renderTile, bindLongPress, type TileOptions, type TileAction } from './pieces/tile.ts';
export { createShelves, type Shelves, type ShelvesOptions, type ShelfRow } from './pieces/shelves.ts';
export { Envase, type PackPlan, type PackPlanInput, type PackFormat, type PackFormatInput, type PackKind, type PackSaved, type PackSheetOptions, type PackTicket, type PackDrawOptions, type PackTextOptions } from './pieces/envase.ts';
export { bindOnline, renderOfflineReason, type OnlineOptions } from './pieces/online.ts';
export { renderCover, createFocus, createCoverCarousel, type CoverOptions, type FocusItem, type FocusOptions, type Focus, type CoverSlide, type CoverCarouselOptions, type CoverCarousel } from './pieces/cover.ts';
export { renderLead, type LeadItem, type LeadOptions } from './pieces/lead.ts';
export { renderNow, type NowBlock, type NowRow, type NowOptions } from './pieces/now.ts';
export { renderSteps, type StepItem, type StepsOptions } from './pieces/steps.ts';
export { createQueue, type Queue, type QueueItem, type QueueAction, type QueueOptions } from './pieces/queue.ts';
export { createVoteDeck, type Vote, type VoteDeck, type VoteDeckOptions, type VoteTexts } from './pieces/vote.ts';
export { renderTimeline, timelineWindow, timelineSpan, type TimelineItem, type TimelineLane, type TimelineOptions } from './pieces/timeline.ts';
export { renderTray, renderTrayRow, type TrayAction, type TrayRow, type TrayGroup, type TrayOptions } from './pieces/tray.ts';
export { renderHourAgenda, type HourItem, type HourAgendaOptions } from './pieces/hours.ts';
export { ANCHOR_ID, announceSaved, findAnchor, onSaved, pointAt, registerReveal, revealAnchor, waitForAnchor } from './guide/anchors.ts';
export { clearGuideLink, currentGuideLink, readGuideLink, withGuideLink, type GuideLink } from './guide/link.ts';
export { createFieldPointer, type FieldPointer } from './guide/point.ts';
export { createGuide, type Guide, type GuideConfirm, type GuideOptions, type GuideRun, type GuideStep } from './guide/guide.ts';
export { groupLanes, LANE_NONE, type GroupLanesOptions } from './pieces/lanes-group.ts';
export { createLanes, type Lane, type Lanes, type LanesOptions, type LanesView } from './pieces/lanes.ts';
export { createStepForm, StepFormInvalid, type StepForm, type StepFormOptions, type StepQuestion, type StepRenderContext } from './pieces/step-form.ts';
export { createFreeForm, freeFormProblems, type FreeForm, type FreeFormAnswer, type FreeFormAnswers, type FreeFormKind, type FreeFormOptions, type FreeFormQuestion, type FreeFormSchema } from './pieces/free-form.ts';
export { checklistSummary, createChecklist, type Checklist, type ChecklistChecked, type ChecklistItem, type ChecklistOptions, type ChecklistSummary } from './pieces/checklist.ts';
export { createDateField, relativeDayLabel, longDayLabel, DEFAULT_SHORTCUTS, type DateField, type DateFieldOptions, type DateShortcut } from './fields/date.ts';
export { setKitLayer, kitLayer } from './layer.ts';
export { installBackNavigation, trackOverlay, type BackNavigationOptions, type OverlayHandle } from './shell/back-navigation.ts';
export { initAppUpdates, shouldAutoApply, type AppUpdates, type AppUpdatesOptions } from './sync/updates.ts';
export { installKeyboardInsets } from './overlay/keyboard.ts';
export { createDayTabs, type DayTabs, type DayTabsOptions } from './calendar/day-tabs.ts';
export {
  DEFAULT_SPACE_KINDS, canPlace, kindsFor, kindOf, kindLabel, spacePath, spaceShortPath, spaceDescendants, ancestorsOf, childrenOf, indexSpaces, spaceMatches,
  nextAltura, newSpaceId, createMemorySpaceSource, demoSpaces, spaceSeats, seatsLabel,
  type SpaceRow, type SpaceKind, type SpaceAttribute, type SpaceSource, type Placement,
} from './spaces/model.ts';
export { createSpaceTree, SPACE_TREE_MARKS, type SpaceTree, type SpaceTreeOptions, type SpaceRowAction } from './spaces/tree.ts';
export { createSyncSpaceSource, spaceFromRow, spaceToFields, kindFromRow, floorPlanFromRow, type SyncSpaceSourceOptions } from './spaces/sync-source.ts';
export { createSpacePicker, SPACE_PICKER_MARKS, type SpacePicker, type SpacePickerOptions, type SpacePickerTexts } from './spaces/picker.ts';
export {
  createSpaceMap, SPACE_MAP_MARKS, validShape, shapeCenter,
  type SpaceMap, type SpaceMapOptions, type SpaceMapLayer, type SpaceMapTone, type SpaceMapBedState, type SpaceMapPickContext, type FloorPlan, type FloorPlanSource, type PlanShape,
  type PlanBand, type PlanContour, type SpaceMapStep,
} from './spaces/map.ts';
export {
  GRID_SCALES, BED_KINDS, cellSize, cellToRel, relToCell, decorBox, validGrid, safeIconUrl, bedKindOf,
  type GridScale, type PlanGrid, type DecorItem, type DecorIcon, type DecorChange, type BedKind,
} from './spaces/decor.ts';
export {
  DEFAULT_ITEM_KINDS, BASE_UNITS, itemKey, kindLabelOf, sameNameItem, similarItems, searchItems, unitsFor, baseQuantity, stockFromMovements, stockBySpace, stockSummary,
  itemFromRow, itemUnitFromRow, itemKindFromRow, newItemId, createMemoryItemSource,
  MOVEMENT_KIND_LABELS, EXIT_REASON_LABELS, ITEM_STATUS_LABELS, EQUIPMENT_KINDS, averageCost, lotsWithStock, nextExpiry, itemToFields, lotFromRow, movementFromRow,
  type LotRow, type MovementRow, type MovementCostRow,
  fefoPlan, stockAt, countTargets, countFromRow, countLineFromRow, movementToFields, type CountRow, type CountLineRow, type MovementDraft, type CountTarget,
  type ItemRow, type ItemUnitRow, type ItemKind, type StockLine, type ItemSnapshot, type ItemDraft, type ItemDuplicate, type ItemSource, type ItemSearchOptions, type ItemUnitOption,
} from './items/model.ts';
export { createSyncItemSource, type SyncItemSourceOptions } from './items/sync-source.ts';
export { createItemPicker, ITEM_PICKER_MARKS, type ItemPicker, type ItemPickerOptions, type ItemPick } from './items/picker.ts';
export { createItemCatalog, ITEM_CATALOG_MARKS, expiryText, type ItemCatalog, type ItemCatalogOptions, type ItemCatalogFilter, type ItemCatalogAction, type ItemCatalogRowAction } from './items/catalog.ts';
export { createItemSheet, ITEM_SHEET_MARKS, type ItemSheet, type ItemSheetOptions, type ItemSheetTab, type ItemSheetAction } from './items/sheet.ts';
export { createMovementForm, MOVEMENT_FORM_MARKS, type MovementForm, type MovementFormOptions, type MovementMode } from './items/movement-form.ts';
export { createCountSession, COUNT_SESSION_MARKS, type CountSession, type CountSessionOptions, type CountDifference } from './items/count-session.ts';
export { createLevelStar, renderLevelStar, levelFill, type LevelStar, type LevelStarOptions } from './fields/level-star.ts';
export { createSuggestField, attachSuggestions, normalizeName, uniqueNames, matchName, suggestMessage, type SuggestField, type SuggestFieldOptions, type SuggestHandle, type SuggestOptions, type SuggestMode, type NameMatch } from './fields/suggest.ts';
export { fieldAttrs, markField, fieldRequired, FIELD_CONFIRMS, FIELD_SENSITIVITIES, type FieldConfirm, type FieldSpec, type FieldSensitivity } from './fields/field-mark.ts';
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
export { renderMoneyBreakdown, type MoneyBreakdownSpec, type MoneyLine, type MoneyMove } from './cards/money.ts';
export { createCommandPalette, filterPaletteItems, foldText, type CommandPalette, type PaletteItem, type PaletteOptions } from './palette.ts';
