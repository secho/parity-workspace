# sp_CalculateOrderTotal

## Účel

Dopočítá finanční souhrn objednávky (mezisoučet, promo a věrnostní slevy, DPH, dopravu, věrnostní body) a uloží ho denormalizovaně na všechny řádky dané objednávky v `OrderLedger`. Jako vedlejší efekt „zakotví" aktuální katalogovou cenu produktů z objednávky do `Catalog.LastQuotedPrice` pro účely ranního cenového reportu.

## Vstupy

- **@OrderNumber** (NVARCHAR(20), povinný) – číslo objednávky, podle kterého se hledají řádky v `OrderLedger`. V zachyceném provozu má formát desetimístného čísla (např. `2026003862`). Pokud objednávka s tímto číslem neexistuje, procedura vyvolá `RAISERROR` (chyba 50000, severity 16) s textem obsahujícím `@OrderNumber` a skončí bez jakéhokoli zápisu.
- **@PromoCode** (NVARCHAR(40), volitelný, default `NULL`) – kód slevového kupónu. V zachyceném provozu: 56 % volání `NULL`, zbytek jeden ze čtyř reálně používaných kódů `GEEK200`, `DOPRAVA0`, `LETO15`, `VERNY20`. Pokud je `NULL`, procedura nepočítá „bez promo", ale převezme kód, který už je na objednávce uložený v `PromoCodeUsed` (viz Chování, bod „Promo bez parametru"). Pokud je kód uveden, ale v tabulce `PromoCode` neexistuje, žádná sleva se nepočítá, ale text kódu se přesto uloží do `OrderLedger.PromoCodeUsed` jako „použitý".
- **@ModifiedBy** (NVARCHAR(60), volitelný, default `N'system'`) – identifikace volajícího, ukládá se do `OrderLedger.ModifiedBy` a `Catalog.ModifiedBy`. Ve všech zachycených voláních je vždy explicitně předáno `"api"`; hodnota `"seed"` byla vidět jen jako historická (dřívější) hodnota v datech, ne jako aktuálně předávaný parametr.
- **@RecalcShippingOnly** (BIT, volitelný, default `0`) – podle komentáře v hlavičce „už se nepoužívá, ponecháno kvůli starým voláním z eshopu v1". V těle procedury se s touto proměnnou nikdy nic neděje – nemá žádný vliv na výpočet ani na to, co se zapíše. Fakticky mrtvý parametr. V zachyceném `InputParams` se nikdy neobjevuje explicitně (volající ho buď nepředávají, nebo nástroj capture nezaznamenává parametry na defaultní hodnotě).

Neplatné/neexistující hodnoty parametrů obecně nevedou k chybě procedury (kromě neexistujícího `@OrderNumber`) – nesprávný promo kód se prostě neuplatní, `@ModifiedBy` a `@RecalcShippingOnly` nejsou nijak validovány.

## Chování

**1. Nalezení objednávky.** Řádek s daným `OrderNumber` se hledá pomocí `SELECT TOP 1` – `OrderID`, `CustomerID` a `CountryCode` se přebírají z prvního nalezeného řádku. Implicitně se předpokládá, že všechny řádky se stejným `OrderNumber` patří jedné objednávce, jednomu zákazníkovi a jedné zemi – nikde v proceduře se to nekontroluje. Když se objednávka nenajde, procedura skončí chybou bez zápisu.

**2. Neznámá země zákazníka.** Pokud je `CustomerCountryCode` na objednávce `NULL`, doplní se `CZ`.

**3. Načtení řádků a mezisoučet.** Do dočasné tabulky `#Lines` se načtou jen řádky objednávky, které mají vyplněné `ProductID` (řádky bez produktu, např. čistě servisní/hlavičkové řádky, se do výpočtu nezahrnou vůbec). Čistá částka řádku (`LineNet`) se dopočítá jako `Quantity * UnitPriceNet * (1 - LineDiscountPct/100)` – ale pouze pro řádky, jejichž `ProductID` se podaří napárovat na `Catalog` (INNER JOIN). Pro řádek s produktem, který v `Catalog` už neexistuje, `LineNet` zůstane `NULL` a taková položka se do mezisoučtu (`SUM(LineNet)`) nepočítá – tento řádek objednávky ale na konci přesto dostane přepsané souhrnné částky celé objednávky jako všechny ostatní.

