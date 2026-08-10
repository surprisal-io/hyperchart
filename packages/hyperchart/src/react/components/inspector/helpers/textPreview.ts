export type TextPreview = {
	text: string;
	truncated: boolean;
};

export function createBufferedTextPreview(text: string, maxCharacters = 1_000): TextPreview {
	const characterLimit = Math.max(1, Math.floor(maxCharacters));
	if (text.length <= characterLimit) return { text, truncated: false };
	let end = characterLimit;
	const open = text.lastIndexOf("{", end);
	const close = text.lastIndexOf("}", end);
	if (open > close) end = open;
	return { text: `${text.slice(0, end).trimEnd()}\n…`, truncated: true };
}

export function createTextPreview(text: string, maxLines: number, maxCharacters = 2_000): TextPreview {
	const lineLimit = Math.max(1, Math.floor(maxLines));
	const characterLimit = Math.max(1, Math.floor(maxCharacters));
	let end = Math.min(text.length, characterLimit);
	let lineBreaks = 0;

	for (let index = 0; index < end; index += 1) {
		if (text.charCodeAt(index) !== 10) continue;
		lineBreaks += 1;
		if (lineBreaks < lineLimit) continue;
		end = index;
		break;
	}

	if (end >= text.length) return { text, truncated: false };
	return {
		text: `${text.slice(0, end).trimEnd()}\n…`,
		truncated: true,
	};
}
