-- Central · Revisión: Flow entra en el cuadro de avance (RELEVO-001, alta de Flow; encargo de Core del 26-10-2026).
-- `central.review_screens.app` acepta `flow`, en el orden de `REVIEW_APPS` (_domain/central/review.ts), antes de
-- `transversal`. Las filas que ya hay no cambian. Referencia: docs/central/API.md §2.14. Toca solo central.
alter table central.review_screens drop constraint review_screens_app_check;
alter table central.review_screens add constraint review_screens_app_check
  check (app in ('central','tasks','invoices','booking','food','guests','organizers','resources','flow','transversal'));
