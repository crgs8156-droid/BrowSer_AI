import { defineManifest } from '@crxjs/vite-plugin';

// PrivAgent MV3 manifest (M0 scaffold). Least-privilege: only the permissions the
// scaffold needs. Content script is scoped to localhost (benchmark pages) for now,
// NOT <all_urls>. Broaden deliberately in later milestones.
export default defineManifest({
  manifest_version: 3,
  name: 'PrivAgent',
  version: '0.0.0',
  description: 'Privacy-preserving AI browser agent (SIH 2026) — M0 scaffold.',
  action: {
    default_title: 'PrivAgent',
  },
  background: {
    service_worker: 'extension/src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['http://localhost/*', 'https://localhost/*'],
      js: ['extension/src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  side_panel: {
    default_path: 'extension/src/sidepanel/index.html',
  },
  permissions: ['sidePanel', 'storage', 'offscreen'],
  web_accessible_resources: [
    {
      resources: ['extension/src/offscreen/index.html'],
      matches: ['http://localhost/*', 'https://localhost/*'],
    },
  ],
});