**4. Sazba DPH – kaskáda náhradních řešení.** Nejprve se hledá „standard" sazba pro zemi zákazníka v číselníku `VatRate`. Pokud tam není, vezme se sazba DPH kategorie z **první** položky objednávky (řazeno podle `OrderLineID` – ne podle nejvyšší hodnoty, počtu kusů ani jinak reprezentativně vybrané položky). Pokud ani to není k dispozici, použije se pevná pojistková hodnota 21 %.

**5. Věrnostní tier.** Čte se aktuální hodnota `Customer.LoyaltyTier` v okamžiku přepočtu, nikoli žádná historická hodnota uložená k objednávce. Opakovaný přepočet stejné objednávky později (po změně tieru zákazníka) tedy může dát jiný výsledek.

**6. Promo kód bez parametru.** Když `@PromoCode` není předán (`NULL`), procedura si dosadí kód, který je již uložen v `OrderLedger.PromoCodeUsed` u dané objednávky. Volání s `@PromoCode = NULL` tedy znamená „nech promo tak, jak je", nikoli „bez promo kódu". Explicitní zrušení promo kódu na objednávce touto procedurou možné není.

**7. Vyhodnocení promo kódu.** Pokud je k dispozici nějaký kód (z parametru nebo z objednávky), načtou se jeho parametry z `PromoCode` (procentní sleva, pevná sleva, minimální hodnota objednávky, omezení na kategorii, omezení na zemi, příznak kombinovatelnosti s věrnostním programem, aktivnost, platnost od–do). Sleva se uplatní pouze pokud současně platí:
   - `IsActive = 1`,
   - aktuální čas leží v intervalu `ValidFrom`–`ValidTo` (včetně obou mezí),
   - mezisoučet splňuje `MinOrderValue` (pokud je definováno),
   - země zákazníka odpovídá `CountryCode` promo kódu (pokud je definováno).

   Omezení na kategorii (`PromoCode.CategoryID`) se **nikde nekontroluje** – přestože se do proměnné `@PromoCategory` načte, na nic se nepoužije (v kódu je i zakomentovaný debugovací blok, který na to jednou upozorňoval).

   Je-li procentní sleva (`DiscountPct`) vyplněná, použije se ta; jinak se použije pevná částka (`DiscountAmount`, případně 0). Nikdy se nekombinují obě najednou.

**8. Neznámý promo kód.** Pokud zadaný kód v `PromoCode` neexistuje, sleva je 0, ale kód se přesto zapíše jako „použitý" na objednávku.

**9. Věrnostní sleva podle tieru.** Uplatní se jen když je tier zadaný (`NOT NULL`), tier ≥ 1 **a** mezisoučet ≥ 500:
   - v ČR (`CountryCode = 'CZ'`): tier ≥ 4 → 12 %, tier = 3 → 8 %, tier = 2 → 5 %, tier = 1 → 2 %;
   - mimo ČR: pevně 3 % bez ohledu na konkrétní výši tieru – přestože komentář v kódu u této větve tvrdí, že „SK zákazníci nemají nárok na věrnostní slevu", kód jim ji naopak přiznává (byť nižší, 3 %).

**10. Věrnostní body.** 1 bod za každých 100 (měnových) jednotek čistého mezisoučtu, zaokrouceno dolů (`FLOOR`) – počítáno stejně bez ohledu na zemi/měnu objednávky.

