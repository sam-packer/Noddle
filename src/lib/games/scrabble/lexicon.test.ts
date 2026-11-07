import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildTrie, textLexicon } from './lexicon';

const text = readFileSync('static/dict/enable.txt', 'utf8');

describe('text lexicon', () => {
	const lex = textLexicon(text);
	test('finds words at the start, middle and end of the list', () => {
		for (const w of ['AA', 'AAH', 'GIMLETS', 'BOARDS', 'GAME', 'ZYZZYVAS']) expect(lex.has(w)).toBe(true);
	});
	test('rejects words that are not there, and is case insensitive', () => {
		for (const w of ['', 'A', 'BOAR D', 'ZZZZZ', 'AAAA', 'ZYZZYVASS', 'TCA']) expect(lex.has(w)).toBe(false);
		expect(lex.has('game')).toBe(true);
	});
	test('agrees with a full set on a sample of every 97th word', () => {
		const words = text.trim().split('\n');
		const all = new Set(words);
		for (let i = 0; i < words.length; i += 97) {
			expect(lex.has(words[i])).toBe(true);
			expect(lex.has(words[i] + 'Q')).toBe(all.has(words[i] + 'q'));
		}
	}, 30000);
});

describe('trie', () => {
	const trie = buildTrie(text);
	test('holds the same words', () => {
		for (const w of ['AA', 'GIMLETS', 'ZYZZYVAS']) expect(trie.has(w)).toBe(true);
		for (const w of ['GIMLET S', 'GIML', 'ZYZZYVASS']) expect(trie.has(w)).toBe(false);
	});
});
