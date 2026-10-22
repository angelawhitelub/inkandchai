'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { displayTitle } = require('./listing-title');

test('marketing subtitle goes, author comes in', () => {
  assert.equal(displayTitle('Trust Fall: From the no. 1 bestselling author of Better than the Movies', 'Lynn Painter'), 'Trust Fall by Lynn Painter');
  assert.equal(displayTitle('The Witch: The haunting new thriller from the #1 Sunday Times bestselling author', 'Freida McFadden'), 'The Witch by Freida McFadden');
  assert.equal(displayTitle('Strange Pictures: The Japanese Mystery Sensation', 'Uketsu'), 'Strange Pictures by Uketsu');
});

test('a film tie-in keeps saying so', () => {
  assert.equal(displayTitle('Verity: the film tie-in edition of the twisty thriller that will keep you up all night', 'Colleen Hoover'),
    'Verity (Film Tie-In Edition) by Colleen Hoover');
});

test('subtitles and series that name the book stay', () => {
  assert.equal(displayTitle('Escape Me: Book 3 (Shatter Me: The New Republic)', 'Tahereh Mafi'), 'Escape Me: Book 3 (Shatter Me: The New Republic) by Tahereh Mafi');
  assert.equal(displayTitle('The Other Worlds Than These: A Talisman Novel (The Talisman Trilogy)', 'Stephen King, Peter Straub'),
    'The Other Worlds Than These: A Talisman Novel (The Talisman Trilogy) by Stephen King');
  assert.equal(displayTitle('Atomic Habits (Paperback)', 'James Clear'), 'Atomic Habits (Paperback) by James Clear');
});

test('author already named, unknown, or a combo: no "by"', () => {
  assert.equal(displayTitle('Our Perfect Storm by Carley Fortune', 'Carley Fortune'), 'Our Perfect Storm by Carley Fortune');
  assert.equal(displayTitle('Colleen Hoover 3-Book Starter Set | It Ends with Us + Verity', 'Colleen Hoover'), 'Colleen Hoover 3-Book Starter Set | It Ends with Us + Verity');
  assert.equal(displayTitle('Rich Dad Poor Dad + Psychology of Money Combo', 'Robert Kiyosaki'), 'Rich Dad Poor Dad + Psychology of Money Combo');
  assert.equal(displayTitle('The Only One Left', ''), 'The Only One Left');
  assert.equal(displayTitle('The Only One Left', 'Various'), 'The Only One Left');
  assert.equal(displayTitle('Painter Stories', 'Lynn Painter'), 'Painter Stories', 'surname already in the title');
  assert.equal(displayTitle('Le Petit Prince', 'Antoine de Saint-Exupéry'), 'Le Petit Prince by Antoine de Saint-Exupéry');
});

test('a title that is all promo is left alone; long ones stay under 150', () => {
  assert.equal(displayTitle('Bestselling Box', 'X Y'), 'Bestselling Box by X Y');
  const long = 'A'.repeat(140);
  assert.equal(displayTitle(long, 'Lynn Painter'), long);
  assert.equal(displayTitle('', 'X'), '');
});

test('a trailing author survives, real subtitles with sale words stay, combos untouched', () => {
  assert.equal(displayTitle('Fake Skating: From the no. 1 bestselling author of Better than the Movies by LYNN PAINTER', 'Lynn Painter'), 'Fake Skating by LYNN PAINTER');
  assert.equal(displayTitle('The Inheritance Games: International YA Mystery Bestseller by Jennifer Lynn Barnes', ''), 'The Inheritance Games by Jennifer Lynn Barnes');
  assert.equal(displayTitle('Dork Diaries: Skating Sensation Vol .04', 'Rachel Renee Russell'), 'Dork Diaries: Skating Sensation Vol .04 by Rachel Renee Russell');
  const combo = 'Protocols by Andrew Huberman + Outlive: The Science and Art of Longevity Combo of 2 Bestsellers';
  assert.equal(displayTitle(combo, 'Andrew Huberman'), combo);
  assert.equal(displayTitle('Anxious People: The No 1 New York Times Bestseller, Now a Netflix Tv Series', 'Fredrik Backman'), 'Anxious People by Fredrik Backman');
});
