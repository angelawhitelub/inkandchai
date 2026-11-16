// A small JSON document with a revision number, for admin data that is
// read-modified-written in quick succession (the reading lists). Workers KV
// reads can be up to 60 s stale, so two saves a few seconds apart there could
// silently undo each other; that is how 4 freshly written reading lists
// vanished on 2026-11-17. A Durable Object is single-threaded and strongly
// consistent, and `put` refuses a write made from an out-of-date read.
//
// POST { op: 'get' }                     -> { value, rev }        (value null, rev 0 when empty)
// POST { op: 'put', value, ifRev }       -> { rev } | 409 { rev } when ifRev is not the current rev
export class DocStore {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    return this.ctx.blockConcurrencyWhile(async () => {
      const rev = (await this.ctx.storage.get('rev')) || 0;
      if (body.op === 'get') {
        return Response.json({ value: (await this.ctx.storage.get('value')) ?? null, rev });
      }
      if (body.op === 'put') {
        if (Number(body.ifRev) !== rev) return Response.json({ rev }, { status: 409 });
        await this.ctx.storage.put({ value: body.value, rev: rev + 1 });
        return Response.json({ rev: rev + 1 });
      }
      return Response.json({ error: 'op must be get or put' }, { status: 400 });
    });
  }
}
