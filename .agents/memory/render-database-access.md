---
name: Render database access
description: TLS constraint for safe, ad hoc database reads and maintenance actions.
---

## Rule

Use the configured database connection only through application tooling or Prisma with SSL required; do not reveal, inspect, or log the connection string.

**Why:** The configured Render PostgreSQL connection rejects non-TLS ad hoc clients even when the application itself can connect.

**How to apply:** For maintenance reads or authorized corrections, append the SSL requirement in the runtime connection configuration, use parameterized data access, and report only the needed business results.