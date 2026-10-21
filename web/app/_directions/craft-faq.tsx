/* The questions a visitor still has after the demo, answered in place rather
 * than on the API docs. Every figure here was checked against the live
 * platform: credit costs from settled request metadata, limits from the Starter
 * account's usage endpoint, and the agent's length limit from a real run. Keep
 * it that way when editing. Native <details>, so it works without JS. */

const FAQ = [
  {
    q: 'How far do the free launch credits go?',
    a: 'The launch gift includes 5,000 credits. Most reads cost 1 credit, and a fresh search or comments request costs 2. In our tests, a cited Video Agent answer about one video used 4 credits and a three-video comparison used 3, but the cost varies with the question and the work needed. No card is needed, and there is one grant per account.',
  },
  {
    q: 'Do I need an account?',
    a: 'Not to start. The youtube-ctx skill and the all-things-youtube npm package run on your machine with no account or API key. An account adds the hosted API, Video Agent, projects, and monitors.',
  },
  {
    q: 'Which agents does it work with?',
    a: 'Any agent that can load skills or run a command-line tool, such as Claude Code, Codex, Gemini CLI, and Cursor. Install the skills with one command, and add the CLI when you want hosted features.',
  },
  {
    q: 'What can Video Agent read?',
    a: 'Transcripts, storyboards, frames, and comments across up to eight videos per question, each up to two hours long. It uses the storyboard to see the whole video at a glance, then reads full frames for on-screen detail like interface values, slides, and code. Every answer cites the videos it used.',
  },
  {
    q: 'How do monitors work?',
    a: 'A monitor checks a channel, topic, or search on a schedule, from hourly to weekly. The first check records a baseline, and each new video after that raises an alert in the dashboard, or by email once you confirm your address. Starter includes one monitor.',
  },
  {
    q: 'What if a video has no captions or comments?',
    a: 'You are told plainly. Results say when captions are missing or comments are turned off, instead of returning an empty list. Transcripts work on long videos too, and captions can be translated into other languages.',
  },
  {
    q: 'Is it open source?',
    a: 'Yes, under Apache 2.0. The workspace and API are one codebase, so you can use the hosted version, install the package, or run all of it yourself.',
  },
  {
    q: 'Love what you’re building. How can I support it?',
    a: 'That’s really kind of you. I’m building video2ctx on my own, so it means a lot. The Builder plan helps most, as it pays for the servers (and my coffee). Otherwise, a star on GitHub and spreading the word go a long way :)',
    links: {
      'Builder plan': '#pricing',
      'a star on GitHub': 'https://github.com/devhims/video2ctx',
    },
  },
];

/* Turns the listed phrases of an answer into links, keeping the rest as text.
 * The structured data keeps the plain answer. */
function withLinks(text: string, links: Record<string, string> = {}) {
  const phrases = Object.keys(links);
  if (!phrases.length) return text;
  const pattern = new RegExp(`(${phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  return text.split(pattern).map((part, i) => {
    const href = links[part];
    if (!href) return part;
    const external = href.startsWith('http');
    return (
      <a
        key={i}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer' : undefined}
      >
        {part}
      </a>
    );
  });
}

const FAQ_STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: { '@type': 'Answer', text: item.a },
  })),
};

export function CraftFaq() {
  return (
    <section id='faq' className='craft-band craft-faq' aria-labelledby='craft-faq-title'>
      <script
        type='application/ld+json'
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(FAQ_STRUCTURED_DATA).replace(/</g, '\\u003c'),
        }}
      />
      <div className='craft-band-head'>
        <h2 id='craft-faq-title'>FAQs</h2>
      </div>
      <div className='craft-faq-list'>
        {FAQ.map((item, index) => (
          <details key={item.q} style={{ '--i': index } as React.CSSProperties}>
            <summary>
              <span>{item.q}</span>
              <i aria-hidden='true' />
            </summary>
            <p>{withLinks(item.a, 'links' in item ? item.links : undefined)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
