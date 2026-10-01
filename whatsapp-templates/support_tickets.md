# WhatsApp templates for support tickets

Support tickets email the customer by default. WhatsApp is **off** until these
three templates are approved by Meta. Then set `SUPPORT_TICKET_WHATSAPP = "on"`
in `wrangler.toml` and deploy. Each template takes two variables, sent in this
order: `{{1}}` the customer's first name, `{{2}}` the ticket number.

Submit in **WhatsApp Manager → Message templates → Create template**.
All three: Category **Utility**, Language English (`en`), no header, no buttons.

---

## `ticket_received`

```
Hi {{1}}, we've received your support request {{2}} at Ink & Chai. Our team will reply within 24 hours and aim to resolve it within 48 hours. We'll keep you updated by email.
```

Sample values: `{{1}}` → `Ausaf`, `{{2}}` → `TKT-4K7Q2M`

## `ticket_delay_update`

```
Hi {{1}}, your support request {{2}} is taking longer than we expected, and we're sorry for the wait. We're still working on it and will update you as soon as it's resolved.
```

Sample values: `{{1}}` → `Ausaf`, `{{2}}` → `TKT-4K7Q2M`

## `ticket_resolved`

```
Hi {{1}}, your support request {{2}} has been resolved and closed. We've emailed you the details. If it's still not right, reply to that email or raise a new ticket at inkandchai.in/support within 7 days.
```

Sample values: `{{1}}` → `Ausaf`, `{{2}}` → `TKT-4K7Q2M`
