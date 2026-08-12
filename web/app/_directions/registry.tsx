import type { ReactNode } from 'react';
import { DecompositionDirection } from './decomposition';
import { CraftDirection } from './craft';
import { ContextEngineConcept, OrbitConcept, SignalFieldConcept } from './concepts';

/* Landing-page directions under consideration.
 *
 * One entry per contender. Each is a complete, scrollable page rather than a
 * mockup, because the point of the exercise is to judge them in a browser
 * instead of from a description.
 *
 * `notes` is deliberately honest about what each direction is betting on and
 * what it gives up — a comparison where every option sounds good is not a
 * comparison. Promoting a winner means changing DEFAULT_DIRECTION and deleting
 * the rest.
 */

export interface Direction {
  slug: string;
  name: string;
  premise: string;
  macrostructure: string;
  bet: string;
  cost: string;
  render: () => ReactNode;
}

export const DIRECTIONS: Direction[] = [
  {
    slug: 'decomposition',
    name: 'Decomposition',
    premise: 'A video is taken apart on screen as you scroll, one kind of context at a time.',
    macrostructure: 'Feature Stack — sticky copy rail, scroll-synced stage',
    bet: 'That the product’s core idea is visual and worth pinning the viewport to show.',
    cost: 'Long scroll before the page states a benefit. Carries a substantial dark band that has to earn its space, and the choreography is invisible on phones.',
    render: () => <DecompositionDirection />,
  },
  {
    slug: 'craft',
    name: 'Craft',
    premise:
      'The fold is the input and nothing else. You paste a URL and the page answers with your own video; everything below is a footnote to what you just ran.',
    macrostructure: 'Marquee Hero — N2 floating chip, Ft4 colophon, dark paper',
    bet: 'That the fastest argument is letting someone run the thing, and that motion should be budgeted by how often each element is seen.',
    cost: 'Says less before you interact than a conventional hero would. Dark paper is a real departure from the current brand.',
    render: () => <CraftDirection />,
  },
  {
    slug: 'orbit',
    name: 'Orbit',
    premise:
      'The original hero: a split composition with metadata, transcript, channel and comments circling one video on counter-rotating rings.',
    macrostructure: 'Map / Diagram — N9 edge-aligned nav, Ft2 inline footer',
    bet: 'That the product is best explained by a diagram of its parts around a source.',
    cost: 'Orbit is the wrong metaphor — it implies satellites circling a body rather than one thing separating into its parts. The diagram is also decorative: it carries no information a caption would not.',
    render: () => <OrbitConcept />,
  },
  {
    slug: 'signal-field',
    name: 'Signal field',
    premise: 'The same source map, bled behind the copy as a spatial field rather than sat beside it.',
    macrostructure: 'Map / Diagram — full-bleed variant',
    bet: 'That letting the diagram occupy the whole fold reads as more confident than boxing it.',
    cost: 'The copy and the diagram compete for the same space, and the form ends up below both.',
    render: () => <SignalFieldConcept />,
  },
  {
    slug: 'context-engine',
    name: 'Context engine',
    premise:
      'A CSS-3D still of a video slab being distilled into structured context, with transcript, channel, comments, playlist and search as labelled outputs.',
    macrostructure: 'Map / Diagram — 3D stage',
    bet: 'That showing the decomposition literally beats describing it.',
    cost: 'A static 3D still promises motion it never delivers. Its information model was the right one, though — it is the only concept that named all five surfaces, and it seeded both later directions.',
    render: () => <ContextEngineConcept />,
  },
];

export const DEFAULT_DIRECTION = 'craft';

export function getDirection(slug: string): Direction | undefined {
  return DIRECTIONS.find((direction) => direction.slug === slug);
}
