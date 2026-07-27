---
'@lifo-sh/core': minor
---

grep: implement BRE, the default dialect (and add -F / -G)

The pattern was passed straight to `new RegExp`, so grep was always ERE. GNU grep defaults to BRE,
and the two dialects are inverted for the most useful metacharacters:

| pattern | BRE (GNU default) | what lifo did |
| --- | --- | --- |
| `\|` | alternation | literal text `\|` → **no match** |
| `\|` (bare `\|`) | literal pipe | alternation |
| `\(` `\)` | group | literal → no match |
| `\+` `\?` `\{n,m\}` | quantifiers | literal → no match |

So `grep "createClient\|supabase-js"` — valid GNU grep, and the natural way to search for two things
at once — compiled to the literal string `createClient|supabase-js` and matched nothing. It exited 1
with no output, which is indistinguishable from a genuine absence, so callers acted on the empty
result. That is the worst failure mode a search tool has.

- BRE is now the default, translated to JS regex (`breToJs`)
- `-E` / `--extended-regexp` selects ERE, as before
- `-F` / `--fixed-strings` is new: every metacharacter literal
- `-G` / `--basic-regexp` selects BRE explicitly; last mode flag wins, as in GNU
- `\<` `\>` map to `\b`; bracket expressions are copied verbatim so `[+?]` is not mangled

**Behaviour change:** a pattern like `grep "a|b"` previously alternated and now matches the literal
text `a|b`, which is what GNU grep does. Add `-E` to keep the old behaviour. Hence minor, not patch.

Not covered: BRE's positional rules where a metacharacter is literal because of where it sits (a `^`
that is not at the start, a `$` that is not at the end). A leading `*` is handled.
