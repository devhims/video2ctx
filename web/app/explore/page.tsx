import { DIRECTIONS, DEFAULT_DIRECTION } from '../_directions/registry';

export const metadata = {
  title: 'Landing directions · video2ctx',
  robots: { index: false, follow: false },
};

export default function ExploreIndex() {
  return (
    <main className='explore'>
      <header className='explore-head'>
        <p className='explore-eyebrow'>Internal · not indexed</p>
        <h1>Landing directions</h1>
        <p className='explore-lede'>
          Each is a complete, scrollable page rather than a mockup — the whole point is to judge
          them in a browser instead of from a description. Arrow keys move between them.
        </p>
      </header>

      <ol className='explore-list'>
        {DIRECTIONS.map((direction, index) => (
          <li key={direction.slug}>
            <p className='explore-index'>{String(index + 1).padStart(2, '0')}</p>
            <div>
              <h2>
                <a href={`/explore/${direction.slug}`}>{direction.name}</a>
                {direction.slug === DEFAULT_DIRECTION ? (
                  <span className='explore-tag'>currently on /</span>
                ) : null}
              </h2>
              <p className='explore-premise'>{direction.premise}</p>
              <dl className='explore-meta'>
                <div>
                  <dt>Structure</dt>
                  <dd>{direction.macrostructure}</dd>
                </div>
                <div>
                  <dt>The bet</dt>
                  <dd>{direction.bet}</dd>
                </div>
                <div>
                  <dt>What it costs</dt>
                  <dd>{direction.cost}</dd>
                </div>
              </dl>
            </div>
          </li>
        ))}
      </ol>

      {DIRECTIONS.length < 2 ? (
        <p className='explore-note'>
          Only one direction so far. The rest come after the reference study — this page is the
          mechanism, not the comparison.
        </p>
      ) : null}
    </main>
  );
}
