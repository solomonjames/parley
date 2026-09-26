Closes #

**What and why**

**How I checked it**

**Checklist**
- [ ] `npm run lint && npm run lint:style && npm test` pass (and `cd python && uv run pytest` if Python or protocol behavior changed)
- [ ] If this changes bytes on the wire or Lens output: SPEC.md is updated and vectors are regenerated (`cd ts && npm run build && node scripts/vectors.mjs`)
- [ ] Docs and README updated if behavior users see changed
