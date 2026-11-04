// Table view: a prebuilt Buzz plugin (API v1), one self-contained ES module.
//
// Why it exists: Buzz draws a Markdown table inside the message column, so a
// wide table needs horizontal scrolling and is hard to read. This plugin adds
// "View tables" to the message ⋯ menu of each message that holds a GitHub
// Flavored Markdown (GFM) table. The entry opens a full-screen dialog that
// shows every table of that message with the whole window width.
//
// Trust: message text comes from any member of the channel, so it is
// untrusted. The plugin parses the tables itself and gives each cell to React
// as text. It never sets raw HTML, never creates links and asks for no host
// grants, network origins or processes. Only `<br>` in a cell becomes a line
// break, because writers use it for multi-line cells and React draws that
// element, not the message text.

// Cordis starts apply() only after these host services exist.
export const inject = ["react", "conversation"];

const ACTION = Object.freeze({ id: "view-tables", title: "View tables" });
const LOG_PREFIX = "[table-view]";
// matches() runs for each visible row on every render; remember this many
// parsed messages so scrolling does not parse the same text again.
const MAX_CACHED_MESSAGES = 500;
// GFM: up to three spaces of indent; four or more make an indented code block.
const MAX_BLOCK_INDENT = 3;
// GFM fenced code: a run of three or more backticks or tildes opens a fence.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Lines that start another block end a table body (GFM "beginning of another
// block-level structure"): ATX heading, block quote, fence, thematic break.
const BLOCK_START_RE = /^ {0,3}(#{1,6}(\s|$)|>|`{3,}|~{3,}|([-*_])(\s*\3){2,}\s*$)/;
const DELIMITER_CELL_RE = /^:?-+:?$/;
const ESCAPED_PIPE_RE = /\\\|/g;
// Quick text test before a full parse: a delimiter row always has a pipe and a dash.
const TABLE_HINT_RE = /\|[^\n]*-|-[^\n]*\|/;
// Inline Markdown that a cell may hold. Each match draws as text in a React
// element of the plugin, never as HTML: code span, strong, strikethrough,
// emphasis, link (label only; one level of balanced parentheses in the
// address, as CommonMark allows), autolink and a backslash escape.
const INLINE_RE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)|<((?:https?|mailto):[^>\s]+)>|\\([!-/:-@[-`{-~])/g;
const LINE_BREAK_RE = /<br\s*\/?>/gi;
const ALIGN = Object.freeze({ LEFT: "left", CENTER: "center", RIGHT: "right" });

// Host theme roles (buzz-app shared/styles/tokens.css) with system colors as
// fallback, so the dialog follows light and dark mode without its own CSS.
const COLOR = Object.freeze({
  text: "var(--text, CanvasText)",
  muted: "var(--text-muted, GrayText)",
  surface: "var(--surface, Canvas)",
  stripe: "var(--surface-hover, rgb(127 127 127 / 8%))",
  header: "var(--surface-control, rgb(127 127 127 / 14%))",
  border: "var(--border, rgb(127 127 127 / 35%))",
  focus: "var(--focus, Highlight)",
});
const MONO_FONT = "var(--font-mono, ui-monospace, monospace)";
// A table scrolls inside its own frame, so its sticky header stays visible;
// the frame is a little shorter than the window to leave room for the title bar.
const TABLE_MAX_HEIGHT = "calc(100vh - 8rem)";
// Wide enough for a sentence, narrow enough that one long cell does not push
// the other columns off screen.
const CELL_MAX_WIDTH = "40em";
const ICON_SIZE = 16;
const STYLE = Object.freeze({
  dialog: {
    width: "100vw",
    height: "100vh",
    maxWidth: "100vw",
    maxHeight: "100vh",
    margin: 0,
    padding: 0,
    border: "none",
    background: COLOR.surface,
    color: COLOR.text,
  },
  frame: { display: "flex", flexDirection: "column", height: "100%" },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.75rem 1.25rem",
    borderBottom: `1px solid ${COLOR.border}`,
  },
  title: { margin: 0, fontSize: "1rem", fontWeight: 600, flex: "1 1 auto" },
  close: {
    font: "inherit",
    color: COLOR.text,
    background: "transparent",
    border: `1px solid ${COLOR.border}`,
    borderRadius: "6px",
    padding: "0.25rem 0.75rem",
    cursor: "pointer",
    outlineColor: COLOR.focus,
  },
  body: { flex: "1 1 auto", overflow: "auto", padding: "1rem 1.25rem" },
  section: { marginBottom: "1.5rem" },
  caption: { margin: "0 0 0.5rem", fontSize: "0.875rem", fontWeight: 600, color: COLOR.muted },
  // The frame hugs a narrow table and stops at the dialog width for a wide one.
  scroller: { width: "fit-content", maxWidth: "100%", overflow: "auto", maxHeight: TABLE_MAX_HEIGHT, border: `1px solid ${COLOR.border}`, borderRadius: "6px" },
  // Natural column widths (each up to CELL_MAX_WIDTH) instead of squeezing
  // every column into the window: a squeezed column wraps after each word.
  table: { width: "max-content", borderCollapse: "collapse", fontSize: "0.875rem", lineHeight: 1.45 },
  th: {
    position: "sticky",
    top: 0,
    background: COLOR.header,
    backdropFilter: "blur(8px)",
    fontWeight: 600,
    padding: "0.4rem 0.75rem",
    borderBottom: `1px solid ${COLOR.border}`,
    borderRight: `1px solid ${COLOR.border}`,
    verticalAlign: "bottom",
    maxWidth: CELL_MAX_WIDTH,
    overflowWrap: "break-word",
  },
  td: {
    padding: "0.4rem 0.75rem",
    borderBottom: `1px solid ${COLOR.border}`,
    borderRight: `1px solid ${COLOR.border}`,
    verticalAlign: "top",
    maxWidth: CELL_MAX_WIDTH,
    overflowWrap: "break-word",
  },
  code: { fontFamily: MONO_FONT, fontSize: "0.92em" },
  empty: { color: COLOR.muted },
});

// ---- GFM table parser -----------------------------------------------------------

function leadingSpaces(line) {
  return line.length - line.trimStart().length;
}

// Split one table row on pipes that are not escaped. GFM keeps `\|` as a
// literal pipe in the cell, also inside code spans.
function splitRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "|") {
      current += "\\|";
      index += 1;
    } else if (char === "|") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim().replace(ESCAPED_PIPE_RE, "|"));
}

function cellAlign(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return ALIGN.CENTER;
  if (right) return ALIGN.RIGHT;
  return left ? ALIGN.LEFT : null;
}

// The delimiter row decides that the line above is a table header. It
// returns the column alignments, or null when the line is no delimiter row.
function parseDelimiter(line) {
  if (!line.includes("|") || leadingSpaces(line) > MAX_BLOCK_INDENT) return null;
  const cells = splitRow(line);
  return cells.every((cell) => DELIMITER_CELL_RE.test(cell)) ? cells.map(cellAlign) : null;
}

function isHeaderCandidate(line) {
  return line.includes("|") && leadingSpaces(line) <= MAX_BLOCK_INDENT && !BLOCK_START_RE.test(line);
}

// GFM: a body row with fewer cells is padded, extra cells are dropped.
function fitRow(cells, width) {
  const row = cells.slice(0, width);
  while (row.length < width) row.push("");
  return row;
}

// Read the body rows that follow a delimiter row; returns the rows and the
// index of the first line after the table.
function readBody(lines, start, width) {
  const rows = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || BLOCK_START_RE.test(line)) break;
    rows.push(fitRow(splitRow(line), width));
    index += 1;
  }
  return { rows, next: index };
}

// Track fenced code blocks: a table inside a fence is code, not a table.
// Returns the open fence after this line, or null when no fence is open.
function nextFence(line, fence) {
  const match = FENCE_RE.exec(line);
  if (!fence) {
    if (!match) return null;
    // A backtick fence's info string must not hold a backtick (GFM).
    const marker = match[1];
    return marker[0] === "`" && match[2].includes("`") ? null : marker;
  }
  const closes = match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim();
  return closes ? null : fence;
}

function tableAt(lines, index) {
  const line = lines[index];
  if (!isHeaderCandidate(line) || index + 1 >= lines.length) return null;
  const align = parseDelimiter(lines[index + 1]);
  if (!align) return null;
  const header = splitRow(line);
  // GFM: the header and the delimiter row must have the same cell count.
  if (header.length !== align.length) return null;
  const body = readBody(lines, index + 2, header.length);
  return { table: { header, align, rows: body.rows }, next: body.next };
}

/**
 * Find every GFM table in a message, in order. Lines inside fenced code
 * blocks are skipped. Each table is `{ header, align, rows }`; cells are raw
 * Markdown text, drawn later by `renderInline` as React text only.
 */
export function findTables(markdown) {
  if (typeof markdown !== "string" || !TABLE_HINT_RE.test(markdown)) return [];
  const lines = markdown.split(/\r\n|\n|\r/);
  const tables = [];
  let fence = null;
  let index = 0;
  while (index < lines.length) {
    const wasInFence = fence !== null;
    fence = nextFence(lines[index], fence);
    const found = wasInFence || fence ? null : tableAt(lines, index);
    if (found) {
      tables.push(found.table);
      index = found.next;
    } else {
      index += 1;
    }
  }
  return tables;
}

// ---- Message matching -----------------------------------------------------------

// Diff messages carry a raw patch as content; its lines are not Markdown.
function messageText(message) {
  if (!message || message.diff || typeof message.content !== "string") return "";
  return message.content;
}

// Remember parsed tables per message id; an edit changes the content and
// replaces the entry. The oldest entry goes first when the cache is full.
function createTableCache() {
  const cache = new Map();
  return function tablesOf(message) {
    const text = messageText(message);
    const key = message?.id;
    const hit = key === undefined ? undefined : cache.get(key);
    if (hit && hit.text === text) return hit.tables;
    const tables = findTables(text);
    if (key === undefined) return tables;
    cache.delete(key);
    cache.set(key, { text, tables });
    if (cache.size > MAX_CACHED_MESSAGES) cache.delete(cache.keys().next().value);
    return tables;
  };
}

// ---- Rendering --------------------------------------------------------------------

// Draw text with `<br>` as line breaks; every other part stays plain text.
function withLineBreaks(h, text, keyPrefix) {
  const parts = text.split(LINE_BREAK_RE);
  if (parts.length === 1) return [text];
  const nodes = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(h("br", { key: `${keyPrefix}br${index}` }));
    if (part) nodes.push(part);
  });
  return nodes;
}

function inlineNode(h, match, key) {
  const [, , code, strong, strongAlt, strike, em, linkLabel, autolink, escaped] = match;
  if (code !== undefined) return h("code", { key, style: STYLE.code }, code.trim() || code);
  if (strong !== undefined || strongAlt !== undefined) return h("strong", { key }, renderInline(h, strong ?? strongAlt, key));
  if (strike !== undefined) return h("del", { key }, renderInline(h, strike, key));
  if (em !== undefined) return h("em", { key }, renderInline(h, em, key));
  // Links draw as their label only: a cell must not open an address that a
  // channel member chose. The message itself keeps the host's link handling.
  if (linkLabel !== undefined) return h("span", { key }, renderInline(h, linkLabel, key));
  return autolink ?? escaped;
}

/**
 * Draw the inline Markdown of one cell as React nodes. Strings become React
 * text nodes, which React escapes, so cell text can never become HTML.
 */
export function renderInline(h, text, keyPrefix = "c") {
  const nodes = [];
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    if (match.index > last) nodes.push(...withLineBreaks(h, text.slice(last, match.index), `${keyPrefix}t${count}`));
    nodes.push(inlineNode(h, match, `${keyPrefix}i${count}`));
    last = match.index + match[0].length;
    count += 1;
  }
  if (last < text.length) nodes.push(...withLineBreaks(h, text.slice(last), `${keyPrefix}t${count}`));
  return nodes;
}

function TableIcon(React) {
  const h = React.createElement;
  return function Icon() {
    return h(
      "svg",
      {
        width: ICON_SIZE,
        height: ICON_SIZE,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
      h("path", { d: "M3 10h18M3 15h18M9 4v16M15 4v16" }),
    );
  };
}

function renderTable(h, table, tableIndex) {
  const cellStyle = (base, column) => (table.align[column] ? { ...base, textAlign: table.align[column] } : base);
  const head = h(
    "thead",
    null,
    h(
      "tr",
      null,
      table.header.map((cell, column) =>
        h("th", { key: column, scope: "col", style: cellStyle(STYLE.th, column) }, renderInline(h, cell, `h${tableIndex}-${column}`)),
      ),
    ),
  );
  const body = h(
    "tbody",
    null,
    table.rows.map((row, rowIndex) =>
      h(
        "tr",
        { key: rowIndex, style: rowIndex % 2 ? { background: COLOR.stripe } : undefined },
        row.map((cell, column) =>
          h("td", { key: column, style: cellStyle(STYLE.td, column) }, renderInline(h, cell, `b${tableIndex}-${rowIndex}-${column}`)),
        ),
      ),
    ),
  );
  return h("table", { style: STYLE.table }, head, body);
}

function renderSections(h, tables, titleId) {
  if (!tables.length) return h("p", { style: STYLE.empty }, "This message has no table now.");
  // One table needs no caption: the dialog title already names it.
  const captioned = tables.length > 1;
  return tables.map((table, index) =>
    h(
      "section",
      { key: index, style: STYLE.section, "aria-labelledby": captioned ? `${titleId}-${index}` : titleId },
      captioned ? h("h3", { id: `${titleId}-${index}`, style: STYLE.caption }, `Table ${index + 1} of ${tables.length}`) : null,
      // Focusable so keyboard users can scroll a wide table with the arrow keys.
      h("div", { style: STYLE.scroller, tabIndex: 0 }, renderTable(h, table, index)),
    ),
  );
}

// Open as a modal so the dialog sits in the browser top layer above the
// message list, traps focus and closes on Escape. Older engines without
// showModal still show it through the `open` attribute.
function useModal(React, ref) {
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, [ref]);
}

function TablesDialog(React, tablesOf) {
  const h = React.createElement;
  return function TablesDialogView({ message, close }) {
    const ref = React.useRef(null);
    const titleId = `table-view-${React.useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
    const tables = tablesOf(message);
    useModal(React, ref);
    // "close" fires for Escape and for dialog.close(); the host then unmounts us.
    return h(
      "dialog",
      { ref, style: STYLE.dialog, "aria-labelledby": titleId, onClose: close },
      h(
        "div",
        { style: STYLE.frame },
        h(
          "header",
          { style: STYLE.bar },
          h("h2", { id: titleId, style: STYLE.title }, tables.length === 1 ? "Table" : `Tables (${tables.length})`),
          h("button", { type: "button", style: STYLE.close, onClick: close, autoFocus: true }, "Close"),
        ),
        h("div", { style: STYLE.body }, renderSections(h, tables, titleId)),
      ),
    );
  };
}

export function apply(ctx) {
  const React = ctx.react;
  const tablesOf = createTableCache();
  const hasTables = (message) => {
    try {
      return tablesOf(message).length > 0;
    } catch (error) {
      // The host skips a throwing matcher; log it so a parser bug is visible.
      console.warn(`${LOG_PREFIX} table parse failed`, { message: message?.id, error });
      return false;
    }
  };
  ctx.conversation.registerMessageAction({
    id: ACTION.id,
    title: ACTION.title,
    icon: TableIcon(React),
    matches: hasTables,
    component: TablesDialog(React, tablesOf),
  });
}
