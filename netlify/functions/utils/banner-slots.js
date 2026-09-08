/**
 * The banner slots the homepage knows about.
 *
 * A "slot" is the stable identity of one carousel slide. Built-in slots name
 * the slides hardcoded in generate_site.py -- they can be hidden but never
 * deleted, because the markup is in the build and would come straight back on
 * the next deploy. Published slots are rows created by Banner Studio and can be
 * removed outright.
 *
 * These ids also appear as data-banner-slot="..." in generate_site.py. Change
 * one here and it must change there, or the homepage will not find the slide it
 * is being told to hide.
 */

'use strict';

const BUILTIN_SLOTS = [
  { slot: 'builtin:sale',   label: 'Freedom Sale', note: 'Also removed automatically when the sale end date passes.' },
  { slot: 'builtin:campus', label: 'Off Campus series', note: '' },
  { slot: 'builtin:hindi',  label: 'Hindi self-help bestsellers', note: '' },
];

const isBuiltin = (slot) => BUILTIN_SLOTS.some(b => b.slot === slot);

module.exports = { BUILTIN_SLOTS, isBuiltin };
