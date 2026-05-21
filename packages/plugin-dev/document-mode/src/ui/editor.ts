/**
 * Document-Mode editor — runs inside the plugin iframe.
 *
 * Mounts TipTap on #editor-root, loads/saves the current work context's
 * ProseMirror JSON via PluginAPI.persistDataSynced, and keeps task references
 * in sync with the host task cache via ANY_TASK_UPDATE.
 */

import { Editor, Node, mergeAttributes } from '@tiptap/core';
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  PluginHooks,
  type ActiveWorkContext,
  type AnyTaskUpdatePayload,
  type PluginAPI,
  type Task,
  type WorkContextChangePayload,
} from '@super-productivity/plugin-api';

declare const PluginAPI: PluginAPI;

const SAVE_DEBOUNCE_MS = 5_000;
const STORAGE_VERSION = 1;

interface StoredState {
  version: number;
  docs: Record<string, unknown>; // ctxId -> ProseMirror JSON
  // We don't model enabledCtxIds here — the background script owns it. The
  // editor preserves whatever fields it doesn't recognize via
  // read-modify-write at save time.
  [key: string]: unknown;
}

let currentCtx: ActiveWorkContext | null = null;
let storedState: StoredState = { version: STORAGE_VERSION, docs: {} };
let taskCache = new Map<string, Task>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let editor: Editor | null = null;
let isLoadingDoc = false;

/* -------------------------------------------------------------------------- */
/* taskRef node                                                                */
/* -------------------------------------------------------------------------- */

const TaskRefNode = Node.create({
  name: 'taskRef',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      taskId: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-task-ref]',
        getAttrs: (el: HTMLElement | string): { taskId: string } | false => {
          if (typeof el === 'string') return false;
          const taskId = el.getAttribute('data-task-id') || '';
          return { taskId };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-task-ref': '',
        'data-task-id': HTMLAttributes.taskId as string,
        class: 'task-ref',
      }),
    ];
  },
  addNodeView() {
    return ({ node, getPos, editor: viewEditor }: NodeViewRendererProps) => {
      const dom = document.createElement('div');
      dom.className = 'task-ref';
      dom.dataset.taskRef = '';
      dom.dataset.taskId = node.attrs.taskId;
      dom.contentEditable = 'false';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const title = document.createElement('span');
      title.className = 'title';

      const render = (): void => {
        const taskId = node.attrs.taskId as string;
        const task = taskCache.get(taskId);
        if (!task) {
          dom.classList.add('is-missing');
          dom.classList.remove('is-done');
          checkbox.checked = false;
          checkbox.disabled = true;
          title.textContent = '(task not found)';
        } else {
          dom.classList.remove('is-missing');
          dom.classList.toggle('is-done', !!task.isDone);
          checkbox.checked = !!task.isDone;
          checkbox.disabled = false;
          title.textContent = task.title || '(untitled)';
        }
      };

      checkbox.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const taskId = node.attrs.taskId as string;
        const task = taskCache.get(taskId);
        if (!task) return;
        const next = !task.isDone;
        PluginAPI.updateTask(taskId, { isDone: next }).catch((err) => {
          PluginAPI.log.err('updateTask failed', err);
        });
        // Optimistic update so the UI feels snappy.
        taskCache.set(taskId, { ...task, isDone: next });
        render();
      });

      dom.addEventListener('click', (ev) => {
        // Click on chip body (not checkbox) → select the node so user can
        // delete with backspace. Full task panel integration is v2.
        if (ev.target === checkbox) return;
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos === null || pos === undefined) return;
        viewEditor.commands.setNodeSelection(pos);
      });

      dom.appendChild(checkbox);
      dom.appendChild(title);
      render();

      return {
        dom,
        update: (updatedNode: ProseMirrorNode): boolean => {
          if (updatedNode.type.name !== 'taskRef') return false;
          if (updatedNode.attrs.taskId !== node.attrs.taskId) return false;
          render();
          return true;
        },
      };
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

const readBlob = async (): Promise<StoredState> => {
  try {
    const raw = await PluginAPI.loadSyncedData();
    if (!raw) return { version: STORAGE_VERSION, docs: {} };
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed && typeof parsed === 'object') {
      return {
        ...parsed,
        version: parsed.version || STORAGE_VERSION,
        docs: parsed.docs || {},
      };
    }
  } catch (err) {
    PluginAPI.log.err('Failed to parse stored doc state', err);
  }
  return { version: STORAGE_VERSION, docs: {} };
};

const loadStoredState = async (): Promise<void> => {
  storedState = await readBlob();
};

