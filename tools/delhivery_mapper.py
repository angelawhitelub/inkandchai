import csv
import pandas as pd
import tkinter as tk
from tkinter import filedialog, messagebox
import os
from datetime import datetime

# ============================================================
# Ink & Chai Orders → Delhivery Order Sample CSV Mapper
# v2 — supports both old (Items column) and new (Product(N)/SKU(N)/Qty(N)) export formats
# - Double-click to run (requires Python + pandas + openpyxl)
# - Pops up file selector to pick Ink & Chai orders CSV/XLSX
# - Auto-saves output to Downloads folder with unique timestamp
# ============================================================

DELHIVERY_COLS = [
    'Order ID*', 'Payment Type*', 'Collectable Amount', 'Tags',
    'Shipping First Name*', 'Shipping Last Name', 'Shipping Company Name',
    'Shipping Address 1*', 'Shipping Address 2', 'Shipping Phone Number*',
    'Shipping City*', 'Shipping State*', 'Shipping Pincode*',
    'Billing First Name', 'Billing Last Name', 'Billing Company Name',
    'Billing Address 1', 'Billing Address 2', 'Billing Phone Number',
    'Billing City', 'Billing State', 'Billing Pincode', 'Billing GST Number',
    'Weight(gm)', 'Length(cm)', 'Height(cm)', 'Breadth(cm)',
    'Shipping Charges', 'COD Charges', 'Tax Amount', 'Discount',
    'QC Check', 'Product Category ID', 'Used Product', 'Damaged Product',
    'Brand Name', 'Product Size', 'Product Color',
    'Product Ref Image1', 'Product Ref Image2', 'Product Ref Image3', 'Product Ref Image4',
    'Return Reason',
    'SKU(1)',  'Product(1)*',  'Quantity(1)*',  'Price(1)*',
    'SKU(2)',  'Product(2)*',  'Quantity(2)*',  'Price(2)*',
    'SKU(3)',  'Product(3)*',  'Quantity(3)*',  'Price(3)*',
    'SKU(4)',  'Product(4)*',  'Quantity(4)*',  'Price(4)*',
    'SKU(5)',  'Product(5)*',  'Quantity(5)*',  'Price(5)*',
    'SKU(6)',  'Product(6)*',  'Quantity(6)*',  'Price(6)*',
    'SKU(7)',  'Product(7)*',  'Quantity(7)*',  'Price(7)*',
    'SKU(8)',  'Product(8)*',  'Quantity(8)*',  'Price(8)*',
    'SKU(9)',  'Product(9)*',  'Quantity(9)*',  'Price(9)*',
    'SKU(10)', 'Product(10)*', 'Quantity(10)*', 'Price(10)*',
]

