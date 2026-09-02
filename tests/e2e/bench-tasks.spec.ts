// M7 — e2e: PrivAgent-Bench task success rate measured in the REAL extension.
//
// The four DOM-feasible non-credential page families (blueprint §10) each carry the
// same planted synthetic values the unit-level bench uses. The deterministic planner
// must complete each task through the full local pipeline. Credential-bearing pages
// are intentionally NOT driven: the policy layer blocks them fail-closed (verified in
// the bench suite).

import { expect, test } from './fixtures';
import { openTestPage } from './fixtures';


// The bench tasks are a MEASUREMENT run, not a parallel stress test: serial execution
// keeps the loop's message relays deterministic under container load.
test.describe.configure({ mode: 'serial' });

const CANARY_EMAIL = 'BENCH_EMAIL_001@example.test';
const CANARY_PHONE = '555-010-0003';
const CANARY_NAME = 'Bench User One';

function formPage(intro: string, fields: string[], submitLabel = 'Submit'): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <p>${intro}</p>
    <form>
      ${fields.join('\n')}
      <button id="submit" type="button">${submitLabel}</button>
    </form>
    <script>
      document.getElementById('submit').addEventListener('click', () => {
        document.body.dataset.submitted = 'true';
        document.getElementById('submit').disabled = true;
      });
    </script>
  </body></html>`;
}

const input = (id: string, type: string, label: string) =>
  `<label for="${id}">${label}</label><input id="${id}" type="${type}" placeholder="${label}">`;

const PAGES: { id: string; task: string; html: string; filled: Record<string, string> }[] = [
  {
    id: 'registration-easy',
    task: 'fill the form with my details and submit',
    html: formPage(
      `Create your account — Contact ${CANARY_EMAIL} · Phone 555-010-0001 · Name: ${CANARY_NAME}`,
      [
        input('name', 'text', 'Full name'),
        input('email', 'email', 'Email'),
        input('phone', 'tel', 'Phone'),
      ],
    ),
    filled: { name: CANARY_NAME, email: CANARY_EMAIL, phone: '555-010-0001' },
  },
  {
    id: 'booking-medium',
    task: 'fill the traveller contact details and submit',
    html: formPage(
      `Booking reference PNR-445566 — Traveller name: Bench User One, contact ${CANARY_EMAIL}, mobile ${CANARY_PHONE}`,
      [
        input('contact_email', 'email', 'Contact email'),
        input('contact_phone', 'tel', 'Mobile number'),
        input('contact_name', 'text', 'Traveller name'),
      ],
      'Submit',
    ),
    filled: {
      contact_email: CANARY_EMAIL,
      contact_phone: CANARY_PHONE,
      contact_name: CANARY_NAME,
    },
  },
  {
    id: 'college-admin-medium',
    task: 'fill the student contact details and submit',
    html: formPage(
      'Semester registration — Student mail BENCH_EMAIL_004@example.test · Guardian phone 555-010-0004 · Fee due ₹18,500',
      [input('student_email', 'email', 'Student mail'), input('guardian_phone', 'tel', 'Guardian phone')],
    ),
    filled: {
      student_email: 'BENCH_EMAIL_004@example.test',
      guardian_phone: '555-010-0004',
    },
  },
  {
    id: 'banking-hard',
    task: 'fill the statement delivery email and submit',
    html: formPage(
      'Statement preferences — Delivery to BENCH_EMAIL_007@example.test · Statement fee ₹99 · Ledger ref LEDGER-778899',
      [input('delivery_email', 'email', 'Delivery email')],
    ),
    filled: { delivery_email: 'BENCH_EMAIL_007@example.test' },
  },
];

for (const page of PAGES) {
  test(`bench task: ${page.id}`, async ({ extContext, panel }) => {
    const tab = await openTestPage(extContext, page.html);
    await panel.getByPlaceholder(/fill the form/).fill(page.task);
    // Same invariant as agent-task.spec: the web page, not the panel tab, must be active.
    await tab.bringToFront();
    await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');

    const result = panel.getByTestId('agent-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Task completed');

    for (const [selector, value] of Object.entries(page.filled)) {
      await expect(tab.locator(`#${selector}`)).toHaveValue(value);
    }
    expect(await tab.locator('body').getAttribute('data-submitted')).toBe('true');
  });
}
