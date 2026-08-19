# 01 — Usage overlay

**What to build:** Fork extras for SuperGrok / usage chips and multiline notices live in the overlay layer. The upstream composer only keeps thin hooks. After this ticket, those extras still look and behave as they do today, but they no longer live as patches inside DLYZZT files.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Usage chips still sit next to the model picker
- [x] Multiline `/grok-usage` notices still render in full
- [x] MCP status stays off the composer
- [x] Overlay owns the extra behavior; upstream files only call hooks
- [x] A fresh agent can demo this without touching the session list
