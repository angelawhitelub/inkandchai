/**
 * DTDC customer-portal bulk consignment upload (Bulk Upload -> sample-consignment-upload.xlsx).
 *
 * COLUMNS is the template's header row, verbatim and in order (192 columns,
 * sheet "consignment"); the portal maps them by name, so a renamed or missing
 * header is a rejected file. QUESTION_COLUMNS is the header of the second
 * sheet, "questions", which the template carries and we leave empty.
 *
 * toDtdcRow() takes an order already projected by woo-channel's toWooOrder --
 * the same address parsing, phone check and money rules every other courier
 * path uses -- and fills the columns the portal needs for a domestic B2C
 * parcel. Everything else stays blank.
 *
 * Values that are not obvious, and where they came from:
 *   Client Code     GL22082, the portal login (DTDC_CLIENT_CODE overrides)
 *   Service Type    B2C SMART EXPRESS, the account's default service in its
 *                   WooCommerce integration form
 *   Content Type    73, the commodity id that form sends for books
 *                   (["PAPER_BASED_MATERIAL", "73"]; the portal keeps the last)
 *   Cod Mode        cash
 * COD Amount is the collectable only: blank for prepaid and replacement
 * orders, the BALANCE for partial COD (the advance is never collected twice).
 */

const COLUMNS = [
  'Unique_Id', 'Client Code', 'Consignment Number', 'Customer Reference Number', 'Service Type',
  'Courier Type', 'Declared Price (non-document)', 'Number of Pieces (non-document)',
  'Risk Surcharge (YES/NO) (non-document)', 'Weight(KG) (non-document)',
  'Length(cm) (non-document)', 'Width(cm) (non-document)', 'Height(cm) (non-document)',
  'Origin Pincode', 'Origin Name', 'Origin Phone', 'Origin Address Line 1',
  'Origin Address Line 2', 'Origin City', 'Origin State', 'Destination Pincode',
  'Destination Name', 'Destination Phone', 'Destination Address Line 1',
  'Destination Address Line 2', 'Destination City', 'Destination State', 'Product Code',
  'Eway Bill', 'Content Type', 'Consignment Type', 'Cod Amount', 'In Favor Of', 'Cod Mode',
  'Description', 'Return Reason', 'Origin Country', 'Destination Country', 'Destination Latitude',
  'Destination Longitude', 'Destination Address Email', 'Return Name', 'Return Address Line 1',
  'Return Address Line 2', 'Return Pincode', 'Return Phone', 'Return Alternate Phone',
  'Return City', 'Return State', 'Return Country', 'Return Email', 'Exceptional RTO Name',
  'Exceptional RTO Address Line 1', 'Exceptional RTO Address Line 2', 'Exceptional RTO Pincode',
  'Exceptional RTO Phone', 'Exceptional RTO Alternate Phone', 'Exceptional RTO City',
  'Exceptional RTO State', 'Exceptional RTO Country', 'Type Of Delivery',
  'Consignor Alternate Phone', 'Inco Terms', 'Shipment Purpose', 'Movement Type',
  'Pickup Start Time (HH:MM)', 'Pickup End Time (HH:MM)', 'Pickup Service Time (Mins)',
  'Delivery Start Time (HH:MM)', 'Delivery End Time (HH:MM)', 'Delivery Service Time (Mins)',
  'Origin Address Email', 'ALT DEL 1 Name', 'ALT DEL 1 Address Line 1', 'ALT DEL 1 Address Line 2',
  'ALT DEL 1 Pincode', 'ALT DEL 1 Phone', 'ALT DEL 1 Alternate Phone', 'ALT DEL 1 City',
  'ALT DEL 1 State', 'ALT DEL 1 Country', 'ALT DEL 2 Name', 'ALT DEL 2 Address Line 1',
  'ALT DEL 2 Address Line 2', 'ALT DEL 2 Pincode', 'ALT DEL 2 Phone', 'ALT DEL 2 Alternate Phone',
  'ALT DEL 2 City', 'ALT DEL 2 State', 'ALT DEL 2 Country', 'REDIRECT Name',
  'REDIRECT Address Line 1', 'REDIRECT Address Line 2', 'REDIRECT Pincode', 'REDIRECT Phone',
  'REDIRECT Alternate Phone', 'REDIRECT City', 'REDIRECT State', 'REDIRECT Country',
  'Pay Basis LTL', 'Pickup Hub Code', 'Consignee Alternate Phone', 'Sender Partner Id',
  'Receiver Partner Id', 'Billing Address Pincode', 'Biller Name', 'Biller Phone',
  'Billing Address Line 1', 'Billing Address Line 2', 'Billing Address City',
  'Billing Address State', 'Billing Address Country', 'Billing Address Email',
  'Biller Alternate Phone', 'Delivery Instructions', 'Against Bond Lut', 'ECom Shipment', 'RoDTEP',
  'IORI Number', 'EORI Number', 'Freight Cost', 'Freight Cost Currency', 'FOB Value',
  'Insurance Value', 'Insurance Value Currency', 'FOB Value Currency', 'Total GST Paid Amount',
  'Total GST Paid Currency', 'Dimension Unit', 'Weight Unit', 'Invoice Number', 'Invoice Date',
  'Export Invoice Date', 'Consignor Kyc Doc Type', 'Consignor Kyc Doc Number',
  'Consignor Kyc Front Image', 'Consignor Kyc Back Image', 'Invoice Type', 'Is Battery',
  'Consignor Company Name', 'Consignee Company Name', 'Sender Type', 'consignor IEC Number',
  'consignor PAN Id', 'consignor Tax Id', 'Destination Type', 'NEFI flag', 'Currency',
  'Customer Seller Code', 'Consignor GSTIN Number', 'Cess Value', 'Sender CPC Code',
  'Sender Bank Account No.', 'Sender Bank AD Code', 'Sender Bank Name', 'Sender Bank IFSC Code',
  'EOR Details', 'IOR Details', 'Receiver VAT Number', 'Shipment Terms', 'Retail Transaction',
  'Cash On Pickup Amount', 'Prepaid Amount', 'Risk Surcharge Type', 'Origin W3W Code',
  'Destination W3W Code', 'Consignor Pincode', 'Consignor Name', 'Consignor Phone',
  'Consignor Address Line 1', 'Consignor Address Line 2', 'Consignor City', 'Consignor State',
  'Consignor Country', 'Consignor Email', 'SRF Number', 'Fulfillment Id', 'HSN Code', 'Pickup KYC',
  'Pickup Eway Bill', 'Pickup Commercial Other Docs', 'Consignor Code', 'Origin Address Id',
  'Return Address Id', 'Exceptional Return Address Id', 'Registered Business', 'Consignee GSTIN',
  'FOD Amount', 'FOD Mode', 'FOD Favor Of', 'IS RVP QC', 'Packaging Material Code',
];

