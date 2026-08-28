import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'PrivAgent',
  version: '0.1.0',
  description: 'Privacy-preserving AI browser agent for the SIH project.',
  permissions: ['storage', 'activeTab', 'scripting'],
  host_permissions: ['http://*/*', 'https://*/*'],
  background: {
    service_worker: 'extension/src/background/index.ts',
    type: 'module',
  },
  action: {
    default_title: 'PrivAgent',
    default_popup: 'extension/src/sidepanel/index.html',
    // default_icon: {
    //   '16': 'icons/icon-16.png',
    //   '48': 'icons/icon-48.png',
    //   '128': 'icons/icon-128.png',
    // },
  },
  side_panel: {
    default_path: 'extension/src/sidepanel/index.html',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['extension/src/content/index.js'],
      run_at: 'document_idle',
    },
  ],
  // icons: {
  //   '16': 'icons/icon-16.png',
  //   '48': 'icons/icon-48.png',
  //   '128': 'icons/icon-128.png',
  // },
});
