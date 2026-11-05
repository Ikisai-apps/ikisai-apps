-- Flow 0962: códigos de producto numéricos (VG por Core, 31-10). Las bebidas de la barra compartían letra con montaditos de
-- otro precio (A Agua/Serrano…) y se cobraba el producto equivocado; la carga flow-32 las pasa a 1..5. El check de 0900 solo
-- admitía A–D y α–δ: se amplía con 1–9 (mismo nombre de restricción que aplica la carga en producción).
alter table flow.products drop constraint if exists products_code_check;
alter table flow.products add constraint products_code_check check (code in ('A','B','C','D','α','β','γ','δ','1','2','3','4','5','6','7','8','9'));
