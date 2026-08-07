# `Chybí seam` — what to say when someone asks

A crib sheet for one question from the floor. Same convention as `DEMO-SCRIPT.md`: English framing,
Czech for everything that gets spoken.

**Where to point:** the procedure screen, `Zdroj` tab, `sp_PlaceOrder`, around **line 150**. Not at
a field on the screen — see *Two things that will catch you* at the bottom.

---

## The answer, in one sentence

> „Seam je místo, kam jde zvenku vstříknout hodnota, kterou si procedura jinak bere ze světa.
> `Chybí seam` znamená: tahle procedura se **větví** podle něčeho, co při přehrání neumíme
> zopakovat — takže bychom neměřili kód, ale hodiny."

The blocker appears when a procedure is `oracle_class = nondet` and its oracle is still at `none`
or `golden` (`parity/api/src/estate/blocker.ts`). It is a **work item**, not a failure: it names the
one thing standing between this procedure and an oracle.

---

## The example worth using: `sp_PlaceOrder`

Four lines next to each other. This is their code, not our description of it.

```sql
-- line 29
DECLARE @Now    DATETIME2(3) = SYSDATETIME();
-- line 32
DECLARE @Year   CHAR(4)      = CAST(YEAR(@Now) AS CHAR(4));

-- line 147, and this comment is in production today
-- POZNAMKA (2018): pri soubeznem vkladani muze dojit ke stejnemu cislu, nikdy se to
-- v produkci nestalo natolik casto aby to nekdo resil, tak to zustalo takhle.
SELECT @NextSeq = ISNULL(MAX(CAST(RIGHT(OrderNumber, 6) AS INT)), 0) + 1
FROM dbo.OrderLedger
WHERE LEFT(OrderNumber, 4) = @Year;          -- ← the clock is in the WHERE

SET @OrderNumber = @Year + RIGHT(N'000000' + CAST(@NextSeq AS VARCHAR(6)), 6);
SELECT @OrderID = ISNULL(MAX(OrderID), 0) + 1 FROM dbo.OrderLedger;
```

Three things to say, in this order:

1. **The clock does not go into a column, it goes into a condition.** `@Now` → `@Year` → the
   `WHERE` on line 152. It decides which rows the `MAX` is taken over, so the resulting
   `OrderNumber` depends on *when* somebody called it.
2. **`@OrderID` is a hand-rolled sequence** — `MAX + 1`, no serialisation. It depends on the
   current state of the table and on who else is writing at the same moment.
3. **The comment.** *„nikdy se to v produkci nestalo natolik často, aby to někdo řešil, tak to
   zůstalo takhle."* It is dated 2018 and it is running today. This is the line that lands.

---

## The distinction the whole blocker rests on

> „Jedenáct ze čtrnácti procedur čte hodiny. **Čtyři se podle nich větví.** To je ten rozdíl.
> `NEWID()` zapsané do `PaymentRef` je jenom identifikátor — ten kanonikalizace srovná. `@Now`
> uvnitř `IF` ne."

Measured at M1 and corrected by M3's triage, not estimated.

---

## What the seam actually is

> „Vstříknout `@Now` jako parametr místo `SYSDATETIME()`. Tu hodnotu už máme — capture zaznamenává
> i to, co si procedura přečetla z okolí, nejen parametry. Chybí ta změna v proceduře."

`verify-m1` asserts that replaying a captured invocation **with the clock pinned** reproduces the
captured result exactly. So the capability is proven and what is missing is a change to the
procedure — which is exactly why it is on the blocker table rather than in a bug tracker.

---

## The simpler one, if they want it shorter: `sp_GetCartSummary`

```sql
IF @PromoActive = 1 AND @Now >= @PromoFrom AND @Now <= @PromoTo
```

> „Stejná objednávka, stejný promo kód, jiný den — jiná cena. Přehrát to bez zapíchnutých hodin
> znamená měřit kalendář."

---

## Two things that will catch you

**The blocker is not on screen in the restored state.** Every `nondet` procedure has invariants by
then, so they have moved on to `chybí shadow run`. `Chybí seam` is visible **after `demo-reset`,
between beats 2 and 3** — eight procedures. If you run the demo from a restored estate rather than
from beat 1, do not go looking for it.

**The `seam_requirements` text is not rendered anywhere.** The agent wrote a paragraph per
procedure and it is in the database and in the API response, but no screen shows it. So do not
point at the UI and say *„a tady to napsal agent"*. Point at `Zdroj` and line 150 instead — it is
the stronger move anyway, because it is their code rather than our summary of it.

---

## If they ask "so how did `sp_CalculateOrderTotal` get past it?"

It is `nondet` too, and it reached `proven`. The oracle harness pins the clock on both sides — the
golden cases carry a recorded `baseline_context`, and the shadow run executes both passes from the
same restored database. So the ladder passes *through* this rung rather than around it: the blocker
says `chybí seam` only while a procedure has no oracle worth the name, and once golden tests and
invariants exist it becomes `chybí shadow run`.