**11. Doprava.** Mezisoučet ≥ 1500 → doprava zdarma; jinak paušál 99. DPH na dopravu se počítá vždy pevnou sazbou 21 % (`ROUND(ShippingCost * 0.21, 2)`), nezávisle na sazbě DPH zjištěné v bodě 4 – i pro zákazníky/kategorie s jinou sazbou.

**12. Kombinace promo + věrnostní slevy (stacking).** Pokud má aktuálně načtený promo kód příznak `StacksWithLoyalty = 1` (ten se nastaví hned při načtení kódu, bez ohledu na to, zda kód právě prošel kontrolou aktivnosti/platnosti v bodě 7) **a** věrnostní sleva je nenulová, přepočítá se částka s DPH ze základu už sníženého o promo slevu: `(Mezisoučet - PromoSleva) * (1 + SazbaDPH)`. Ve výchozí (nestacking) větvi se DPH počítá z celého mezisoučtu a promo sleva se odečítá až z částky včetně DPH – tedy DPH se v tomto případě fakticky nepočítá ze základu sníženého o slevu. Tyto dvě větve tak dávají různý základ pro DPH v závislosti na tom, zda je promo „stackovací", nikoli podle nějakého jednotného daňového pravidla.

**13. Pojistka proti záporné částce.** Pokud vyjde `TotalWithVat` záporné, přepíše se na 0. `TotalNet` a `TotalVat` se přitom nepřepočítávají – v tomto krajním případě tedy `TotalNet + TotalVat` nemusí po zápisu odpovídat `TotalWithVat`.

**14. Zápis souhrnu.** `UPDATE` přepíše **všechny** řádky `OrderLedger` s daným `OrderNumber` stejnými souhrnnými hodnotami (denormalizace) a nastaví `CalcVersion` natvrdo na `'calc-2022-08'`, `CalcCachedAt`/`ModifiedAt` na aktuální čas a `ModifiedBy` na hodnotu parametru.

**15. Zakotvení katalogové ceny.** Pro každý produkt z objednávky se `Catalog.LastQuotedPrice` přepíše na **aktuální** `Catalog.PriceNet` (ne na cenu, za kterou byl produkt v objednávce skutečně účtován, tj. `UnitPriceNet` v `#Lines`), včetně `LastQuotedAt`, `ModifiedAt`, `ModifiedBy`.

## Invarianty

- Po úspěšném běhu má `OrderLedger.TotalWithVat ≥ 0` (explicitně ošetřeno), ale **není** zaručeno, že `TotalNet + TotalVat = TotalWithVat` (viz bod 13 výše – ošetřen jen speciální případ záporné částky).
- Mimo tento krajní případ platí `TotalVat = NetSubtotal * SazbaDPH + ShippingVat` ve výchozí větvi, resp. `TotalVat = (NetSubtotal - PromoSleva) * SazbaDPH + ShippingVat` ve stacking větvi – DPH se tedy nikdy nepočítá z částky snížené o věrnostní slevu, jen případně o promo slevu.
- `ShippingCost` je vždy buď 0, nebo 99.
- `LoyaltyPointsEarned` je vždy celé nezáporné číslo (`FLOOR(NetSubtotal/100)`), pokud je mezisoučet nezáporný.
- Všechny řádky `OrderLedger` se stejným `OrderNumber` mají po běhu procedury identické hodnoty `TotalNet`, `TotalVat`, `TotalWithVat`, `ShippingCost`, `DiscountAmount`, `PromoCodeUsed`, `PromoDiscountAmount`, `LoyaltyDiscountAmount`, `LoyaltyPointsEarned`, `CalcCachedAt`, `CalcVersion`, `ModifiedAt`, `ModifiedBy`.
- `CalcVersion` je po každém běhu vždy přesně `'calc-2022-08'` – nejde o skutečné verzování podle zvolené výpočetní větve, jen konstanta.
- `Catalog.LastQuotedPrice` je po běhu vždy rovno aktuálnímu `Catalog.PriceNet` pro každý produkt, který se objevil v objednávce – nereprezentuje cenu, za kterou byl produkt prodán.
- `DiscountAmount` na `OrderLedger` je vždy `PromoDiscountAmount + LoyaltyDiscountAmount`.

