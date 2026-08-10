// The public package currently keeps its normalized client as an internal module.
// Resolve it from the pinned installed artifact so production never compiles local package source.
export * from '../../node_modules/all-things-youtube/dist/youtube-client.js';
