---
name: Role scope consistency (chat ↔ CRM)
description: Global vs sector-scoped role rules must match across modules that link to each other
---

# Global-role scope must be consistent across modules

Rule: a role is either **global** (admin, supervisor) or **sector-scoped** (vendedor) — and that classification must be identical in every module that can hand off records to another.

**Why:** The Atendimento (chat) module treats admin+supervisor as global, but the CRM originally treated only admin as global. When a CRM action was reached *from* a chat conversation (the "CRM" button that find-or-creates the contact via auto-register), a supervisor viewing an out-of-sector conversation could see the chat but got 403 from the CRM — a broken cross-module flow. Loose phone-based coupling between chat and CRM makes these mismatches easy to introduce.

**How to apply:** When adding sector authorization to a route, use the shared "is this role global?" predicate (admin || supervisor) rather than hardcoding `role === "admin"`. Before linking module A to module B, confirm both agree on which roles are global. Sector *reassignment* (moving a contact between sectors) is a stricter, admin-only action and is intentionally NOT granted to supervisors.