## Data, kterých se dotýká

**Čtení:**
- `OrderLedger` – `OrderNumber`, `OrderID`, `CustomerID`, `CustomerCountryCode`, `OrderLineID`, `ProductID`, `Quantity`, `UnitPriceNet`, `LineDiscountPct`, `PromoCodeUsed` (poslední jako fallback, když parametr `@PromoCode` chybí).
- `Catalog` – `ProductID`, `CategoryID`, `PriceNet` (čte se i pro krok 15, kde se zároveň zapisuje).
- `VatRate` – `CountryCode`, `RateCode`, `Rate`.
- `Category` – `CategoryID`, `VatRate` (fallback sazba).
- `Customer` – `CustomerID`, `LoyaltyTier`.
- `PromoCode` – `Code`, `DiscountPct`, `DiscountAmount`, `MinOrderValue`, `CategoryID`, `CountryCode`, `StacksWithLoyalty`, `IsActive`, `ValidFrom`, `ValidTo`.

**Zápisy:**
- `OrderLedger` (WHERE `OrderNumber = @OrderNumber`, tedy všechny řádky objednávky) – `TotalNet`, `TotalVat`, `TotalWithVat`, `ShippingCost`, `DiscountAmount`, `PromoCodeUsed`, `PromoDiscountAmount`, `LoyaltyDiscountAmount`, `LoyaltyPointsEarned`, `CalcCachedAt`, `CalcVersion`, `ModifiedAt`, `ModifiedBy`. Ze zachyceného provozu je vidět, že tytéž sloupce (`CalcVersion` s historickou hodnotou `"v3"`, `ModifiedBy` s historickou hodnotou `"seed"`) v minulosti zapisoval i jiný proces/jiná verze procedury – tato procedura tedy není nutně jediný zapisovatel do těchto sloupců v historii dat, i když aktuálně přepisuje vždy na `'calc-2022-08'`.
- `Catalog` (JOIN přes `#Lines.ProductID`) – `LastQuotedPrice`, `LastQuotedAt`, `ModifiedAt`, `ModifiedBy`. Podle komentáře v kódu tato hodnota slouží ranímu cenovému reportu – tedy další konzument těchto sloupců je reportovací proces, ne tato procedura.

## Otevřené otázky