# ── Complete SKU map (title keyword → SKU) ────────────────────────────────────
# Longer / more-specific keys are checked first (sorted by length desc at runtime)
ITEM_SKU_MAP = {
    # Off Campus individual books
    'The Mistake by Elle Kennedy':                     'FICT-MISTAKE-EK-OC2',
    'Off Campus Series Book 2':                        'FICT-MISTAKE-EK-OC2',
    'The Score by Elle Kennedy':                       'FICT-SCORE-EK-OC3',
    'Off Campus Series Book 3':                        'FICT-SCORE-EK-OC3',
    'The Goal by Elle Kennedy':                        'FICT-GOAL-EK-OC4',
    'Off Campus Series Book 4':                        'FICT-GOAL-EK-OC4',
    'The Legacy by Elle Kennedy':                      'FICT-LEGACY-EK-OC5',
    'Off Campus Series Book 5':                        'FICT-LEGACY-EK-OC5',
    'The Deal | Off Campus':                           'FICT-DEAL-EK-OC1',
    'Off Campus Book 1':                               'FICT-DEAL-EK-OC1',
    # Off Campus combos
    'Off-Campus Series Complete Collection':           'OCS-COMPLETE',
    'Off-Campus Series Complete':                      'OCS-COMPLETE',
    'Off Campus Complete':                             'OCS-COMPLETE',
    'The Deal + The Mistake + The Score':              'OCS-COMBO-3',
    # Self-help combos
    'Atomic Habits + Psychology of Money + Ikigai':    'SH-ATOMIC-PSYMONEY-IKIGAI-COURAGE-4',
    'Atomic Habits + Rich Dad':                        'HI-BEST-5',
    '5 Hindi Bestsellers':                             'HI-BEST-5',
    'Hindi Motivation Big 4':                          'HI-MOTIV-4',
    'Psychology of Money in Hindi + Thinking Fast':    'HI-PSYMON-TFSLOW',
    'Shakti Ke 48 Niyam + Can':                        'HI-SHAKT-GOGG-3',
    'David Goggins Combo':                             'HI-GOGG-COMBO-2',
    'Stop letting Everything':                         'HI-STOP-AFFECT',
    'Stop Letting Everything':                         'HI-STOP-AFFECT',
    '$100M':                                           'HI-100M-COMBO-2',
    '100M Leads':                                      'HI-100M-COMBO-2',
    # Hindi individual books
    "Can't Hurt Me (Hindi)":                           'HI-CHM',
    'Cant Hurt Me (Hindi)':                            'HI-CHM',
    'Thinking, Fast and Slow (Hindi)':                 'HI-TFSLOW',
    'Thinking Fast and Slow (Hindi)':                  'HI-TFSLOW',
    'Never Finished (Hindi)':                          'HI-NEVFIN',
    'Hard Thing About Hard Things (Hindi)':            'HI-HARDTHING',
    'Mother Mary Comes to Me Hindi':                   'HI-MARY-AR',
    # Ana Huang – Kings of Sin
    'Kings of Sin Series Complete':                    'AH-KOS-COMPLETE-6',
    'Kings of Sin Books 4-6':                          'AH-KOS-4-6',
    'Kings of Sin Books 1':                            'AH-KOS-1-3',
    'King of Gluttony':                                'AH-KOS-GLUT',
    'Ana Huang Twisted Series':                        'AH-TWISTED-3',
    # Other combos
    'Hidden Hindu Trilogy':                            'HH-TRILOGY-3',
    'Colleen Hoover 3-Book':                           'COH-STARTER-3',
    'Robert Greene Power Trilogy':                     'RG-POWER-3',
    'Mark Douglas Trading':                            'MD-TRADING-2',
    'Feluda':                                          'FEL-MYSTERIES-4',
    'Stoic Essentials Trio':                           'STOIC-TRIO-3',
    'Enid Blyton Famous Five':                         'EB-FF-3',
    'Wealth Starter Pack':                             'WEALTH-3-299',
    'Kids Activity':                                   'KIDS-ACT-4',
    'Classic Pocket Trio':                             'CLASSICS-3',
    'Osho Duo':                                        'OSHO-DUO-2',
    # Individual titles
    'Moonwalk by Michael Jackson':                     'MJ-MOONWALK',
    'Moonwalk':                                        'MJ-MOONWALK',
    'Taiwan Travelogue':                               'TAIWAN-TRVLG',
    'Suicidal Empathy':                                'NONFIC-SUICEMP-GS',
    'Ironwood':                                        'FICT-IRONWOOD-MC',
    'Yesteryear':                                      'FICT-YESTERYEAR-CCB',
    'The Correspondent + My Friends':                  'FICT-CORR-MYFR-MHW-3',
    # Popular individual titles (scraped catalogue, no dedicated SKU yet)
    'Rich Dad Poor Dad':                               'RDPD',
    'Mother Mary comes To Me':                         'MOTHER-MARY-EN',
    'Mother Mary Comes to Me':                         'MOTHER-MARY-EN',
    'The Let Them Theory':                             'LET-THEM-THEORY',
    'The Housemaid':                                   'HOUSEMAID',
    'Onyx Storm':                                      'ONYX-STORM',
    'Sunrise on the Reaping':                          'SUNRISE-REAPING',
    'The Catcher in the Rye':                          'CATCHER-RYE',
    'Norwegian Wood':                                  'NORWEGIAN-WOOD',
    'The Art of Detachment':                           'ART-OF-DETACHMENT',
    # Legacy entries (keep for backward compat)
    "Can't Hurt Me":                                   'HI-CHM',
}

