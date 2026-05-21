/**
 * Document-Mode background script.
 * Runs once per plugin load in the host page context. Registers the
 * work-context header button; the actual editor lives in the iframe
 * (src/ui/editor.ts).
 */

import type { ActiveWorkContext, PluginAPI } from '@super-productivity/plugin-api';

declare const PluginAPI: PluginAPI;

PluginAPI.registerWorkContextHeaderButton({
  label: 'Document Mode',
  icon: 'description',
  showFor: ['PROJECT', 'TODAY'],
  onClick: (ctx: ActiveWorkContext) => {
    PluginAPI.log.log('Document mode toggled for', { id: ctx.id, type: ctx.type });
    PluginAPI.showInWorkContext();
  },
});
