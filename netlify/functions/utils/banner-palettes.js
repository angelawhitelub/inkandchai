/**
 * The colour ways a banner may be drawn in.
 *
 * A palette is picked by ID, never mixed by hand and never written by the
 * model, for the same reason the shop promises are picked by ID: the homepage
 * is not the place to find out that something generated an unreadable pairing.
 * Each one is a complete, hand-checked set -- paper against ink, panel against
 * panel ink, sticker against sticker ink -- so any layout can use any palette
 * and still be legible.
 *
 * These are absolute colours, not theme variables. A banner keeps its own
 * looks whether the reader has the site in dark or light mode; it is a poster
 * on the page, not part of the page's furniture.
 */

'use strict';

const PALETTES = {
  terracotta: {
    label: 'Terracotta on cream',
    paper: '#efe7d8', ink: '#221f1c', muted: '#5f564a', rule: 'rgba(34,31,28,0.16)',
    panel: '#c25b3c', panelInk: '#fdf2e7', panelSoft: 'rgba(253,242,231,0.42)',
    sticker: '#dcecc4', stickerInk: '#22301a',
    btn: '#2a2622', btnInk: '#f7f2e8',
  },
  midnight: {
    label: 'Indigo on bone',
    paper: '#f1ede4', ink: '#1b1c26', muted: '#575a68', rule: 'rgba(27,28,38,0.16)',
    panel: '#2f3557', panelInk: '#eef0fa', panelSoft: 'rgba(238,240,250,0.42)',
    sticker: '#f0c65a', stickerInk: '#2a2410',
    btn: '#1b1c26', btnInk: '#f4f2ea',
  },
  forest: {
    label: 'Forest on oat',
    paper: '#ece9dc', ink: '#1d241d', muted: '#55604f', rule: 'rgba(29,36,29,0.16)',
    panel: '#2f5340', panelInk: '#eef5ec', panelSoft: 'rgba(238,245,236,0.42)',
    sticker: '#e9c98a', stickerInk: '#2b2313',
    btn: '#1d241d', btnInk: '#f2f0e4',
  },
  plum: {
    label: 'Plum on blush',
    paper: '#f2e8e6', ink: '#241a22', muted: '#63505c', rule: 'rgba(36,26,34,0.16)',
    panel: '#5d2f4a', panelInk: '#fbeef5', panelSoft: 'rgba(251,238,245,0.42)',
    sticker: '#f3d0a8', stickerInk: '#31210f',
    btn: '#241a22', btnInk: '#f7ece9',
  },
  gold: {
    label: 'House gold on ink',
    paper: '#17130d', ink: '#f2ead8', muted: '#a2957c', rule: 'rgba(242,234,216,0.18)',
    panel: '#c9a84c', panelInk: '#1a1408', panelSoft: 'rgba(26,20,8,0.5)',
    sticker: '#17130d', stickerInk: '#f0d98a',
    btn: '#c9a84c', btnInk: '#17130d',
  },
};

const PALETTE_IDS = Object.keys(PALETTES);
const DEFAULT_PALETTE = 'terracotta';

/** Unknown ids fall back rather than throwing: a banner must always render. */
function palette(id) {
  return PALETTES[String(id || '').toLowerCase()] || PALETTES[DEFAULT_PALETTE];
}

module.exports = { PALETTES, PALETTE_IDS, DEFAULT_PALETTE, palette };
