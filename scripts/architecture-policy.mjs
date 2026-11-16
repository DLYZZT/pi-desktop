// Main and Agent Host share Node capabilities through shared/node. Shared and
// contract modules never import process-specific business modules. Renderer
// runtime paths must stay free of Node modules, even through shared barrels.
//
// This file is reviewed configuration for structural checks. Line counts are
// NOT a CI gate: file size is a review concern, and forcing an extraction to
// satisfy a number produces worse code than the long file it replaces. The
// lineLimit below is only a sanity backstop for a degenerate module.
export const architecturePolicy = {
  lineLimit: 5000,
  // Per-file ceilings are gone on purpose. Do not reintroduce them to hold a
  // file at its current size: that turns every later edit into a refactor.
  budgets: {},
  // Domain dictionaries now fit the ordinary module limit. Their static
  // composition, duplicate keys and language parity are checked by check:i18n.
  dataModules: {},
  // An exception, when necessary, must name an exact rule/from/to edge and
  // provide both reason and removeWhen. Wildcards and unused exceptions fail.
  exceptions: [],
};
