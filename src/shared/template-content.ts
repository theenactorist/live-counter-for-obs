// Task 2.11 — template/label substitution rules shared between the overlay
// renderer (src/overlay/renderer.ts, what actually goes on stream) and the
// dock's Setup view (src/dock/views/setup.ts, the embedded layout preview).
// Single-sourced for the same reason src/shared/animation-keyframes.ts
// consolidated its own previously-duplicated table: two independently
// hand-maintained copies of "how does a template turn into rendered text"
// drift, and the operator ends up previewing one thing while the audience
// sees another.
//
// Two distinct substitution rules, per PRD §8.8 (amended for the six-layout
// gallery):
//  - splitTemplate: the INLINE layouts (textBefore/textAfter) REQUIRE a
//    `{count}` token (enforced by setup.ts's validation) and split the
//    template text around its first occurrence into the parts that flank the
//    rendered number.
//  - substituteLabel: the stacked/ghost layouts (textAbove/textBelow/
//    textBehind) take a PLAIN label that does NOT require the token — any
//    occurrence is substituted, but its absence just renders the label
//    verbatim.

/**
 * Splits operator-authored template text around the FIRST `{count}` token
 * into the parts that flank the rendered number. Absent `{count}` (should
 * never happen for a saved inline-layout template — setup.ts requires it —
 * but handled defensively) folds the whole string into `before`.
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
