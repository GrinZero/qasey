/** Adapter for the pinned Playwright Trace Viewer. Selection is verified, never a cosmetic step highlight. */
export function selectTraceStep(document: Document, title: string): boolean {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('.action-title-method[title]'))
    .filter(element => element.title === title.replaceAll('\n', ' '));
  if (candidates.length !== 1) return false;
  const entry = candidates[0]!.closest<HTMLElement>('.tree-view-entry');
  if (!entry) return false;
  const row = entry.closest('[role="treeitem"]');
  if (row?.getAttribute('aria-selected') !== 'true') entry.click();
  if (row?.getAttribute('aria-expanded') === 'false') entry.querySelector<HTMLElement>('.codicon-chevron-right')?.click();
  entry.scrollIntoView({ block: 'nearest' });
  return row?.getAttribute('aria-selected') === 'true' && row.getAttribute('aria-expanded') !== 'false';
}
