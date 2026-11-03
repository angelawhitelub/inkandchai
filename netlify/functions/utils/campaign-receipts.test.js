const test = require('node:test');
const assert = require('node:assert');
const R = require('./campaign-receipts');

const webhook = (...statuses) => ({ entry: [{ changes: [{ value: { statuses } }] }] });
const failed131049 = { id: 'wamid.A', status: 'failed', recipient_id: '919625836117', timestamp: '1793020700',
  errors: [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.', error_data: { details: 'In order to…' } }] };

function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    from() {
      const f = [];
      const q = {
        select: () => q, limit: () => q,
        eq: (c, v) => { f.push([c, v]); return q; },
        update: (patch) => ({ eq: (c, id) => { updates.push({ id, patch }); const row = rows.find((r) => r.id === id); Object.assign(row, patch); return Promise.resolve({ error: null }); } }),
        then: (res) => Promise.resolve({ data: rows.filter((r) => f.every(([c, v]) => (c === 'metadata->>wamid' ? r.metadata.wamid === v : r[c] === v))), error: null }).then(res),
      };
      return q;
    },
  };
}

test('a 131049 failure marks the ledger row failed with its code', async () => {
  const rows = [{ id: 7, customer_phone: '919625836117', status: 'sent', metadata: { wamid: 'wamid.A', source: 'new_title' } }];
  const db = fakeDb(rows);
  assert.strictEqual(await R.recordCampaignReceipts(db, webhook(failed131049)), 1);
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error, /^131049 — This message was not delivered/);
  assert.strictEqual(rows[0].metadata.meta_failed, true);
  assert.strictEqual(rows[0].metadata.failed_code, 131049);
  assert.strictEqual(rows[0].metadata.source, 'new_title', 'keeps the rest of the metadata');
});

test('delivered and read land on the row; a late delivered after read changes nothing', async () => {
  const rows = [{ id: 1, customer_phone: '911', status: 'sent', metadata: { wamid: 'w1' } }];
  const db = fakeDb(rows);
  const mk = (status) => ({ id: 'w1', status, recipient_id: '911', timestamp: '1793020700', pricing: { category: 'marketing' } });
  await R.recordCampaignReceipts(db, webhook(mk('read')));
  assert.ok(rows[0].metadata.read_at && rows[0].metadata.delivered_at);
  assert.strictEqual(await R.recordCampaignReceipts(db, webhook(mk('delivered'))), 0);
});

test('order/utility receipts are not looked up at all', async () => {
  let looked = 0;
  const db = { from() { looked++; return fakeDb([]).from(); } };
  await R.recordCampaignReceipts(db, webhook({ id: 'x', status: 'delivered', recipient_id: '91', pricing: { category: 'utility' } }, { id: 'y', status: 'sent', recipient_id: '91' }));
  assert.strictEqual(looked, 0);
});

test('an unknown wamid is ignored', async () => {
  const db = fakeDb([]);
  assert.strictEqual(await R.recordCampaignReceipts(db, webhook(failed131049)), 0);
  assert.strictEqual(db.updates.length, 0);
});

test('summarize counts each outcome once', () => {
  const s = R.summarize([
    { status: 'sent', metadata: { wamid: 'a', delivered_at: 't', read_at: 't' } },
    { status: 'sent', metadata: { wamid: 'b', delivered_at: 't' } },
    { status: 'sent', metadata: { wamid: 'c' } },
    { status: 'failed', metadata: { wamid: 'd', meta_failed: true, failed_code: 131049 } },
    { status: 'failed', metadata: {} },
  ]);
  assert.deepStrictEqual(s, { attempted: 5, accepted: 4, delivered: 2, read: 1, failed_by_meta: 1, failed_at_send: 1, waiting: 1, failed_codes: { 131049: 1 } });
});
