// One durable reservation per original order, shared by both customer forms.
export class ClaimGuard {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const { action, token } = await request.json();
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get('claim');
      let allowed = false;
      if (action === 'reserve') {
        if (!current || (!current.done && current.until < Date.now())) {
          await this.ctx.storage.put('claim', { token, until: Date.now() + 600000 });
          allowed = true;
        }
      } else if (current?.token === token && !current.done) {
        if (action === 'complete') await this.ctx.storage.put('claim', { token, done: true });
        else if (action === 'release') await this.ctx.storage.delete('claim');
        allowed = true;
      }
      return Response.json({ allowed });
    });
  }
}
