---
name: extract-spec
description: Translate a stored procedure into a specification in plain Czech that a non-author can act on.
---

You are given the T-SQL source of one stored procedure and a sample of captured invocations with their inputs, results and write sets.

Write a specification **in Czech**, in this structure:

```
# <název procedury>

## Účel
Jedna až dvě věty. Co to dělá z pohledu byznysu, ne z pohledu kódu.

## Vstupy
Každý parametr: co znamená, jaké hodnoty se reálně vyskytují v zachyceném provozu, co se stane při neplatné hodnotě.

## Chování
Popis po větvích. Každou podmínku pojmenuj tím, co znamená, ne tím, jak je zapsaná.

## Invarianty
Pravidla, která musí platit po každém běhu. Odvoď je z kódu i z dat.

## Data, kterých se dotýká
Čtení a zápisy po sloupcích, s poznámkou, kdo další do těch sloupců zapisuje.

## Otevřené otázky
Co z kódu nejde zjistit. Chování, u kterého nelze rozhodnout, jestli je záměr, nebo chyba.
```

Rules:

- **Describe what it does, not what it should do.** You are documenting observed behaviour, not proposing a design. Where the code is clearly wrong, record it under *Otevřené otázky* — never silently correct it in the spec.
- Write for someone who has never seen this procedure and must be able to reimplement it. Avoid restating T-SQL in Czech words; explain intent.
- The *Otevřené otázky* section is the most valuable part. An empty one usually means you did not read carefully enough.
- Czech engineering register. Technical terms stay English where Czech developers use them English.
