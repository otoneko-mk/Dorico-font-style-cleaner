import { shortcutAction } from './core/shortcuts.js';

const ids = [
  'app',
  'open',
  'file',
  'filename',
  'modified',
  'kind',
  'search',
  'sources',
  'source-list',
  'select-all',
  'selection-count',
  'empty',
  'target',
  'status',
  'merge',
  'save',
  'undo',
  'redo',
];
const elements = Object.fromEntries(
  ids.map((id) => [id, document.getElementById(id)]),
);
const worker = new Worker(new URL('./worker.js', import.meta.url), {
  type: 'module',
});
const pending = new Map();
let requestID = 0,
  catalogs = null,
  checked = new Set(),
  filename = '',
  busy = false,
  downloadURL = '',
  anchorID = null;
let revision = 0,
  savedRevision = 0,
  canUndo = false,
  canRedo = false;
const isDirty = () => revision !== savedRevision;

worker.onmessage = ({ data }) => {
  const handlers = pending.get(data.id);
  if (!handlers) return;
  pending.delete(data.id);
  if (data.ok) handlers.resolve(data.result);
  else handlers.reject(new Error(data.message));
};
worker.onerror = (event) => {
  const error = new Error(
    event.message || '処理を開始できません。ページを再読み込みしてください。',
  );
  for (const handlers of pending.values()) handlers.reject(error);
  pending.clear();
  message(error.message, true);
};
function request(action, data = {}, transfer = []) {
  const id = ++requestID;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, ...data }, transfer);
  });
}
function message(text = '', error = false) {
  elements.status.textContent = error ? `エラー：${text}` : text;
  elements.status.classList.toggle('error', error);
}
function styles() {
  return [...(catalogs?.[elements.kind.value] || [])].sort(
    (a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id),
  );
}
function visibleStyles() {
  const query = elements.search.value.normalize('NFKC').toLocaleLowerCase();
  return styles().filter(
    (style) =>
      !query ||
      `${style.name}\n${style.id}`
        .normalize('NFKC')
        .toLocaleLowerCase()
        .includes(query),
  );
}
function update() {
  elements.open.disabled = busy;
  elements.file.disabled = busy;
  for (const element of [elements.kind, elements.search, elements.target])
    element.disabled = busy || !catalogs;
  elements.merge.disabled = busy || !checked.size || !elements.target.value;
  elements.undo.disabled = busy || !canUndo;
  elements.redo.disabled = busy || !canRedo;
  const saveEnabled = !busy && !!catalogs && !!downloadURL;
  elements.save.setAttribute('aria-disabled', String(!saveEnabled));
  if (saveEnabled) elements.save.href = downloadURL;
  else elements.save.removeAttribute('href');
  for (const checkbox of elements.sources.querySelectorAll('input'))
    checkbox.disabled = busy;
  const eligible = visibleStyles().filter(
    (style) => style.id !== elements.target.value,
  );
  const selected = eligible.filter((style) => checked.has(style.id)).length;
  elements['select-all'].disabled = busy || !catalogs || !eligible.length;
  elements['select-all'].checked =
    eligible.length > 0 && selected === eligible.length;
  elements['select-all'].indeterminate =
    selected > 0 && selected < eligible.length;
  elements['selection-count'].textContent = catalogs
    ? `${checked.size}個選択`
    : '';
  elements.modified.textContent = isDirty() ? '*' : '';
  document.title = filename
    ? `${filename}${isDirty() ? ' *' : ''} — Dorico Style Cleaner`
    : 'Dorico Style Cleaner';
  elements.app.setAttribute('aria-busy', String(busy));
}
async function perform(text, operation) {
  if (busy) return;
  busy = true;
  message(text);
  update();
  try {
    await operation();
  } catch (error) {
    message(error.message || String(error), true);
  } finally {
    busy = false;
    update();
  }
}
function renderTargets(previous = elements.target.value) {
  elements.target.replaceChildren(new Option('統合先を選択', ''));
  for (const style of styles())
    if (!checked.has(style.id))
      elements.target.add(new Option(`${style.name}  [${style.id}]`, style.id));
  elements.target.value = [...elements.target.options].some(
    (option) => option.value === previous,
  )
    ? previous
    : '';
}
function syncCheckboxes() {
  for (const input of elements.sources.querySelectorAll('input')) {
    input.checked = checked.has(input.dataset.id);
    input.closest('tr').classList.toggle('checked', input.checked);
  }
}
function selectionChanged() {
  syncCheckboxes();
  renderTargets();
  message();
  update();
}
function toggleSource(id, value, range = false, keepAnchor = false) {
  if (busy) return;
  const visible = visibleStyles().map((style) => style.id);
  const start = visible.indexOf(anchorID),
    stop = visible.indexOf(id);
  const selectedIDs =
    range && start >= 0 && stop >= 0
      ? visible.slice(Math.min(start, stop), Math.max(start, stop) + 1)
      : [id];
  for (const selectedID of selectedIDs) {
    if (value) checked.add(selectedID);
    else checked.delete(selectedID);
  }
  if (!keepAnchor) anchorID = id;
  selectionChanged();
}
function selectAll(value = true) {
  if (busy || !catalogs) return;
  if (!value) checked.clear();
  else
    for (const style of visibleStyles())
      if (style.id !== elements.target.value) checked.add(style.id);
  anchorID = null;
  selectionChanged();
}
function prepareDownload(bytes) {
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = URL.createObjectURL(
    new Blob([bytes], { type: 'application/octet-stream' }),
  );
  elements.save.download =
    filename.replace(/\.dorico$/i, '') + '_cleaned.dorico';
}
function acceptRevision(next) {
  catalogs = next.catalogs;
  revision = next.revision;
  canUndo = next.canUndo;
  canRedo = next.canRedo;
  prepareDownload(next.bytes);
}
function render({ previousTarget = '', clearSelection = true } = {}) {
  if (clearSelection) {
    checked.clear();
    anchorID = null;
  }
  elements.sources.replaceChildren();
  const visible = visibleStyles();
  for (const style of visible) {
    const row = document.createElement('tr'),
      cell = document.createElement('td'),
      checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.id = style.id;
    checkbox.checked = checked.has(style.id);
    checkbox.setAttribute(
      'aria-label',
      `${style.name} [${style.id}]を統合元にする`,
    );
    row.classList.toggle('checked', checkbox.checked);
    checkbox.addEventListener('click', (event) =>
      toggleSource(style.id, checkbox.checked, event.shiftKey),
    );
    row.addEventListener('click', (event) => {
      if (event.target !== checkbox && !busy) {
        checkbox.focus();
        toggleSource(style.id, !checked.has(style.id), event.shiftKey);
      }
    });
    cell.append(checkbox);
    row.append(cell);
    for (const value of [style.name, style.id]) {
      const td = document.createElement('td');
      td.textContent = value;
      td.title = value;
      row.append(td);
    }
    elements.sources.append(row);
  }
  elements.empty.hidden = visible.length > 0;
  elements.empty.textContent = !catalogs
    ? 'ファイルを開いてください。'
    : elements.search.value
      ? '一致するスタイルがありません。'
      : 'スタイルがありません。';
  renderTargets(previousTarget);
  update();
}
async function historyAction(direction) {
  if (busy || !(direction === 'undo' ? canUndo : canRedo)) return;
  const target = elements.target.value;
  await perform(
    direction === 'undo' ? '元に戻しています…' : 'やり直しています…',
    async () => {
      acceptRevision(await request(direction));
      render({ previousTarget: target });
      message(direction === 'undo' ? '元に戻しました' : 'やり直しました');
    },
  );
}
elements.open.addEventListener('click', () => elements.file.click());
elements.file.addEventListener('change', async () => {
  const file = elements.file.files[0];
  elements.file.value = '';
  if (!file || busy) return;
  if (isDirty() && !window.confirm('未保存の変更を破棄して開きますか？'))
    return;
  await perform('読み込み中…', async () => {
    if (file.size > 256 * 1024 ** 2)
      throw new Error('ファイルサイズが256 MiBを超えています。');
    const bytes = await file.arrayBuffer(),
      next = await request('open', { bytes }, [bytes]);
    filename = file.name;
    savedRevision = next.revision;
    acceptRevision(next);
    elements.filename.textContent = filename;
    elements.filename.title = filename;
    elements.search.value = '';
    render();
    message();
  });
});
elements.kind.addEventListener('change', () => {
  elements.search.value = '';
  render();
  message();
});
elements.search.addEventListener('input', () => {
  render({ previousTarget: elements.target.value, clearSelection: false });
  message();
});
elements.target.addEventListener('change', update);
elements['select-all'].addEventListener('change', () =>
  selectAll(elements['select-all'].checked),
);
elements.undo.addEventListener('click', () => historyAction('undo'));
elements.redo.addEventListener('click', () => historyAction('redo'));
elements.merge.addEventListener('click', () => {
  const sources = [...checked],
    target = elements.target.value,
    kind = elements.kind.value;
  if (!sources.length || !target || busy) return;
  perform('統合中…', async () => {
    acceptRevision(await request('merge', { sources, target, kind }));
    render({ previousTarget: target });
    message('統合しました');
  });
});
elements.save.addEventListener('click', (event) => {
  if (busy || !downloadURL) {
    event.preventDefault();
    return;
  }
  savedRevision = revision;
  update();
  message('ダウンロードを開始しました');
});
elements.save.addEventListener('keydown', (event) => {
  if (event.key === ' ') {
    event.preventDefault();
    elements.save.click();
  }
});
elements['source-list'].addEventListener('keydown', (event) => {
  if (
    busy ||
    !(event.target instanceof HTMLInputElement) ||
    event.target.type !== 'checkbox'
  )
    return;
  const inputs = [...elements.sources.querySelectorAll('input')],
    index = inputs.indexOf(event.target);
  if (index < 0 || event.ctrlKey || event.metaKey || event.altKey) return;
  let nextIndex = index;
  if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
  else if (event.key === 'ArrowDown')
    nextIndex = Math.min(inputs.length - 1, index + 1);
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = inputs.length - 1;
  else if (event.key === 'Enter') {
    event.preventDefault();
    event.target.click();
    return;
  } else return;
  event.preventDefault();
  inputs[nextIndex].focus();
  if (event.shiftKey) {
    anchorID ??= event.target.dataset.id;
    toggleSource(inputs[nextIndex].dataset.id, true, true, true);
  }
});
const actions = {
  open: () => elements.open.click(),
  save: () => {
    if (elements.save.getAttribute('aria-disabled') === 'false')
      elements.save.click();
  },
  find: () => {
    if (!elements.search.disabled) {
      elements.search.focus();
      elements.search.select();
    }
  },
  merge: () => elements.merge.click(),
  undo: () => historyAction('undo'),
  redo: () => historyAction('redo'),
  selectAll: () => selectAll(true),
  clearSelection: () => selectAll(false),
  clearSearch: () => {
    if (elements.search.value) {
      elements.search.value = '';
      render({ previousTarget: elements.target.value, clearSelection: false });
    } else elements['source-list'].focus();
  },
};
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  const target = event.target;
  const editable =
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    (target instanceof HTMLInputElement &&
      !['checkbox', 'radio', 'button', 'file'].includes(target.type));
  const action = shortcutAction(event, {
    editable,
    search: target === elements.search,
    select: target instanceof HTMLSelectElement,
  });
  if (!action || (action === 'find' && !catalogs)) return;
  event.preventDefault();
  if (!busy) actions[action]();
});
const primary = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
for (const [id, title] of Object.entries({
  open: `開く (${primary}+O)`,
  save: `名前を付けて保存 (${primary}+S / ${primary}+Shift+S)`,
  search: `検索 (${primary}+F)`,
  merge: `統合 (${primary}+Enter)`,
  undo: `元に戻す (${primary}+Z)`,
  redo: `やり直す (${primary}+Shift+Z / ${primary}+Y)`,
}))
  elements[id].title = title;
window.addEventListener('beforeunload', (event) => {
  if (isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
update();
