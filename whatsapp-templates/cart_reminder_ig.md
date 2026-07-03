# WhatsApp Template: `cart_reminder_ig`

Submit this in **WhatsApp Manager → Message templates → Create template**.
Once Meta approves it, the abandoned-cart recovery code uses it automatically
(with a fallback to the existing `cart_reminder` until it's approved).

---

## Settings

| Field | Value |
|-------|-------|
| **Name** | `cart_reminder_ig` (lowercase + underscores, exactly this) |
| **Category** | **Marketing** |
| **Language** | English (`en`) |

---

## Header
Type: **Text**

```
Your books are still waiting 📚
```

## Body
(3 variables — same order the code already sends: name, item count, amount)

```
Hi {{1}}, you left {{2}} in your cart at Ink & Chai 🛒

Complete your order of {{3}} and enjoy fast delivery of 100% genuine, publisher-sourced books across India.

Still unsure? Take a look at our Instagram — real reader photos, genuine books and happy customers 📸
```

**Sample values (Meta asks for these):**
- `{{1}}` → `Ausaf`
- `{{2}}` → `2 books`
- `{{3}}` → `₹499`

## Footer
```
Reply STOP to opt out.
```

## Buttons
Add **two** buttons, both type **Visit website** (Static URL):

| Button text | URL |
|-------------|-----|
| `Complete Order` | `https://inkandchai.in/checkout/` |
| `See our Instagram` | `https://instagram.com/theinkandchai.in` |

---

## Notes
- Keep the variable count at **3** and in this order — the code passes
  `[firstName, itemCount, amount]`, matching `{{1}} {{2}} {{3}}`.
- Marketing category is correct for cart recovery; it counts toward marketing
  conversation limits and respects opt-outs.
- After approval, no code change is needed — `auto-recover-carts.js` and
  `send-abandoned-email.js` already try `cart_reminder_ig` first and fall back
  to `cart_reminder`.
