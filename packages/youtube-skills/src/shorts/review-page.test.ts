import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

import { startReviewServer, type ReviewServer } from './review';

/**
 * Runs the page's own script against the real server with just enough DOM to drive it: elements,
 * text, events, focus, and a <video> with a settable currentTime.
 */
class FakeNode {
  parent?: FakeElement;
  get textContent(): string {
    return '';
  }
}

class FakeText extends FakeNode {
  constructor(readonly data: string) {
    super();
  }

  override get textContent(): string {
    return this.data;
  }
}

class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  children: FakeNode[] = [];
  className = '';
  value = '';
  checked = false;
  hidden = false;
  currentTime = 0;
  paused = true;
  muted = false;

  constructor(tag: string, private readonly page: FakePage) {
    super();
    this.tagName = tag.toUpperCase();
  }

  get classList() {
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const set = (next: Set<string>) => {
      this.className = [...next].join(' ');
    };
    return {
      contains: (name: string) => classes().has(name),
      add: (name: string) => set(classes().add(name)),
      remove: (name: string) => {
        const next = classes();
        next.delete(name);
        set(next);
      },
      toggle: (name: string, on?: boolean) => {
        const next = classes();
        if (on ?? !next.has(name)) next.add(name);
        else next.delete(name);
        set(next);
      },
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'hidden') this.hidden = true;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string): void {
    const event = { type, target: this, currentTarget: this, preventDefault: () => undefined };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  append(...nodes: unknown[]): void {
    for (const item of nodes) {
      // Like the DOM, anything that isn't a node (null included) becomes text.
      const node = item instanceof FakeNode ? item : new FakeText(String(item));
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...nodes);
  }

  override get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren(new FakeText(value));
  }

  all(): FakeElement[] {
    return this.children.filter((child): child is FakeElement => child instanceof FakeElement).flatMap((child) => [child, ...child.all()]);
  }

  querySelector(selector: string): FakeElement | null {
    return this.all().find((element) => element.tagName === selector.toUpperCase()) ?? null;
  }

  contains(node: FakeNode): boolean {
    return node === this || this.all().includes(node as FakeElement);
  }

  focus(): void {
    this.page.activeElement = this;
    this.dispatch('focus');
  }

  blur(): void {
    if (this.page.activeElement === this) this.page.activeElement = undefined;
    this.dispatch('blur');
  }

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
}

class FakePage {
  activeElement?: FakeElement;
  readonly byId = new Map<string, FakeElement>();
  readonly context: Record<string, unknown>;
  private stopped = false;

  constructor(base: string, script: string, hash: string) {
    for (const id of ['title', 'count-moments', 'count-hooks', 'count-player', 'live', 'view', 'error']) {
      const element = this.element('div');
      if (id === 'error') element.hidden = true;
      this.byId.set(id, element);
    }
    const document = {
      createElement: (tag: string) => this.element(tag),
      createTextNode: (text: string) => new FakeText(text),
      getElementById: (id: string) => this.byId.get(id) ?? null,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
      get activeElement() {
        return page.activeElement;
      },
    };
    const page = this;
    this.context = {
      document,
      Node: FakeNode,
      location: { hash },
      fetch: (url: string, init?: RequestInit) => fetch(new URL(url, base), init),
      setTimeout: (callback: () => void, ms: number) => (this.stopped ? undefined : setTimeout(callback, ms)),
      console,
    };
    this.context.window = { addEventListener: () => undefined, scrollTo: () => undefined };
    runInNewContext(script, this.context);
  }

