# Developer docs

Reference material for anyone building on Jiku — internals, extension points, tooling. Product/user-facing docs live elsewhere.

## Contents

### [`plugin/`](./plugin/) — Plugin development
Everything needed to write, build, and ship a Jiku plugin. Start with [`plugin/README.md`](./plugin/README.md).

## Suggested reading order

1. `plugin/overview.md` — get a minimal plugin running.
2. `plugin/context-api.md` — figure out which `ctx.*` surface you need.
3. `plugin/slots.md` — find the slot that matches your UI shape.
4. `plugin/cli.md` — streamline your dev loop.
5. `plugin/security.md` — before shipping anything that touches user data.

## Related

- Feature-level docs (what is it, public API, limitations): [`../feats/`](../feats/)
- Architecture + product direction: [`../architecture.md`](../architecture.md), [`../product_spec.md`](../product_spec.md)
- Builder state (active work, decisions, conventions): [`../builder/`](../builder/)
- Plan implementation reports: [`../plans/impl-reports/`](../plans/impl-reports/)
