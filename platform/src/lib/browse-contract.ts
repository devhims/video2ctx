// The public package currently keeps its browse contract as an internal module.
// Resolve it from the pinned installed artifact so production never compiles local package source.
export * from '../../node_modules/all-things-youtube/dist/browse-contract.js';
