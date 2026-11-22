# Search fields and mode

The object property `search` on a Catalog, a Document or a `CustomTable`
names what a search of the object looks at (a reference picker, a `contains`
or `startsWith` filter of a list read).

```json
{ "search": { "fields": ["description", "code"], "mode": "startsWith" } }
```

- `fields`: logical names of header attributes, standard or custom. Omitted:
  the default fields of the kind — a Catalog's presentation field
  (`description`, or `code` with `mainPresentation: "Code"`; none when its
  length is 0), a Document's `number`, a `CustomTable` none. An object with no
  fields has no search.
- `mode`: `startsWith` or `contains`; `contains` when omitted.
- A field of type `String` or `Text` gets a stored derived column and an index
  built by the platform (`<column>_search`); it is not an attribute, so leave
  it out of metadata files and out of `fields`.
- `startsWith` is read through an index on a bounded prefix of the lowercased
  value, with the exact condition on the full value beside it, so the result
  is the same with or without the index. It is the mode to choose for a large
  table.
- `contains` has no index: it scans the rows of the scope, so it stays fast
  only for a scope up to about a hundred thousand rows, and a request needs a
  scope equality. Without one the scan covers the whole table.
- Adding `search` to an adopted `CustomTable` adds the derived column in the
  apply plan; it rewrites the table, so the plan marks it as a heavy step.
