// TYPE into ARIA/contenteditable editors (Gmail compose, docs editors):
// the collector reports contenteditable divs and planners may target them,
// so the executor must handle them instead of returning UNSUPPORTED.
import { expect, openTestPage, test } from './fixtures';

const EDITOR_PAGE = `<!doctype html>
<html><body>
  <div id="editor" contenteditable="true" role="textbox" aria-label="Compose"></div>
</body></html>`;

test('TYPE appends into a contenteditable editor via the real content script', async ({
  extContext,
  panel,
}) => {
  const page = await openTestPage(extContext, EDITOR_PAGE);
  await page.bringToFront();
  const res = await panel.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'EXECUTE_ACTION',
      action: { action: 'TYPE', target: '#editor', value: 'hello world' },
    }),
  );
  expect(res).toMatchObject({ ok: true, code: 'OK' });
  await expect(page.locator('#editor')).toContainText('hello world');
});
