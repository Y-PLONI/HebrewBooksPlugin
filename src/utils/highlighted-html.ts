interface HighlightedSegment {
  text: string;
  highlighted: boolean;
}

const highlightTags = new Set(['font', 'mark']);

export function parseHighlightedHtml(html: string, ownerDocument: Document = document): HighlightedSegment[] {
  const template = ownerDocument.createElement('template');
  template.innerHTML = html;
  const segments: HighlightedSegment[] = [];
  appendSegments(template.content, false, segments);
  return segments;
}

export function appendHighlightedHtml(target: HTMLElement, html: string): void {
  const segments = parseHighlightedHtml(html, target.ownerDocument);
  for (const segment of segments) {
    if (!segment.highlighted) {
      target.append(target.ownerDocument.createTextNode(segment.text));
      continue;
    }
    const match = target.ownerDocument.createElement('span');
    match.className = 'result-match';
    match.textContent = segment.text;
    target.append(match);
  }
}

function appendSegments(node: Node, highlighted: boolean, segments: HighlightedSegment[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      appendSegment(segments, child.textContent?.replace(/\s+/g, ' ') ?? '', highlighted);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    appendSegments(element, highlighted || highlightTags.has(element.localName), segments);
  }
}

function appendSegment(segments: HighlightedSegment[], text: string, highlighted: boolean): void {
  if (text === '') return;
  const previous = segments.at(-1);
  if (previous?.highlighted === highlighted) {
    previous.text += text;
  } else {
    segments.push({ text, highlighted });
  }
}
