/**
 * Netlify Function: delhivery-status
 * POST /.netlify/functions/delhivery-status   { order_ids: ["IC-..."] }
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * Read-only. Asks Delhivery what it holds for our order references.
 *
 * This exists because create.json can fail with "Package might have been
 * partially saved" -- which is not a no-op and not a success. Retrying blind
 * after that message is how one sale becomes two parcels, so there has to be a
 * way to ask whether the shipment actually landed before anything is sent
 * again. It is also the only way to recover a waybill that was issued while
 * the write-back failed.
 */

const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const body = JSON.parse(event.body || '{}');
  const ids  = Array.isArray(body.order_ids) ? body.order_ids.filter(Boolean) : [];
  if (!ids.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_ids' }) };

  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'DELHIVERY_API_TOKEN not set' }) };
  const base = process.env.DELHIVERY_BASE || 'https://track.delhivery.com';

  const url = `${base}/api/v1/packages/json/?ref_ids=${encodeURIComponent(ids.join(','))}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'non-JSON from Delhivery', status: res.status, body: text.slice(0, 400) }) }; }

  const shipments = Array.isArray(data.ShipmentData) ? data.ShipmentData : [];
  const found = shipments.map((s) => {
    const sh = s.Shipment || {};
    return {
      ref:      sh.ReferenceNo,
      waybill:  sh.AWB,
      status:   sh.Status && sh.Status.Status,
      cod:      sh.CODAmount,
      pickup:   sh.PickUpDate,
      consignee: sh.Consignee && sh.Consignee.Name,
    };
  });

  return { statusCode: 200, headers: CORS, body: JSON.stringify({
    asked: ids, found_count: found.length, found,
    missing: ids.filter(i => !found.some(f => String(f.ref) === String(i))),
  }, null, 2) };
};
