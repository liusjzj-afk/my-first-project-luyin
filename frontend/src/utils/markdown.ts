export function stripSectionMarkers(content: string) {
  return content
    .replace(/<!--\s*(?:SUMMARY|IA)_(?:START|END)\s*-->/gi, "")
    .trim();
}
