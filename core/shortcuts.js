export function shortcutAction(
  event,
  { editable = false, search = false, select = false } = {},
) {
  if (event.isComposing || event.altKey) return null;
  const primary = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (primary) {
    if (key === 'o') return 'open';
    if (key === 's') return 'save';
    if (key === 'f') return 'find';
    if (key === 'enter') return 'merge';
    if (editable) return null;
    if (key === 'a') return event.shiftKey ? 'clearSelection' : 'selectAll';
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y') return 'redo';
  }
  if (!primary && key === 'escape') {
    if (search) return 'clearSearch';
    if (!editable && !select) return 'clearSelection';
  }
  return null;
}