const QUESTION_COLUMNS = [
  'Question Code', 'Mandatory Pass', 'Reference Number', 'Reference Image List', 'Correct Answer',
  'Option 1', 'Option 2', 'Option 3', 'Option 4', 'Image Capture Mandatory', 'Instruction',
  'Placeholder',
];

// The pickup address registered in the DTDC portal (Settings -> Addresses).
function pickup(env = process.env) {
  return {
    name: env.DTDC_PICKUP_NAME || 'INK AND CHAI',
    phone: env.DTDC_PICKUP_PHONE || '9625836117',
    line1: env.DTDC_PICKUP_ADDRESS1 || '2969, KUCHA MAI DASS',
    line2: env.DTDC_PICKUP_ADDRESS2 || 'SITARAM BAZAR',
    city: env.DTDC_PICKUP_CITY || 'DELHI',
    state: env.DTDC_PICKUP_STATE || 'DELHI',
    pincode: env.DTDC_PICKUP_PINCODE || '110006',
  };
}

/** Two address lines of at most `max` characters, split on a comma or space. */
function splitAddress(text, max = 100) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return [s, ''];
  let cut = s.lastIndexOf(', ', max);
  if (cut < max / 2) cut = s.lastIndexOf(' ', max);
  if (cut < max / 2) cut = max;
  return [s.slice(0, cut).replace(/[,\s]+$/, ''), s.slice(cut).replace(/^[,\s]+/, '').slice(0, max)];
}

