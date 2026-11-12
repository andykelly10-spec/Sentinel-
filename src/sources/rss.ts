import { decodeEntities } from "../text";

export function rssItems(xml: string): string[] {
  if (!/<rss[\s>]/.test(xml)) {
    throw new Error("response was not an RSS feed");
  }
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g), (match) => match[1] ?? "");
}

export function tagText(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!match?.[1]) return "";
  const inner = match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(inner).trim();
}