# Sort by key length descending so specific matches beat generic ones
_SKU_LOOKUP = sorted(ITEM_SKU_MAP.items(), key=lambda x: len(x[0]), reverse=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

_NAN_STRINGS = {'nan', 'none', 'null', 'n/a', 'na', '#n/a', ''}

def clean_val(v):
    """Return '' for any pandas NaN / None / 'nan' string, else stripped string."""
    if v is None:
        return ''
    s = str(v).strip()
    return '' if s.lower() in _NAN_STRINGS else s


def clean_phone(phone):
    digits = ''.join(c for c in str(phone) if c.isdigit())
    return digits[-10:] if len(digits) > 10 else digits


def parse_address(addr):
    """Split 'Street, Area, City, State, Pincode' robustly."""
    parts = [p.strip() for p in str(addr).split(',')]
    parts = [p for p in parts if p]           # drop empty segments
    if not parts:
        return '', '', '', '', ''
    pincode = parts[-1] if parts else ''
    state   = parts[-2] if len(parts) >= 2 else ''
    city    = parts[-3] if len(parts) >= 3 else ''
    rest    = parts[:-3] if len(parts) > 3 else parts[:1]
    addr1   = rest[0][:120] if rest else ''
    addr2   = ', '.join(rest[1:])[:120] if len(rest) > 1 else ''
    return addr1, addr2, city, state, pincode


def get_sku(title):
    """Return SKU from map using longest matching keyword (case-insensitive)."""
    t = str(title).lower()
    for key, sku in _SKU_LOOKUP:
        if key.lower() in t:
            return sku
    return ''


def estimate_weight_dims(items):
    """Fixed weight 300g for all orders regardless of item count or combo size."""
    return 300, 22, 2, 14


def parse_items_from_old_format(items_str):
    """
    Parse the old single 'Items' column: 'Title A x1 | Title B x2'

    IMPORTANT: product titles themselves can contain ' | ' (e.g. "Atomic Habits +
    Psychology of Money + Ikigai | Set of 4 Bestselling... x1").  We must NOT naively
    split on ' | ' — instead we accumulate segments until we find one whose combined
    buffer ends with ' x<digits>'.
    """
    import re
    segments = [s.strip() for s in str(items_str).split(' | ')]
    segments = [s for s in segments if s]

    result = []
    buffer = ''

    for seg in segments:
        buffer = (buffer + ' | ' + seg) if buffer else seg
        # Check if buffer ends with ' x<digits>' — i.e. this is a complete item
        m = re.search(r'\s+x(\d+)\s*$', buffer)
        if m:
            qty     = int(m.group(1))
            product = buffer[:m.start()].strip()
            result.append({'product': product, 'sku': get_sku(product), 'qty': qty})
            buffer  = ''

    # Anything left without a qty marker → treat as qty=1
    if buffer:
        result.append({'product': buffer.strip(), 'sku': get_sku(buffer), 'qty': 1})

    return result if result else [{'product': str(items_str), 'sku': get_sku(items_str), 'qty': 1}]


def parse_items_from_new_format(row, max_slots=10):
    """
    Parse Product(N)/SKU(N)/Qty(N) columns from new wide-format export.
    Returns list of {'product': str, 'sku': str, 'qty': int}

    NaN handling: pandas dtype=str converts missing cells to the literal string 'nan'.
    clean_val() normalises those to '' so we stop iteration correctly.
    SKU: if the CSV SKU is blank/nan, auto-derive it from the product name.
    """
    result = []
    for n in range(1, max_slots + 1):
        product = clean_val(row.get(f'Product({n})', ''))
        if not product:
            break                           # no more items for this order
        # SKU: use CSV value if present, else smart-derive from product name
        sku_val = clean_val(row.get(f'SKU({n})', ''))
        if not sku_val:
            sku_val = get_sku(product)
        try:
            qty = int(clean_val(row.get(f'Qty({n})', '')) or 1)
        except (ValueError, TypeError):
            qty = 1
        result.append({'product': product, 'sku': sku_val, 'qty': qty})
    return result if result else []


# ── Core mapper ───────────────────────────────────────────────────────────────

def map_orders(input_file):
    if input_file.lower().endswith(('.xlsx', '.xls')):
        df = pd.read_excel(input_file, dtype=str)
    else:
        df = pd.read_csv(input_file, dtype=str)

    df.columns = [c.strip() for c in df.columns]

    # Detect format: new wide format has 'Product(1)' column
    is_new_format = 'Product(1)' in df.columns

    rows = []
    unknown_items = set()

    for _, r in df.iterrows():
        # ── Customer info ──────────────────────────────────────────────────
        name = clean_val(r.get('Customer Name', ''))
        name_parts = name.split(None, 1)
        first = name_parts[0] if name_parts else ''
        last  = name_parts[1] if len(name_parts) > 1 else ''
        phone = clean_phone(r.get('Phone', ''))

        # ── Address ────────────────────────────────────────────────────────
        addr1, addr2, city, state, pincode = parse_address(clean_val(r.get('Delivery Address', '')))

        # ── Payment / amounts ──────────────────────────────────────────────
        total_amount = 0.0
        try:
            total_amount = float(clean_val(r.get('Amount INR', '')) or '0')
        except ValueError:
            pass

        collect_cod = 0.0
        try:
            collect_cod = float(clean_val(r.get('Collect COD INR', '')) or '0')
        except ValueError:
            pass

        # Determine COD vs Prepaid
        payment_method = str(r.get('Payment Method', '') or '').strip().lower()
        status_str     = str(r.get('Status', '') or '').strip().lower()
        is_cod = (
            collect_cod > 0
            or 'cash' in payment_method
            or 'cod' in payment_method
            or 'cod' in status_str
        )
        payment_type = 'COD' if is_cod else 'Prepaid'
        collectable  = collect_cod if collect_cod > 0 else (total_amount if is_cod else 0)

        # ── Items ──────────────────────────────────────────────────────────
        if is_new_format:
            items = parse_items_from_new_format(r)
        else:
            items = parse_items_from_old_format(r.get('Items', ''))

        if not items:
            items = [{'product': 'Unknown Product', 'sku': '', 'qty': 1}]

        # Track items without SKU
        for item in items:
            if not item['sku']:
                unknown_items.add(item['product'])

        # ── Weight / dimensions ────────────────────────────────────────────
        weight, length, height, breadth = estimate_weight_dims(items)

        # ── Price distribution across items ────────────────────────────────
        total_qty = sum(i['qty'] for i in items)
        price_each = round(total_amount / total_qty, 2) if total_qty > 0 else total_amount

        # ── Build output row ───────────────────────────────────────────────
        row = {c: '' for c in DELHIVERY_COLS}
        row['Order ID*']             = str(r.get('Order ID', '')).strip()
        row['Payment Type*']         = payment_type
        row['Collectable Amount']    = int(collectable)
        row['Shipping First Name*']  = first
        row['Shipping Last Name']    = last
        row['Shipping Address 1*']   = addr1
        row['Shipping Address 2']    = addr2
        row['Shipping Phone Number*']= phone
        row['Shipping City*']        = city
        row['Shipping State*']       = state
        row['Shipping Pincode*']     = pincode
        row['Weight(gm)']            = weight
        row['Length(cm)']            = length
        row['Height(cm)']            = height
        row['Breadth(cm)']           = breadth
        row['Shipping Charges']      = 0
        row['COD Charges']           = 0
        row['Tax Amount']            = 0
        row['Discount']              = 0

        # Fill product slots (max 10)
        for idx, item in enumerate(items[:10], start=1):
            row[f'SKU({idx})']       = item['sku']
            row[f'Product({idx})*']  = item['product']
            row[f'Quantity({idx})*'] = item['qty']
            row[f'Price({idx})*']    = price_each

        rows.append(row)

    # ── Save ───────────────────────────────────────────────────────────────
    downloads = os.path.join(os.path.expanduser('~'), 'Downloads')
    timestamp  = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_file = os.path.join(downloads, f'inkandchai_delhivery_{timestamp}.csv')

    out = pd.DataFrame(rows, columns=DELHIVERY_COLS)
    out = out.fillna('')                  # ensure no NaN leaks into output

    # Force string type on ID / phone / pincode columns so pandas doesn't
    # store them as integers (which would then be written unquoted and Excel
    # would display them in scientific notation for large values).
    str_cols = [
        'Order ID*',
        'Shipping Phone Number*', 'Shipping Pincode*',
        'Billing Phone Number',   'Billing Pincode',
    ]
    for col in str_cols:
        if col in out.columns:
            out[col] = out[col].astype(str).replace({'nan': '', '0': ''})

    # encoding='utf-8-sig'       → BOM prefix; tells Excel this is UTF-8
    #                               (fixes Hindi / Bengali / other non-ASCII text)
    # quoting=csv.QUOTE_NONNUMERIC → wraps every string cell in double-quotes;
    #                               Excel respects quoted strings and will NOT
    #                               auto-convert phone / order-id numbers to
    #                               scientific notation.
    out.to_csv(
        output_file,
        index=False,
        na_rep='',
        encoding='utf-8-sig',
        quoting=csv.QUOTE_NONNUMERIC,
    )

    return out, output_file, unknown_items


# ── GUI ───────────────────────────────────────────────────────────────────────

def main():
    root = tk.Tk()
    root.withdraw()

    input_file = filedialog.askopenfilename(
        title='Select Ink & Chai Orders File (CSV or XLSX)',
        filetypes=[('CSV / Excel', '*.csv *.xlsx *.xls'), ('All Files', '*.*')]
    )

    if not input_file:
        messagebox.showinfo('Cancelled', 'No file selected. Exiting.')
        root.destroy()
        return

    try:
        result, output_file, unknown_items = map_orders(input_file)

        msg = f'✅ Mapped {len(result)} order{"s" if len(result) != 1 else ""} successfully!\n\nSaved to:\n{output_file}'

        if unknown_items:
            msg += f'\n\n⚠️  {len(unknown_items)} item(s) have no SKU (left blank):\n'
            msg += '\n'.join(f'  • {t}' for t in sorted(unknown_items))
            msg += '\n\nAdd these to ITEM_SKU_MAP in the script to fix.'

        messagebox.showinfo('Done', msg)

    except Exception as e:
        messagebox.showerror('Error', f'Failed to process file:\n\n{str(e)}')

    root.destroy()


if __name__ == '__main__':
    main()
