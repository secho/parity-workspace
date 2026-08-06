# Rozhodnutí — sp_CalculateOrderTotal

Odchylky našel shadow run #3 nad referenční implementací: 400 přehraných volání, 1 668 syrových rozdílů, 1 600 vyřešila kanonikalizace v kódu, 4 nálezy došly k člověku.


## `write_set:OrderLedger.TotalWithVat:sub_cent`

**Zachovat chování** — rozhodl člověk, 2026-08-06.

Nesoulad základu DPH mezi stacking a nestacking větví je patnáct let v produkci a účetnictví na něm stojí. Zachovat, opravit samostatnou změnou až bude parita prokázaná.

## `write_set:OrderLedger.TotalWithVat:material`

**Zachovat chování** — rozhodl člověk, 2026-08-06.

Nesoulad základu DPH mezi stacking a nestacking větví je patnáct let v produkci a účetnictví na něm stojí. Zachovat, opravit samostatnou změnou až bude parita prokázaná.

## `write_set:OrderLedger.TotalVat:sub_cent`

**Zachovat chování** — rozhodl člověk, 2026-08-06.

Nesoulad základu DPH mezi stacking a nestacking větví je patnáct let v produkci a účetnictví na něm stojí. Zachovat, opravit samostatnou změnou až bude parita prokázaná.

## `write_set:OrderLedger.TotalVat:material`

**Zachovat chování** — rozhodl člověk, 2026-08-06.

Nesoulad základu DPH mezi stacking a nestacking větví je patnáct let v produkci a účetnictví na něm stojí. Zachovat, opravit samostatnou změnou až bude parita prokázaná.