const flushSave = async (): Promise<void> => {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!currentCtx || !editor) return;
  // Read-modify-write: pull the latest blob from storage so we don't clobber
  // the background script's enabledCtxIds or any other field added later.
  try {
    const latest = await readBlob();
    const merged: StoredState = {
      ...latest,
      docs: { ...latest.docs, [currentCtx.id]: editor.getJSON() },
    };
    storedState = merged;
    await PluginAPI.persistDataSynced(JSON.stringify(merged));
  } catch (err) {
    PluginAPI.log.err('persistDataSynced failed', err);
  }
};

const scheduleSave = (): void => {
  if (isLoadingDoc) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSave();
  }, SAVE_DEBOUNCE_MS);
};

/* -------------------------------------------------------------------------- */
/* Seed doc + task cache                                                       */
/* -------------------------------------------------------------------------- */

const buildSeedDoc = (ctx: ActiveWorkContext): unknown => {
  const taskNodes = ctx.taskIds.map((taskId) => ({
    type: 'taskRef',
    attrs: { taskId },
  }));
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: ctx.title }],
      },
      ...taskNodes,
      { type: 'paragraph' },
    ],
  };
};

const refreshTaskCache = async (): Promise<void> => {
  try {
    const tasks = await PluginAPI.getTasks();
    taskCache = new Map(tasks.map((t) => [t.id, t]));
  } catch (err) {
    PluginAPI.log.err('getTasks failed', err);
  }
};

const setActiveContext = async (ctx: ActiveWorkContext | null): Promise<void> => {
  // Save previous ctx before switching.
  await flushSave();

  currentCtx = ctx;
  if (!ctx || !editor) return;

  isLoadingDoc = true;
  await refreshTaskCache();

  const stored = storedState.docs[ctx.id];
  const docJson = stored ?? buildSeedDoc(ctx);
  try {
    editor.commands.setContent(
      docJson as Parameters<typeof editor.commands.setContent>[0],
      false,
    );
  } catch (err) {
    PluginAPI.log.err('setContent failed, seeding fresh', err);
    editor.commands.setContent(
      buildSeedDoc(ctx) as Parameters<typeof editor.commands.setContent>[0],
      false,
    );
  }
  isLoadingDoc = false;
};

/* -------------------------------------------------------------------------- */
/* Task sync                                                                   */
/* -------------------------------------------------------------------------- */

const collectTaskRefIds = (): Set<string> => {
  const ids = new Set<string>();
  if (!editor) return ids;
  editor.state.doc.descendants((node: ProseMirrorNode): boolean | undefined => {
    if (node.type.name === 'taskRef' && node.attrs.taskId) {
      ids.add(node.attrs.taskId as string);
    }
    return undefined;
  });
  return ids;
};

const appendMissingTask = (taskId: string): void => {
  if (!editor) return;
  const refs = collectTaskRefIds();
  if (refs.has(taskId)) return;
  const endPos = editor.state.doc.content.size;
  editor
    .chain()
    .focus(endPos)
    .insertContentAt(endPos, { type: 'taskRef', attrs: { taskId } })
    .run();
};

const onAnyTaskUpdate = (payload: AnyTaskUpdatePayload): void => {
  if (!currentCtx || !editor) return;
  void refreshTaskCache().then(() => {
    // Force node-views to re-render with new title/done state.
    if (editor) {
      const tr = editor.state.tr.setMeta('taskRefRefresh', true);
      editor.view.dispatch(tr);
    }
  });

  // If a new task was added to the active project/today list, append a ref.
  if (payload.task && payload.taskId) {
    const inProject =
      currentCtx.type === 'PROJECT' && payload.task.projectId === currentCtx.id;
    const inToday =
      currentCtx.id === 'TODAY' &&
      (payload.task.tagIds?.includes('TODAY') ||
        !!payload.task.dueDay ||
        !!payload.task.dueWithTime);
    if (inProject || inToday) {
      appendMissingTask(payload.taskId);
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Slash menu                                                                  */
/* -------------------------------------------------------------------------- */

interface SlashItem {
  label: string;
  action: () => void;
}

const buildSlashItems = (): SlashItem[] => {
  if (!editor) return [];
  const ed = editor;
  return [
    { label: 'Paragraph', action: () => ed.chain().focus().setParagraph().run() },
    {
      label: 'Heading 1',
      action: () => ed.chain().focus().setHeading({ level: 1 }).run(),
    },
    {
      label: 'Heading 2',
      action: () => ed.chain().focus().setHeading({ level: 2 }).run(),
    },
    {
      label: 'Heading 3',
      action: () => ed.chain().focus().setHeading({ level: 3 }).run(),
    },
    { label: 'Divider', action: () => ed.chain().focus().setHorizontalRule().run() },
    {
      label: 'New Task',
      action: async () => {
        if (!currentCtx) return;
        const taskId = await PluginAPI.addTask({
          title: 'New task',
          projectId: currentCtx.type === 'PROJECT' ? currentCtx.id : null,
        });
        await refreshTaskCache();
        ed.chain().focus().insertContent({ type: 'taskRef', attrs: { taskId } }).run();
      },
    },
  ];
};

let menuEl: HTMLDivElement | null = null;
let menuActiveIndex = 0;
let menuFilter = '';

const closeSlashMenu = (): void => {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
};

const renderSlashMenu = (anchorRect: DOMRect, items: SlashItem[]): void => {
  closeSlashMenu();
  if (items.length === 0) return;
  menuEl = document.createElement('div');
  menuEl.className = 'slash-menu';
  menuEl.style.top = `${anchorRect.bottom + 4}px`;
  menuEl.style.left = `${anchorRect.left}px`;
  items.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'slash-menu-item';
    if (idx === menuActiveIndex) el.classList.add('is-active');
    el.textContent = item.label;
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      closeSlashMenu();
      item.action();
    });
    menuEl!.appendChild(el);
  });
  document.body.appendChild(menuEl);
};

