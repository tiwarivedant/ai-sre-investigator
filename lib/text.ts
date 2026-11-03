/**
 * Clean incident or follow-up text as typed or pasted: trim whitespace and stray wrapping
 * quotes ('...', "...", “...”, ‘...’) left by shells and chat clients.
 */
export function cleanFollowUp(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^(['"“‘`])([\s\S]*)(['"”’`])$/);
    if (!m) break;
    t = m[2].trim();
  }
  // A lone quote at either end (the shell or chat client ate its partner): drop it if unbalanced.
  const unbalanced = (q: RegExp) => (t.match(q) ?? []).length % 2 === 1;
  if (/^["“”`]/.test(t) && unbalanced(/["“”`]/g)) t = t.slice(1).trim();
  if (/["“”`]$/.test(t) && unbalanced(/["“”`]/g)) t = t.slice(0, -1).trim();
  if (/^['‘’]/.test(t)) t = t.slice(1).trim(); // a leading apostrophe is never content
  if (/[‘’]$/.test(t) && !/s’$/.test(t)) t = t.slice(0, -1).trim();
  return t;
}

/** Revision labels saved before quotes were dropped looked like `follow-up USER-001: "text"`; show them without. */
export const revisionLabel = (trigger: string) => trigger.replace(/^(follow-up USER-\d+: )"([\s\S]*)"$/, "$1$2");
