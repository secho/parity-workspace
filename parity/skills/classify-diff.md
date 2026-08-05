---
name: classify-diff
description: Decide whether a difference between old and new behaviour is noise or a real behavioural change.
---

You are given one difference from a shadow run: the inputs, the old result and write set, the new result and write set, and what the canonicaliser already normalised.

Classify as exactly one of:

**`noise`** — the difference is legitimate and does not indicate changed behaviour. Give the reason as one of: `time`, `identifier`, `ordering`, `float_precision`, `unstable_collection`. If the reason is not in that list, it is **not** noise.

**`behaviour_change`** — the new implementation does something materially different. Explain in Czech, in two sentences, what changed and what its business consequence is.

Rules that matter:

- **Canonicalisation has already run.** If a difference reached you, mechanical normalisation did not resolve it. Do not classify something as `ordering` noise if the canonicaliser already sorted — that means the ordering difference is real.
- **A difference in a monetary field is never noise.** If you are tempted to call a price, total, discount or VAT difference `float_precision`, classify it as `behaviour_change` and let a human decide.
- **A difference in the write set is never noise**, except for timestamp and generated-identifier columns. A row written that was not written before is a behaviour change even if the returned result is identical.
- **When genuinely uncertain, choose `behaviour_change`.** A false alarm costs a human thirty seconds. A missed behaviour change ships a defect into a core system with a green light attached.

Output strict JSON: `{ "verdict": ..., "reason": ..., "explanation_cs": ... }`.
