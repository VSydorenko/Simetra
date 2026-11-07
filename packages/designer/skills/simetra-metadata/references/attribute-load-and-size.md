# Attribute load and size

How `load` and `maxBytes` of an attribute shape what the runtime reads and
writes, and what to do when the compiler or a command refuses a size.

## `load`: keep heavy values out of list reads

- `"lazy"` keeps a heavy value (a file, a long body) out of list reads. A
  card read (`{ object, id }`) still returns it, but a list read cannot
  filter or sort by it: that query is refused with `command.invalid`.
- Without the field, a header `Bytes` attribute is lazy and every other
  attribute is eager. Set `"eager"` to list a header `Bytes`.
- `load` emits no DDL, and changing it does not make open browser tabs
  stale: an old tab's list simply stops showing the value.
- Not allowed on a polymorphic `Ref` (the pair is read as a whole), a tabular
  section attribute (a section array without the field would erase it), a
  rights carrier (`ownership`, `containerBinding`, `access`;
  `rights.carrier-lazy`), or a register attribute
  (`attribute.load-not-allowed`): the runtime does not read registers yet.

## `maxBytes`: the most a command may write

- Applies to `Text`, `Json`, `Bytes` and arrays (`"array": true`); on any
  other type the compiler reports `type.max-bytes-type`, on a register
  attribute `attribute.max-bytes-not-allowed`. A `String` is limited by
  `length` instead.
- The measure is the UTF-8 bytes of the JSON value as it goes over the wire:
  an array counts as a whole, `Bytes` as its `\x…` hex text.
- Defaults: 1 MiB for `Json` and `Bytes`, 64 KiB for `Text` and arrays.
  Standard attributes get the default of their type and cannot set their own.
- A command whose value is over the limit is refused with `command.invalid`,
  `reason: "too-large"`, `path` — the attribute. Only command input is
  checked: a stored value over the limit still reads.

To store a long `Text` (an article body, a long description), raise its
limit, for example `"maxBytes": 1048576` for 1 MiB, and make the attribute
`"load": "lazy"` if it is on the header, so that list reads stay small.

## The response budget

Every response the application server sends to the browser has a budget of
4 MiB, measured the same way as `maxBytes`. The compiler checks the metadata
against it:

- `attribute.row-over-budget` (error): one list row or one tabular section
  row can be larger than the budget. The size of a column is its `maxBytes`,
  the `length` of a `String`, or the fixed size of its type. Lower `maxBytes`
  or `length`, or make header attributes lazy; a tabular section attribute
  cannot be lazy, so lower its limits or move the data to a separate object.
- `attribute.lazy-over-budget` (warning): the lazy attributes of an object
  together can exceed the budget of a card read. A card past the budget is
  refused, not cut, so lower their `maxBytes` if real values can get there.

In the browser a page of a list over the budget comes back shorter, marked
`more: true`; a read by key, a card and the lines of an owner past the
budget are refused with `command.invalid`, `reason: "response-too-large"`.
`data-read` over MCP has no response budget.
