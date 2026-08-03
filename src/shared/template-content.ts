// Task 2.11 — template/label substitution rules shared between the overlay
// renderer (src/overlay/renderer.ts, what actually goes on stream) and the
// dock's Setup view (src/dock/views/setup.ts, the embedded layout preview).
// Single-sourced for the same reason src/shared/animation-keyframes.ts
// consolidated its own previously-duplicated table: two independently
// hand-maintained copies of "how does a template turn into rendered text"
// drift, and the operator ends up previewing one thing while the audience
// sees another.
//
// Fix-wave contract correction (post-review; PRD §8.8/AC 22 updated by the
// controller to match): `{count}` is NOT required by ANY layout anymore —
// the Setup field is always a plain "Label text". Two substitution rules:
//  - substituteLabel: textAbove/textBelow/textBehind take a plain label —
//    `{count}` is substituted if present, but its absence just renders the
//    label verbatim.
//  - inlineContent: textBefore/textAfter place a token-LESS label relative
//    to the number per the LAYOUT itself (textBefore = label then number,
//    textAfter = number then label — this is the whole reason the two
//    layouts now differ). A label that DOES contain `{count}` instead
//    honours the token's position — split around it exactly as before —
//    regardless of which of the two inline layouts is selected: the token
//    defines placement whenever one is present, the layout only decides
//    placement when there is no token to go by.

/**
 * Splits operator-authored template text around the FIRST `{count}` token
 * into the parts that flank the rendered number. Absent `{count}` folds the
 * whole string into `before` — used only as a defensive fallback; callers
 * that care about token-less placement (inlineContent, below) branch before
 * ever reaching this.
 */
export function splitTemplate(template: string | null): { before: string; after: string } {
  if (template === null) return { before: '', after: '' };
  const idx = template.indexOf('{count}');
  if (idx === -1) return { before: template, after: '' };
  return { before: template.slice(0, idx), after: template.slice(idx + '{count}'.length) };
}

/**
 * Renders a plain label (textAbove/textBelow/textBehind), substituting
 * `{count}` if present but never requiring it.
 */
export function substituteLabel(template: string | null, valueText: string): string {
  if (template === null) return '';
  return template.includes('{count}') ? template.replaceAll('{count}', valueText) : template;
}

/**
 * Content for the two INLINE layouts (textBefore/textAfter). A label
 * containing `{count}` is split around the token exactly as before (the
 * token wins, regardless of which inline layout is selected — "keep today's
 * split rendering"). A token-less label is placed relative to the number by
 * the layout itself: textBefore puts the whole label before the number,
 * textAfter puts it after — this is what makes the two layouts actually
 * differ for a plain label like "HALLELUJAH" or "TIMES".
 */
export function inlineContent(
  layout: 'textBefore' | 'textAfter',
  template: string | null,
): { before: string; after: string } {
  if (template !== null && template.includes('{count}')) return splitTemplate(template);
  const label = template ?? '';
  return layout === 'textBefore' ? { before: label, after: '' } : { before: '', after: label };
}