- **`@RecalcShippingOnly` je mrtvý parametr.** Deklarován, nikde v těle použit. Nejasné, zda dřívější logika „přepočti jen dopravu" byla odstraněna omylem, nebo zda zůstala jen zpětná kompatibilita signatury pro staré volání z eshopu v1 bez odpovídající funkčnosti.
- **Omezení promo kódu na kategorii se nekontroluje.** `PromoCode.CategoryID` se načte do `@PromoCategory`, ale nikdy se nepoužije při rozhodování, zda slevu uplatnit. Zakomentovaný debug řádek („category-restricted promo used on order...") naznačuje, že si toho někdo všiml už dřív (2016) a nechal to neopravené. Není jasné, jestli je to záměr (kategorie se dnes už nekontroluje záměrně) nebo neopravená chyba, která umožňuje uplatnit kategoriově omezený promo kód i na objednávky, které danou kategorii vůbec neobsahují.
- **Rozpor komentáře a kódu u věrnostní slevy mimo ČR.** Komentář říká, že např. SK zákazníci „nemají nárok na věrnostní slevu", ale kód jim přiznává flat 3% slevu. Není jasné, který z těchto dvou zdrojů pravdy je správný – jestli sleva 3 % je zamýšlený „menší bonus" pro zahraničí, nebo pozůstatek staršího kódu, který měl být nahrazen nulou.
- **Nekonzistentní základ DPH mezi stacking a nestacking větví.** Ve výchozí větvi DPH ignoruje promo slevu (počítá se z plného mezisoučtu), ve stacking větvi (`StacksWithLoyalty=1` a věrnostní sleva > 0) se promo sleva od základu odečte před výpočtem DPH. Nejde o jednotné daňové pravidlo, ale o vedlejší efekt pořadí, ve kterém byly úpravy do procedury postupně přidávány (stacking dodáno až při kampani VERNY20). Nejasné, který výpočet je „správný" z pohledu daňové/účetní politiky firmy.
- **Pojistka proti záporné částce je neúplná.** Ošetřuje jen `TotalWithVat < 0`, ale ne návaznou konzistenci `TotalNet`/`TotalVat`. U malé objednávky s velkou slevou tak může vzniknout stav, kdy `TotalNet + TotalVat ≠ TotalWithVat`, aniž by to procedura signalizovala.
- **Řádky s produktem mimo katalog mlčky nepřispívají do mezisoučtu.** Pokud `ProductID` na řádku objednávky neexistuje v `Catalog`, `LineNet` zůstane `NULL` a nezapočítá se do `SUM`. Tento řádek ale i tak dostane zapsané souhrnné částky za celou (zbylou) objednávku, jako by byl v pořádku – bez varování či logu, že něco chybí.
- **Fallback sazby DPH podle kategorie první položky je nahodilý.** Výběr „první" položky je řazen podle `OrderLineID`, ne podle hodnoty, množství ani jiného byznysově relevantního kritéria. U objednávky s více kategoriemi s různou sazbou DPH tak fallback sazba závisí na tom, který řádek byl vložen jako první, což působí jako provizorní řešení („pojistka") spíš než úmyslné pravidlo.
- **DPH na dopravu je natvrdo 21 %.** Nepoužívá se `@VatRate` zjištěná pro zákazníka/kategorii, takže u zemí/kategorií s jinou sazbou DPH může být DPH na dopravu nesprávné oproti reálné sazbě.
- **Promo kód „DOPRAVA0" nemá v kódu žádnou vazbu na dopravu.** Název kódu odpovídá byznysové myšlence „doprava zdarma", ale mechanicky se chová stejně jako kterýkoli jiný promo kód – snižuje `PromoDiscount` o pevnou částku/procento a nijak nenuluje `ShippingCost`. V zachyceném provozu (viz sample) dal tento kód pevnou slevu 89, což se liší od paušálu dopravy 99 – nejasné, zda je to záměrná (jiná) hodnota, nebo nesoulad mezi obchodním záměrem kódu a jeho reálným nastavením v tabulce `PromoCode`.
- **`StacksWithLoyalty` se nastaví bez ohledu na platnost promo kódu.** `@StacksFlag` se načte hned při nalezení kódu podle `Code`, ne až po ověření aktivnosti/platnosti/limitu. V současném kódu to nezpůsobí viditelný rozdíl (protože `@PromoDiscount` zůstane 0, pokud kód neprojde kontrolou), ale je to křehké místo – při budoucí úpravě výpočtu by mohlo snadno dojít k tomu, že se stacking větev použije i pro neplatný/expirovaný promo kód.
- **Předpoklad jednoznačnosti `OrderNumber`.** `SELECT TOP 1` na začátku bere `OrderID`, `CustomerID` a `CountryCode` z libovolného řádku se shodným `OrderNumber` – nikde se neověřuje, že jsou tyto hodnoty na všech řádcích objednávky shodné. Pokud by číslo objednávky nebylo unikátní klíč (nebo šlo o poškozená data), procedura by to tiše přešla.
- **Historická hodnota `CalcVersion = "v3"` a `ModifiedBy = "seed"` v datech.** Zachycený provoz ukazuje, že před tímto voláním měly řádky objednávky verzi `"v3"`, kterou tato procedura vždy přepisuje na `"calc-2022-08"`. Není z kódu ani z capture patrné, jaký proces/verze `"v3"` produkoval a jestli ještě běží paralelně s touto procedurou (možná souvislost s `@RecalcShippingOnly` a starým eshopem v1).