const meta = (w, key) => (w.meta_data || []).find((m) => m.key === key)?.value;

const istDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(iso ? new Date(iso) : new Date());

/** One upload row (an array in COLUMNS order) for a toWooOrder() projection. */
function toDtdcRow(w, { env = process.env } = {}) {
  const from = pickup(env);
  const to = w.shipping;
  const [dst1, dst2] = splitAddress(to.address_1);
  const orderValue = Math.round(Number(meta(w, '_iac_order_value') || w.total || 0));
  const collect = Math.round(Number(meta(w, '_iac_collectable') || 0));
  const isCod = w.payment_method === 'cod' && collect > 0;
  const description = (w.line_items || [])
    .map((l) => `${l.quantity > 1 ? `${l.quantity} x ` : ''}${l.name}`).join('; ').slice(0, 250);

  const v = {
    Unique_Id: w.number,
    'Client Code': env.DTDC_CLIENT_CODE || 'GL22082',
    'Customer Reference Number': w.number,
    'Service Type': env.DTDC_SERVICE_TYPE || 'B2C SMART EXPRESS',
    'Courier Type': 'NON-DOCUMENT',
    'Declared Price (non-document)': String(orderValue),
    'Number of Pieces (non-document)': '1',
    'Risk Surcharge (YES/NO) (non-document)': 'NO',
    'Weight(KG) (non-document)': env.DTDC_WEIGHT_KG || '0.4',
    'Length(cm) (non-document)': '15',
    'Width(cm) (non-document)': '10',
    'Height(cm) (non-document)': '5',
    'Origin Pincode': from.pincode,
    'Origin Name': from.name,
    'Origin Phone': from.phone,
    'Origin Address Line 1': from.line1,
    'Origin Address Line 2': from.line2,
    'Origin City': from.city,
    'Origin State': from.state,
    'Origin Country': 'India',
    'Destination Pincode': to.postcode,
    'Destination Name': `${to.first_name} ${to.last_name}`.trim(),
    'Destination Phone': to.phone,
    'Destination Address Line 1': dst1,
    'Destination Address Line 2': dst2,
    'Destination City': to.city,
    'Destination State': to.state,
    'Destination Country': 'India',
    'Destination Address Email': w.billing?.email || '',
    'Content Type': env.DTDC_COMMODITY_ID || '73',
    'Cod Amount': isCod ? String(collect) : '',
    'Cod Mode': isCod ? 'cash' : '',
    Description: description,
    'Return Name': from.name,
    'Return Address Line 1': from.line1,
    'Return Address Line 2': from.line2,
    'Return Pincode': from.pincode,
    'Return Phone': from.phone,
    'Return City': from.city,
    'Return State': from.state,
    'Return Country': 'India',
    'Movement Type': 'forward',
    'Dimension Unit': 'CM',
    'Weight Unit': 'KG',
    'Invoice Number': w.number,
    'Invoice Date': istDate(w.date_created ? `${w.date_created}Z` : null),
  };
  for (const k of Object.keys(v)) if (!COLUMNS.includes(k)) throw new Error(`dtdc-upload: unknown column ${k}`);
  return { row: COLUMNS.map((c) => (v[c] == null ? '' : v[c])), cod: isCod, collect, orderValue };
}

module.exports = { COLUMNS, QUESTION_COLUMNS, toDtdcRow, splitAddress, pickup };
