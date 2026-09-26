# Budgets and EXPAND

Every token a model reads costs money and context. So every YEA request can say how much it wants back, and replies fit.

## The budget

A request's `budget` is the maximum size, in estimated tokens, of the reply's [Lens](/guide/lens) rendering. The default is 2000. When a reply doesn't fit, the service elides part of it and leaves a handle:

```
items[7]{sku,name,usd,cal,protein}:
  m005,Falafel Plate,16.47,632,46
  …
… 8 more at data — EXPAND h_20F74mmpWC1f (~155 tokens)
```

`EXPAND h_20F74mmpWC1f` returns the next slice, with its own budget and possibly further handles. Handles live at least 10 minutes, and a handle from an authenticated request only expands for the same agent key.

## What may be elided

Budgets never change what an agent might commit to. A service may drop whole trailing proposals or capabilities, and may elide anything inside `ANSWER.data`, a proposal's `data` or a receipt's `result`. It never alters a proposal's effects, summary or hash ([SPEC §8](/reference/spec#8-budgets-and-expand)).

## The shared token estimate

Both sides count tokens the same way: the number of matches of

```
[A-Za-z]+|[0-9]{1,3}|\n {2,}|[^ \t\n\r\f\vA-Za-z0-9]
```

That's letter runs, digit groups of up to three, indentation runs, and each other visible character. It isn't any model's tokenizer, but on Lens text it averages about 1.0× real BPE token counts, which bytes/4 doesn't ([design notes](/reference/design#budgets-and-the-shared-token-estimate)).

In the [playground](/playground), try "60 items in 250 tokens", then expand the handle.
