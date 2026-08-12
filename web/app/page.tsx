import { DEFAULT_DIRECTION, getDirection } from './_directions/registry';

/* The homepage renders whichever direction is currently in front. Swapping the
 * winner is a one-line change to DEFAULT_DIRECTION in the registry — the point
 * of routing it this way is that no contender is load-bearing until it is
 * chosen. */

export default function HomePage() {
  const direction = getDirection(DEFAULT_DIRECTION) ?? null;
  return direction ? direction.render() : null;
}
