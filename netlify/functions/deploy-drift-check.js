/**
 * Alert when the live site stops matching main.
 *
 * On 30 Aug 2026 production was overwritten by `netlify deploy` run from a
 * laptop checkout on an old branch with uncommitted changes. The deploy carried
 * no commit reference, so the dashboard showed a normal green deploy while the
 * site had actually rolled back weeks of work: the admin panel lost its
 * Coupons, Profit, NP-Cancelled and print-item-list features, and checkout lost
 * WhatsApp consent capture. Nobody noticed for a day, and only then because a
 * button was missing.
 *
 * A rollback that announces itself is a bad afternoon. One that does not is a
 * bad week, because every later fix is written against code the site is not
 * running. This compares what is actually served against GitHub's main and says
 * so out loud.
 *
 * It reads the live /build-info.json rather than the Netlify API on purpose:
 * the question is not "what did the last build think it built", it is "what is
 * being served right now".
 */
const SITE = process.env.URL || 'https://inkandchai.in';
const REPO = process.env.GITHUB_REPO || 'angelawhitelub/inkandchai';
const BRANCH = process.env.DEPLOY_BRANCH || 'main';
// A deploy takes a few minutes, and a push during that window is not drift.
const GRACE_MINUTES = Number(process.env.DEPLOY_DRIFT_GRACE_MINUTES || 30);

async function liveBuildInfo() {
  const res = await fetch(`${SITE}/build-info.json?_=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
  if (res.status === 404) return null;          // deploy predates the stamp
  if (!res.ok) throw new Error(`build-info.json returned HTTP ${res.status}`);
  return res.json();
}

async function mainHead() {
  const headers = { 'User-Agent': 'inkandchai-deploy-drift', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  const data = await res.json();
  return { sha: String(data.sha || ''), committed_at: data?.commit?.committer?.date || '' };
}

/**
 * Plain WhatsApp text to the owner, matching how nimbuspost-webhook already
 * raises operational alerts — no template approval needed, and it reuses the
 * number already configured for the shop.
 */
async function alertOwner(text) {
  const ownerPhone = process.env.STORE_OWNER_PHONE;
  const token = process.env.WHATSAPP_TOKEN;
  if (!ownerPhone || !token) {
    console.warn('[deploy-drift] no STORE_OWNER_PHONE/WHATSAPP_TOKEN — alert logged only');
    return;
  }
  const phoneId = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
  const to = ownerPhone.replace(/\D/g, '').replace(/^0/, '91').replace(/^(\d{10})$/, '91$1');
  try {
    await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 3500) } }),
    });
  } catch (err) {
    console.error('[deploy-drift] could not send the alert:', err.message);
  }
}

exports.handler = async () => {
  const report = (ok, detail) => ({ statusCode: 200, body: JSON.stringify({ ok, ...detail }) });
  let live;
  let head;
  try {
    [live, head] = await Promise.all([liveBuildInfo(), mainHead()]);
  } catch (err) {
    // A check that cannot run is not a drift finding; say so and stay quiet.
    console.warn('[deploy-drift] could not check:', err.message);
    return report(true, { skipped: err.message });
  }

  const problems = [];
  if (!live) {
    problems.push('The live site is serving a deploy with no build stamp, which means it was not built from this repository.');
  } else {
    if (live.branch && live.branch !== BRANCH) problems.push(`Live was built from branch "${live.branch}", not ${BRANCH}.`);
    if (!live.commit) problems.push('Live carries a build stamp with no commit — a hand-made deploy.');
    else if (live.commit !== head.sha) {
      // Only complain once the push has had time to deploy.
      const pushedAgo = (Date.now() - new Date(head.committed_at || Date.now()).getTime()) / 60000;
      if (pushedAgo > GRACE_MINUTES) {
        problems.push(`Live is on ${live.commit.slice(0, 10)}; ${BRANCH} is on ${head.sha.slice(0, 10)} (pushed ${Math.round(pushedAgo)} min ago).`);
      }
    }
  }

  if (!problems.length) return report(true, { live_commit: live?.commit?.slice(0, 10), head: head.sha.slice(0, 10) });

  const message = `⚠️ Live site does not match ${BRANCH}\n${problems.join('\n')}\nFix: push to ${BRANCH}, or re-run the last ${BRANCH} deploy from the Netlify dashboard.`;
  console.error('[deploy-drift]', message.replace(/\n/g, ' '));
  await alertOwner(message);
  return report(false, { problems, live_commit: live?.commit || null, head: head.sha });
};