  element(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  stop(): void {
    this.stopped = true;
  }

  all(): FakeElement[] {
    return [...this.byId.values()].flatMap((element) => [element, ...element.all()]);
  }

  find(predicate: (element: FakeElement) => boolean): FakeElement {
    const found = this.all().find(predicate);
    if (!found) throw new Error('Element not found.');
    return found;
  }
}

const directories: string[] = [];
const servers: ReviewServer[] = [];
const pages: FakePage[] = [];
afterEach(async () => {
  pages.splice(0).forEach((page) => page.stop());
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the page.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function open(): Promise<{ project: string; server: ReviewServer; page: FakePage }> {
  const project = await mkdtemp(join(tmpdir(), 'shorts-review-page-'));
  directories.push(project);
  await mkdir(join(project, 'render'));
  await writeFile(join(project, 'edl.json'), JSON.stringify({ videoId: 'abcdefghijk', shorts: [{ id: 'S1', title: 'Minions', cuts: [{ from: 'a', to: 'b' }] }] }));
  await writeFile(join(project, 'render', 'S1-overlay.mp4'), 'blue render');
  const server = await startReviewServer({ project });
  servers.push(server);
  const html = await (await fetch(server.url)).text();
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1]!;
  const page = new FakePage(server.url, script, '#player/S1');
  pages.push(page);
  await until(() => Boolean(page.context.state) && page.all().some((element) => element.tagName === 'VIDEO'));
  return { project, server, page };
}

function parts(page: FakePage) {
  const input = page.find((element) => element.attributes.get('aria-label') === 'Comment');
  const form = input.parent!;
  const error = form.parent!.children[form.parent!.children.indexOf(form) + 1] as FakeElement;
  const video = page.find((element) => element.tagName === 'VIDEO');
  return { input, form, error, video, at: form.children[0] as FakeElement };
}

async function readComments(project: string): Promise<{ atSec: number; text: string; file?: string; revision?: number }[]> {
  try {
    return JSON.parse(await readFile(join(project, 'review.json'), 'utf8')).shorts.S1.comments;
  } catch {
    return [];
  }
}

describe('review page', () => {
  test('keeps a comment draft and its pinned moment when the save is rejected, and saves it on retry', async () => {
    const { project, page } = await open();
    const { input, form, error, video, at } = parts(page);
    const revision = (page.context.state as { shorts: { videos: { revision: number }[] }[] }).shorts[0]!.videos[0]!.revision;

    video.currentTime = 3.2;
    input.focus();
    await writeFile(join(project, 'review.json'), '{ broken');
    input.value = 'Move the title lower';
    form.dispatch('submit');
    await until(() => !error.hidden);

    expect(error.textContent).toContain('not valid JSON');
    expect(input.value).toBe('Move the title lower');
    video.currentTime = 5;
    expect(at.textContent).toBe('0:03.2');

    await rm(join(project, 'review.json'));
    error.all().find((element) => element.tagName === 'BUTTON')!.dispatch('click');
    await until(async () => (await readComments(project)).length === 1);
    await until(() => input.value === '');
    expect(await readComments(project)).toEqual([expect.objectContaining({ atSec: 3.2, text: 'Move the title lower', file: 'render/S1-overlay.mp4', revision })]);
    expect(error.hidden).toBe(true);
  });

  test('keeps the draft and shows a retryable error when the server is gone', async () => {
    const { server, page } = await open();
    const { input, form, error } = parts(page);
    input.focus();
    input.value = 'Start on the laugh';
    await server.close();
    form.dispatch('submit');
    await until(() => !error.hidden);
    expect(error.textContent).toContain("can't be reached");
    expect(error.all().some((element) => element.textContent === 'Retry')).toBe(true);
    expect(input.value).toBe('Start on the laugh');

    page.find((element) => element.tagName === 'BUTTON' && element.textContent === 'Approve').dispatch('click');
    await until(() => !page.byId.get('error')!.hidden);
    expect(page.byId.get('error')!.textContent).toContain("can't be reached");
  });

  test('pins the render when a comment starts, and shows an earlier render\'s approval and notes as no longer current', async () => {
    const { project, page } = await open();
    const { input, form, video } = parts(page);
    const before = video.attributes.get('src');

    page.find((element) => element.tagName === 'BUTTON' && element.textContent === 'Approve').dispatch('click');
    await until(() => page.find((element) => element.textContent === 'Approve' && element.tagName === 'BUTTON').className.includes('active'));

    video.currentTime = 1;
    input.focus();
    input.value = 'Face is cut off here';
    // A new render lands at the same path while the person is still typing.
    await writeFile(join(project, 'render', 'S1-overlay.mp4'), 'red render');
    const later = new Date(Date.now() + 5_000);
    await utimes(join(project, 'render', 'S1-overlay.mp4'), later, later);
    await until(() => parts(page).video.attributes.get('src') !== before, 6_000);
    form.dispatch('submit');
    await until(async () => (await readComments(project)).length === 1);

    const state = page.context.state as { review: { shorts: Record<string, { current: string; statusStale: boolean; comments: { stale: boolean }[] }> } };
    await until(() => (page.context.state as typeof state).review.shorts.S1!.comments.length === 1);
    const s1 = (page.context.state as typeof state).review.shorts.S1!;
    expect(s1.current).toBe('pending');
    expect(s1.statusStale).toBe(true);
    expect(s1.comments[0]!.stale).toBe(true);
    expect(page.find((element) => element.tagName === 'BUTTON' && element.textContent === 'Pending').className).toContain('active');
    expect(page.all().some((element) => element.textContent.startsWith('Marked approved on an earlier render'))).toBe(true);
    expect(page.all().some((element) => element.tagName === 'LI' && element.className.includes('previous'))).toBe(true);
  }, 15_000);
});
