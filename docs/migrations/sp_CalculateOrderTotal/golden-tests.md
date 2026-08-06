# Golden testy — sp_CalculateOrderTotal

Každý případ cituje `InvocationID` skutečného zachyceného volání. Vstupy se čtou zpátky
z capture, ne z tohohle souboru — model si je nemohl vymyslet.

Proti vygenerované službě: **17 prošlo, 0 neprošlo**.

| Případ | Větev | InvocationID | Proč je v sadě |
| --- | --- | --- | --- |
| `dopravao0_promo_loyalty_paid_shipping_all_positive` | `sp_CalculateOrderTotal promo=DOPRAVA0` | 42070 | Every additive component simultaneously non-zero: promo discount + loyalty discount + paid shipping fee/VAT together -> full-formula stress case (8 calls). |
| `no_promo_no_loyalty_free_shipping` | `sp_CalculateOrderTotal promo=none` | 41810 | Baseline path: PromoCode=null with no stored promo on the order (skips promo block entirely), LoyaltyTier absent or subtotal<500 (no loyalty discount), NetSubtotal>=1500 (free shipping). Highest-frequency shape (300 calls) for promo=none. |
| `no_promo_no_loyalty_paid_shipping` | `sp_CalculateOrderTotal promo=none` | 42504 | Shipping boundary: NetSubtotal<1500 -> flat 99 fee + its own 21% VAT; no promo, no loyalty discount (21 calls). |
| `stored_promo_fallback_no_loyalty` | `sp_CalculateOrderTotal promo=none` | 41814 | @PromoCode parameter NULL but order already carries PromoCodeUsed -> step-5 fallback re-reads it from OrderLedger and applies its discount; no loyalty discount; free shipping (120 calls). |
| `geek200_promo_with_loyalty_free_shipping` | `sp_CalculateOrderTotal promo=GEEK200` | 41815 | promo=GEEK200 branch: code found active/valid in dbo.PromoCode, discount applied; combined with loyalty discount; free shipping. Top GEEK200 stratum (213 calls). |
| `rare-leap-day-42276` | `sp_CalculateOrderTotal promo=none` | 42276 | Rare branch traffic:leap-day, added by the platform: deliberately unusual traffic that a sampled suite would otherwise drop. |
| `rare-stacked-promo-44789` | `sp_CalculateOrderTotal promo=VERNY20` | 44789 | Rare branch traffic:stacked-promo, added by the platform: deliberately unusual traffic that a sampled suite would otherwise drop. |
| `rare-stacked-promo-45152` | `sp_CalculateOrderTotal promo=VERNY20` | 45152 | Rare branch traffic:stacked-promo, added by the platform: deliberately unusual traffic that a sampled suite would otherwise drop. |
| `verny20_stacking_triggered` | `sp_CalculateOrderTotal promo=VERNY20` | 43901 | promo=VERNY20, the only observed code with StacksWithLoyalty=1: LoyaltyDiscount>0 so the step-9 stacking IF triggers and TotalWithVat is recomputed via (NetSubtotal-PromoDiscount)*(1+VatRate) instead of the default formula. Top VERNY20 stratum (23 calls). |
| `geek200_promo_rejected_paid_shipping` | `sp_CalculateOrderTotal promo=GEEK200` | 43595 | promo=GEEK200 supplied and found in dbo.PromoCode, but the validity IF (active/date range/min order/country) fails -> PromoDiscount stays 0; demonstrates the promo-rejection sub-branch distinct from promo-not-supplied. Paid shipping (4 calls). |
| `leto15_promo_with_loyalty_free_shipping` | `sp_CalculateOrderTotal promo=LETO15` | 36210 | promo=LETO15 branch applied with loyalty discount, free shipping. Top LETO15 stratum (206 calls). |
| `rare-leap-day-42272` | `sp_CalculateOrderTotal promo=none` | 42272 | Rare branch traffic:leap-day, added by the platform: deliberately unusual traffic that a sampled suite would otherwise drop. |
| `rare-leap-day-42296` | `sp_CalculateOrderTotal promo=none` | 42296 | Rare branch traffic:leap-day, added by the platform: deliberately unusual traffic that a sampled suite would otherwise drop. |
| `dopravao0_promo_with_loyalty_free_shipping` | `sp_CalculateOrderTotal promo=DOPRAVA0` | 41824 | promo=DOPRAVA0 branch applied together with loyalty discount, free shipping. Top DOPRAVA0 stratum (209 calls). |
| `no_promo_loyalty_paid_shipping` | `sp_CalculateOrderTotal promo=none` | 41970 | Loyalty discount combined with paid shipping -> subtotal in the 500-1500 boundary band (qualifies for loyalty tier discount but not free shipping) (30 calls). |
| `no_promo_with_loyalty_free_shipping` | `sp_CalculateOrderTotal promo=none` | 31201 | Loyalty-discount branch triggered (tier>=1 AND subtotal>=500) with no promo involved; free shipping. Single most frequent stratum overall (655 calls). |
| `verny20_stacking_not_triggered` | `sp_CalculateOrderTotal promo=VERNY20` | 43757 | promo=VERNY20 present but LoyaltyDiscount=0 on this order -> the stacking IF condition (StacksFlag=1 AND LoyaltyDiscount>0) is false despite the flag, so the normal (non-stacking) formula is used. Contrast case to verny20_stacking_triggered (13 calls). |
