'use strict';

// The imported catalogue (data/ALL_BOOKS.json) carries the shop's collection
// name as a book's category: "Self-help (On Sale)", "Romance (On Sale)",
// "Best Self Help Books from Publishers"... A book's category is the first of
// those it was imported under, so Sherlock Holmes read "Self-help" and the
// recommender, inventory and search all followed it. data/category_fixes.json
// maps shopify_id -> the book's real genre (2026-11-08, 701 books). The baked
// product pages and feed.xml were patched to match, and generate_site.py
// applies the same file.
const FIXES = require('../../../data/category_fixes.json');

function catalogueCategory(book) {
  const sid = String((book && book.shopify_id) || '');
  return (sid && FIXES[sid]) || (book && book.category) || '';
}

module.exports = { catalogueCategory, FIXES };
