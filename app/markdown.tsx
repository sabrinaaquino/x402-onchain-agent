"use client";

// Tiny, dependency-free Markdown renderer.
// Supports: #..###### headings, **bold**, *italic*/_italic_, `code`,
// fenced ```code blocks```, - / * / + and 1. lists, > blockquotes, --- rules,
// | pipe | tables |, [links](url), and paragraphs. Good enough for model-authored
// briefings and chat replies without pulling in a full markdown dependency.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Split a markdown table row "| a | b |" into trimmed cells.
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Split on unescaped pipes.
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

// Is this line a table separator row, e.g. |---|:--:|---|
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}

// Inline formatting on an already HTML-escaped string.
function inline(s: string): string {
  return s
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(md: string): string {
  // Strip stray control characters that models occasionally emit (e.g. U+001A),
  // keeping tab/newline. Prevents odd glyphs in the rendered output.
  const cleaned = md.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const lines = cleaned.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line.trim())) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      closeList();
      out.push("<hr/>");
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(escapeHtml(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // Table: a header row followed by a |---|---| separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList();
      const headers = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2; // consume header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        if (isTableSeparator(lines[i])) {
          i++;
          continue;
        }
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      const al = (idx: number) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
      let html = "<table><thead><tr>";
      headers.forEach((h, idx) => {
        html += `<th${al(idx)}>${inline(escapeHtml(h))}</th>`;
      });
      html += "</tr></thead><tbody>";
      for (const row of bodyRows) {
        html += "<tr>";
        headers.forEach((_, idx) => {
          html += `<td${al(idx)}>${inline(escapeHtml(row[idx] ?? ""))}</td>`;
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      out.push(html);
      continue;
    }

    // Blockquote
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      closeList();
      out.push(`<blockquote>${inline(escapeHtml(bq[1]))}</blockquote>`);
      i++;
      continue;
    }

    // Ordered list item
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(escapeHtml(ol[1]))}</li>`);
      i++;
      continue;
    }

    // Unordered list item
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(escapeHtml(ul[1]))}</li>`);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-structural lines)
    closeList();
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+[.)]\s|```|\s*(---|\*\*\*|___)\s*$)/.test(lines[i]) &&
      // stop if a table starts on the next line (header row + separator)
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }

  closeList();
  return out.join("\n");
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={`md ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(children) }}
    />
  );
}
