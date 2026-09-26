import assert from 'node:assert/strict';
import test from 'node:test';
import type { Root } from 'mdast';
import { remarkSourceCitations } from './agent-citations.ts';

test('source references become compact links in table cells', () => {
  const tree: Root = { type:'root',children:[{type:'table',children:[{type:'tableRow',children:[{type:'tableCell',children:[{type:'text',value:'[1][2]'}]}]}]}] };
  remarkSourceCitations({sources:[{id:'1',title:'Coding comparison',url:'https://www.youtube.com/watch?v=abcdefghijk'}]})(tree);
  assert.deepEqual(tree.children[0],{type:'table',children:[{type:'tableRow',children:[{type:'tableCell',children:[
    {type:'link',url:'https://www.youtube.com/watch?v=abcdefghijk',title:'Source 1: Coding comparison',children:[{type:'text',value:'[1]'}]},
    {type:'text',value:'[2]'},
  ]}]}]});
});

test('does not create unsafe links or rewrite code and existing links', () => {
  const tree: Root = {type:'root',children:[{type:'paragraph',children:[{type:'text',value:'[1]'},
    {type:'inlineCode',value:'array[1]'}, {type:'link',url:'https://example.com',children:[{type:'text',value:'[1]'}]}]},
    {type:'code',value:'array[1]'}]};
  const original=structuredClone(tree);
  remarkSourceCitations({sources:[{id:'1',title:'Unsafe',url:'javascript:alert(1)'}]})(tree);
  assert.deepEqual(tree,original);
  remarkSourceCitations({sources:[{id:'1',title:'Safe',url:'https://www.youtube.com/watch?v=abcdefghijk'}]})(tree);
  assert.deepEqual((tree.children[0] as {children:unknown[]}).children.slice(1),(original.children[0] as {children:unknown[]}).children.slice(1));
  assert.deepEqual(tree.children[1],original.children[1]);
});
