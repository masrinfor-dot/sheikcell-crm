---
name: CRM custom fields
description: How user-defined custom fields work for CRM contacts (definitions + per-contact jsonb values)
---

# CRM custom fields

Admins/supervisors define reusable fields; every contact can fill them in.

- **Definitions** live in `crm_custom_fields` table (name, type, options, sortOrder, isActive). Type ∈ text|number|date|select|textarea; `options` is comma-separated, only meaningful for `select`. CRUD endpoints `/crm/custom-fields*` are gated by `requireAdminOrSupervisor` and declared BEFORE `/crm/:id` so they aren't shadowed.
- **Values** are stored on `crm_contacts.customFields` (jsonb, default `{}`), keyed by the field-definition **id as a string**. Keying by id (not name) means renaming a field keeps existing values; deleting a definition orphans values harmlessly (UI only renders values whose definition still exists + isActive).

**Why string-keyed-by-id + sanitize:** jsonb accepts arbitrary client JSON. Server `sanitizeCustomFields()` coerces every value to a string and drops objects/arrays so the stored shape always matches `Record<string,string>`. Frontend still defends with `cfValue()` (CrmContactDetail) before calling `.trim()` — never assume a stored value is a string when reading legacy rows.

**How to apply:** when adding new write paths for contacts, run the customFields payload through `sanitizeCustomFields`. When rendering values, normalize via `cfValue` rather than direct `.trim()`.
