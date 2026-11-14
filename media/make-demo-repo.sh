#!/usr/bin/env bash
# Creates the small "storefront" repository the demo recordings use, so every
# clip shows the same believable project instead of your real work.
#
#   bash media/make-demo-repo.sh            # creates ~/code/storefront
#   bash media/make-demo-repo.sh /some/dir  # creates /some/dir/storefront
#
# It makes a git repository with a few plain JavaScript files (tests run with
# `npm test`, no install needed) and one extra worktree, feature/search, with a
# staged and an unstaged change so the Changes panel has something to show.
# It refuses to touch a storefront folder that already exists.
set -euo pipefail

parent="${1:-$HOME/code}"
repo="$parent/storefront"
worktree="$parent/storefront-worktrees/feature-search"

if [ -e "$repo" ] || [ -e "$parent/storefront-worktrees" ]; then
  echo "Already exists: $repo or $parent/storefront-worktrees. Remove them first, or pass another directory." >&2
  exit 1
fi

mkdir -p "$repo/src/cart" "$repo/src/api"
cd "$repo"
git init -q -b main

cat > package.json <<'JSON'
{
  "name": "storefront",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
JSON

cat > README.md <<'MD'
# storefront

A small online shop: a cart with totals and tax, and a product catalog.
Run the tests with `npm test`.
MD

cat > src/cart/totals.js <<'JS'
const TAX_RATE = 0.0825;

/** Sums a cart: each item is { name, price, quantity }, prices in dollars. */
export function cartTotal(items) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = subtotal * TAX_RATE;
  return { subtotal, tax, total: subtotal + tax };
}
JS

cat > src/cart/totals.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from './totals.js';

test('totals a cart with tax', () => {
  const { subtotal, total } = cartTotal([
    { name: 'Mug', price: 12.5, quantity: 2 },
    { name: 'Poster', price: 8.99, quantity: 1 },
  ]);
  assert.equal(subtotal, 33.99);
  assert.ok(total > subtotal);
});
JS

cat > src/api/products.js <<'JS'
export const products = [
  { id: 1, name: 'Ceramic Mug' },
  { id: 2, name: 'Canvas Tote' },
  { id: 3, name: 'Cotton Tee' },
  { id: 4, name: 'Travel Poster' },
  { id: 5, name: 'Trail Map' },
];
JS

git add -A
git -c user.name="${GIT_AUTHOR_NAME:-Demo}" -c user.email="${GIT_AUTHOR_EMAIL:-demo@example.com}" commit -q -m "Initial storefront"

# A second worktree with work in progress, for the Changes panel.
git worktree add -q -b feature/search "$worktree"
cd "$worktree"
cat > src/api/search.js <<'JS'
import { products } from './products.js';

/** Products whose name starts with the query. */
export function search(query) {
  const term = query.trim().toLowerCase();
  return products.filter((product) => product.name.toLowerCase().startsWith(term));
}
JS
git add src/api/search.js
cat >> README.md <<'MD'

## Search

`search(query)` returns the products whose name starts with the query.
MD

echo "Created $repo"
echo "    and $worktree (feature/search, with changes)"
echo "Add $repo to Agntree with: Add Local Folder or Repository…"
