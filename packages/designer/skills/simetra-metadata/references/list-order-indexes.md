# List-order indexes

`indexed: true` on an attribute and a composite `indexes` entry both give a
list-order index: the scope column first (on a scoped table), the attribute
columns in the declared order, the row key last. A keyset page then reads
from the index without sorting the visible set.

- A table without a one-column row key (a register movement or totals) gets no
  key column.
- A `unique` attribute already has such an index, so no second one is made.
- An `indexed` `Ref` uses one index for both the foreign key and the order.
- Changing an existing index to this shape is a drop and a create in the
  apply plan; it needs no permission, but the table is locked while the
  index builds.
- A catalog's standard `description` is `NOT NULL DEFAULT ''` and indexed
  whenever the catalog has it (`descriptionLength` above 0). A command may
  omit it (the default `''` is stored) but must not send an explicit `null`.
