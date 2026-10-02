const { randomUUID } = require('node:crypto');
const bindings = require('../../../worker/shims/runtime-bindings');
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const duplicate = () => fail(409, 'A replacement or missing-book request already exists for this order. Contact support about the existing request.');
function evidence(photos) {
  if (!Array.isArray(photos) || photos.length < 1 || photos.length > 3)
    throw fail(400, 'Attach 1–3 clear photos of the parcel, shipping label and received books as evidence.');
  return photos.map(value => {
    const match = typeof value === 'string' && value.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
    if (!match || match[3].length > 2666668) throw fail(400, 'Use JPEG, PNG or WebP photos, up to 2 MB each.');
    const bytes = Buffer.from(match[3], 'base64'), type = match[2].toLowerCase();
    const valid = type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : type === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
    if (!valid || bytes.length < 200 || bytes.length > 2000000) throw fail(400, 'One of the photos is invalid. Choose a valid image up to 2 MB.');
    return { bytes, type, contentType: match[1].toLowerCase() };
  });
}
async function beginClaim(sb, order, photos, { allowRecordedReport = false } = {}) {
  const images = evidence(photos);
  if (order.source === 'replacement') throw duplicate();
  const namespace = bindings.get('CUSTOMER_CLAIMS');
  if (!namespace) throw fail(503, 'Request checking is temporarily unavailable. Please try again shortly.');
  const stub = namespace.get(namespace.idFromName(String(order.razorpay_order_id || order.id)));
  const token = randomUUID();
  const action = async action => {
    const response = await stub.fetch('https://claims.internal/', { method:'POST', body:JSON.stringify({ action, token }) });
    if (!response.ok) throw fail(503, 'Could not check this request. Please try again shortly.');
    return (await response.json()).allowed;
  };
  if (!await action('reserve')) throw duplicate();
  try {
    const fresh = await sb.from('orders').select('cart_items').eq('id',order.id).single();
    if (fresh.error || !fresh.data) throw fail(503, 'Could not verify the order. Please try again.');
    if (!allowRecordedReport && (fresh.data.cart_items || []).some(i => i._missing)) throw duplicate();
    const prior = await sb.from('orders').select('razorpay_order_id').eq('source','replacement')
      .eq('cart_items->0->_replacement->>original_order_id',String(order.razorpay_order_id || order.id)).limit(1);
    if (prior.error) throw fail(503, 'Could not check previous requests. Please try again.');
    if (prior.data?.length) throw duplicate();
    const urls = [];
    for (const image of images) {
      const path = `replacement-photos/${token}-${urls.length}.${image.type === 'jpeg' ? 'jpg' : image.type}`;
      const bucket = sb.storage.from('product-images');
      const result = await bucket.upload(path,image.bytes,{contentType:image.contentType,upsert:false});
      if (result.error) throw fail(503, 'Photo upload failed. No request was created. Please try again.');
      const url = bucket.getPublicUrl(path).data?.publicUrl;
      if (!url) throw fail(503, 'Could not save the photo evidence. Please try again.');
      urls.push(url);
    }
    return { photos:urls, complete:()=>action('complete'), release:()=>action('release') };
  } catch (error) { await action('release'); throw error; }
}
module.exports = { evidence, beginClaim };
