# Row version epoch

Every row of a table with the mechanics trigger carries a `version` from one
database-wide sequence, `simetra.row_version`. A client keeps a row by its
version, so a version must never repeat for a key. The database gives the
client an epoch, `simetra.row_version_epoch()`; when it changes, the client drops
the versions it holds.

The epoch changes on its own when the server restarts, a volume snapshot or a
point in the past is restored, a failover moves the timeline, or the database
moves to a new cluster or a new database. It is `NULL` on a replica.

Two cases the database cannot see:

- **A data-only restore into the same database** (`pg_restore --data-only`,
  `psql` from a dump). The dump brings back old sequence values and the old
  epoch row.
- **A move by logical replication.** Sequences do not travel, so the new
  sequence may sit below the versions in the rows.

After either, the schema owner runs the call below with the application stopped
and before its first read:

```sql
SELECT simetra.reset_row_version_epoch();
```

It seeds the sequence above every version in the mechanics tables and issues a
new epoch. Versions issued between the restore and the call may repeat: the
database does not guard that window.

Rules for your own SQL:

- Never set `synchronous_commit = off` after a row write in a debt unit. The
  mechanics trigger raises the commit to synchronous; `off` makes it
  asynchronous again, and a crash then loses issued versions without an epoch
  change.
- Never write the `simetra.row_version_*` settings (`sql.debt-session-write`
  warns).
