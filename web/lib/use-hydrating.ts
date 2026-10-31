import { useSyncExternalStore } from 'react';

const subscribeNever = () => () => {};
/** True while rendering on the server or hydrating its HTML; false for any later client render. */
export function useHydrating() { return useSyncExternalStore(subscribeNever, () => false, () => true); }