const showSlashMenu = (): void => {
  if (!editor) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  menuActiveIndex = 0;
  menuFilter = '';
  renderSlashMenu(rect, buildSlashItems());
};

const updateSlashMenu = (): void => {
  if (!menuEl || !editor) return;
  const items = buildSlashItems().filter((i) =>
    i.label.toLowerCase().includes(menuFilter.toLowerCase()),
  );
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  renderSlashMenu(rect, items);
};

/* -------------------------------------------------------------------------- */
/* Mount                                                                       */
/* -------------------------------------------------------------------------- */

const mount = async (): Promise<void> => {
  await loadStoredState();
  const initialCtx = await PluginAPI.getActiveWorkContext();

  const root = document.getElementById('editor-root');
  if (!root) {
    PluginAPI.log.err('Document mode: #editor-root not found');
    return;
  }

  editor = new Editor({
    element: root,
    extensions: [
      StarterKit.configure({
        // We keep dropcursor/gapcursor/history defaults.
      }),
      Placeholder.configure({
        placeholder: 'Type / for commands…',
      }),
      TaskRefNode,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: () => {
      scheduleSave();
    },
  });

  // Keydown handler — slash menu + nav.
  editor.view.dom.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (menuEl) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeSlashMenu();
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const items = buildSlashItems().filter((i) =>
          i.label.toLowerCase().includes(menuFilter.toLowerCase()),
        );
        if (items.length === 0) return;
        if (ev.key === 'ArrowDown') {
          menuActiveIndex = (menuActiveIndex + 1) % items.length;
        } else {
          menuActiveIndex = (menuActiveIndex - 1 + items.length) % items.length;
        }
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          renderSlashMenu(sel.getRangeAt(0).getBoundingClientRect(), items);
        }
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const items = buildSlashItems().filter((i) =>
          i.label.toLowerCase().includes(menuFilter.toLowerCase()),
        );
        if (items[menuActiveIndex]) {
          closeSlashMenu();
          items[menuActiveIndex].action();
        }
        return;
      }
      if (ev.key === 'Backspace') {
        menuFilter = menuFilter.slice(0, -1);
        if (menuFilter === '') {
          closeSlashMenu();
        } else {
          updateSlashMenu();
        }
        return;
      }
      if (ev.key.length === 1) {
        menuFilter += ev.key;
        updateSlashMenu();
        return;
      }
    } else if (ev.key === '/') {
      // Open menu on next tick (after the `/` is inserted).
      setTimeout(() => showSlashMenu(), 0);
    }
  });

  document.addEventListener('mousedown', (ev) => {
    if (menuEl && ev.target instanceof globalThis.Node && !menuEl.contains(ev.target)) {
      closeSlashMenu();
    }
  });

  await setActiveContext(initialCtx);

  // Subscribe to host events.
  PluginAPI.registerHook(PluginHooks.WORK_CONTEXT_CHANGE, (payload) => {
    void setActiveContext(payload as WorkContextChangePayload);
  });
  PluginAPI.registerHook(PluginHooks.ANY_TASK_UPDATE, (payload) => {
    onAnyTaskUpdate(payload as AnyTaskUpdatePayload);
  });

  window.addEventListener('pagehide', () => {
    void flushSave();
  });
};

/**
 * The host injects the PluginAPI <script> just before </body>. Depending on
 * how the blob iframe is parsed, our inlined editor.js may run before the
 * API script. Poll on a short interval until window.PluginAPI is set, then
 * mount.
 */
const waitForPluginAPI = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const check = (): void => {
      if (
        typeof (window as unknown as { PluginAPI?: unknown }).PluginAPI !== 'undefined'
      ) {
        resolve();
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });

void waitForPluginAPI().then(() => mount());
