import { describe, expect, it } from 'vitest';
import { isContextOverflow, extractChatContent } from '../../src/core/chat-response';

describe('isContextOverflow', () => {
	it('erkennt "context length"', () => {
		expect(isContextOverflow('this request exceeds the model context length of 8192 tokens')).toBe(true);
	});
	it('erkennt "context window" case-insensitive', () => {
		expect(isContextOverflow('CONTEXT WINDOW exceeded')).toBe(true);
	});
	it('erkennt "too many tokens"', () => {
		expect(isContextOverflow('error: too many tokens')).toBe(true);
	});
	it('false für unverdächtigen Fehlerbody', () => {
		expect(isContextOverflow('{"error":"model not found"}')).toBe(false);
	});
	it('false für leeren String', () => {
		expect(isContextOverflow('')).toBe(false);
	});
});

describe('extractChatContent', () => {
	it('extrahiert content + reasoning_content', () => {
		const res = { choices: [{ message: { content: 'Hallo', reasoning_content: 'denk' } }] };
		expect(extractChatContent(res)).toEqual({ content: 'Hallo', reasoning: 'denk' });
	});
	it('reasoning = "" wenn reasoning_content fehlt', () => {
		const res = { choices: [{ message: { content: 'Hallo' } }] };
		expect(extractChatContent(res)).toEqual({ content: 'Hallo', reasoning: '' });
	});
	it('null bei fehlendem content', () => {
		expect(extractChatContent({ choices: [{ message: {} }] })).toBeNull();
	});
	it('null bei fehlenden choices', () => {
		expect(extractChatContent({ error: { message: 'context length exceeded' } })).toBeNull();
	});
	it('null bei nicht-objekt-Input', () => {
		expect(extractChatContent(null)).toBeNull();
		expect(extractChatContent([])).toBeNull();
		expect(extractChatContent('string')).toBeNull();
	});
});
