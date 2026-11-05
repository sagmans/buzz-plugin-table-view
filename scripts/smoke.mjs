#!/usr/bin/env node
// Smoke scenarios: drive the real plugin.js with a fake Buzz context in Node.
//
// Why: the plugin runs inside the Buzz desktop app, which has no headless test
// mode. This script stands in for the host services the plugin injects
// (React and conversation) so the user journeys the README promises are
// checked on every push:
//   - menu entry: registered once, shown only on messages with a GFM table;
//   - parsing: alignment, escaped pipes, short and long rows, tables inside
//     code fences, look-alike text, several tables, edited messages;
//   - dialog: every table drawn, title and captions, Close and Escape;
//   - trust: cell text stays React text (no raw HTML, no links), only `<br>`
//     becomes a line break; long hostile text parses and draws fast.
//
// Usage: node scripts/smoke.mjs [path/to/plugin.js]   (default: plugin/plugin.js)

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PLUGIN = "plugin/plugin.js";
const ACTION_ID = "view-tables";
const ACTION_TITLE = "View tables";
// Session object the host passes; this plugin must not depend on it.
const SESSION = Object.freeze({});
// Size of the hostile texts: a few relay-sized messages of one character.
const HOSTILE_LENGTH = 65536;
// A linear pass over HOSTILE_LENGTH takes a few milliseconds; a quadratic
// one takes seconds. The budget sits far from both, so slow CI does not flap.
const HOSTILE_BUDGET_MS = 500;
// Must match the plugin's cap on drawn cells per table.
const MAX_DRAWN_CELLS = 50_000;

class SmokeFailure extends Error {
  constructor(scenario, message, details) {
    const suffix = details === undefined ? "" : ` -- ${JSON.stringify(details)}`;
    super(`${scenario}: ${message}${suffix}`);
    this.name = "SmokeFailure";
  }
}

// ---- Fake React: elements as plain objects, function components expanded ----------

function createReact() {
  let hooks = null;
  let cursor = 0;
  let ids = 0;
  const slot = (init) => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = init();
    return hooks[index];
  };
  const React = {
    effects: [],
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useRef: (initial) => slot(() => ({ current: initial })),
    useMemo: (factory) => factory(),
    useId: () => slot(() => `:r${ids++}:`),
    useEffect: (effect) => React.effects.push(effect),
    // Run one component with a fresh hook state and expand its subtree.
    render(element) {
      if (Array.isArray(element)) return element.map((child) => React.render(child));
      if (!element || typeof element !== "object") return element;
      if (typeof element.type === "function") {
        hooks = [];
        cursor = 0;
        return React.render(element.type({ ...element.props, children: element.children }));
      }
      return { ...element, children: element.children.map((child) => React.render(child)) };
    },
  };
  return React;
}

// ---- Tree helpers -------------------------------------------------------------------

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (!node || typeof node !== "object") return;
  visit(node);
  node.children.forEach((child) => walk(child, visit));
}

function findAll(node, type) {
  const found = [];
  walk(node, (element) => element.type === type && found.push(element));
  return found;
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node === null || node === undefined || node === false) return "";
  if (typeof node !== "object") return String(node);
  if (node.type === "br") return "\n";
  return textOf(node.children);
}

// ---- Fake host ------------------------------------------------------------------------

async function loadPlugin(pluginPath) {
  const module = await import(`${pathToFileURL(resolve(pluginPath)).href}?run=${Date.now()}`);
  const React = createReact();
  const actions = [];
  const ctx = {
    react: React,
    conversation: { registerMessageAction: (action) => actions.push(action) },
    effect: () => undefined,
  };
  if (!module.inject?.includes("react") || !module.inject?.includes("conversation"))
    throw new SmokeFailure("load", "inject must list react and conversation", module.inject);
  module.apply(ctx);
  return { React, actions };
}

let nextId = 0;
const message = (content, extra = {}) => ({ id: `message-${nextId++}`, channelId: "channel", authorId: "author", createdAt: 0, content, ...extra });

// Open the dialog as the host does after the menu click, and return its tree.
function openDialog(host, msg) {
  const [action] = host.actions;
  const closed = [];
  host.React.effects.length = 0;
  const tree = host.React.render(host.React.createElement(action.component, { message: msg, session: SESSION, close: () => closed.push(true), canOpen: () => false, open: () => undefined }));
  return { tree, closed, effects: [...host.React.effects] };
}

function tablesIn(tree) {
  return findAll(tree, "table").map((table) => ({
    header: findAll(table, "th").map((cell) => textOf(cell)),
    align: findAll(table, "th").map((cell) => cell.props.style?.textAlign ?? null),
    rows: findAll(table, "tbody").flatMap((body) => findAll(body, "tr").map((row) => findAll(row, "td").map((cell) => textOf(cell)))),
  }));
}

function expectEqual(scenario, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new SmokeFailure(scenario, `${label} differs`, { actual, expected });
}

// ---- Scenarios --------------------------------------------------------------------------

const SIMPLE = ["Intro text.", "", "| Name | Size | Note |", "| :--- | ---: | :---: |", "| a | 1 | x |", "| b | 22 | y |", "", "After."].join("\n");

const scenarios = {
  "registers one View tables entry"(host) {
    expectEqual("register", "action count", host.actions.length, 1);
    const [action] = host.actions;
    expectEqual("register", "id and title", [action.id, action.title], [ACTION_ID, ACTION_TITLE]);
    if (typeof action.icon !== "function") throw new SmokeFailure("register", "icon must be a component");
    const icon = host.React.render(host.React.createElement(action.icon));
    expectEqual("register", "icon is decorative", icon.props["aria-hidden"], "true");
  },

  "menu entry only on messages with a GFM table"(host) {
    const [action] = host.actions;
    const cases = [
      ["simple table", SIMPLE, true],
      ["plain text", "Just a note | with a pipe - and a dash.", false],
      ["pipes without delimiter row", "| a | b |\n| c | d |", false],
      ["header and delimiter cell counts differ", "| a | b |\n| --- |\n| 1 | 2 |", false],
      ["table inside a backtick fence", "```md\n| a | b |\n| - | - |\n```", false],
      ["table inside a tilde fence", "~~~\n| a | b |\n|---|---|\n~~~", false],
      ["table after a closed fence", "```\ncode\n```\n| a | b |\n|---|---|\n| 1 | 2 |", true],
      ["indented code block", "    | a | b |\n    |---|---|", false],
      ["tab-indented code block", "\t| a | b |\n\t|---|---|", false],
      ["table without outer pipes", "a | b\n--- | ---\n1 | 2", true],
      ["diff message", SIMPLE, false, { diff: { truncated: false } }],
      ["empty content", "", false],
    ];
    for (const [label, content, expected, extra] of cases) {
      expectEqual("matches", label, action.matches(message(content, extra), SESSION), expected);
    }
    expectEqual("matches", "non-string content", action.matches({ id: "odd", content: 42 }, SESSION), false);
    expectEqual("matches", "missing message", action.matches(undefined, SESSION), false);
  },

  "edited message is parsed again"(host) {
    const [action] = host.actions;
    const msg = message("no table yet");
    expectEqual("edit", "before edit", action.matches(msg, SESSION), false);
    expectEqual("edit", "after edit", action.matches({ ...msg, content: SIMPLE }, SESSION), true);
    expectEqual("edit", "table removed", action.matches({ ...msg, content: "gone" }, SESSION), false);
  },

  "dialog shows the table with alignment"(host) {
    const { tree, effects } = openDialog(host, message(SIMPLE));
    expectEqual("dialog", "root element", tree.type, "dialog");
    if (!effects.length) throw new SmokeFailure("dialog", "the dialog must open itself as a modal in an effect");
    expectEqual("dialog", "tables", tablesIn(tree), [
      { header: ["Name", "Size", "Note"], align: ["left", "right", "center"], rows: [["a", "1", "x"], ["b", "22", "y"]] },
    ]);
    expectEqual("dialog", "title", textOf(findAll(tree, "h2")), "Table");
    expectEqual("dialog", "no caption for one table", findAll(tree, "h3").length, 0);
    const labelled = tree.props["aria-labelledby"];
    expectEqual("dialog", "title labels the dialog", findAll(tree, "h2")[0].props.id, labelled);
  },

  "rows are fitted and pipes unescaped"(host) {
    const content = ["| A | B |", "|---|---|", "| only |", "| 1 | 2 | 3 |", "| x \\| y | `a\\|b` |"].join("\n");
    const { tree } = openDialog(host, message(content));
    expectEqual("fit", "rows", tablesIn(tree)[0].rows, [["only", ""], ["1", "2"], ["x | y", "a|b"]]);
  },

  "table body ends at a blank line or a new block"(host) {
    const content = ["| A |", "|---|", "| 1 |", "# Heading", "| not a row |", "", "| B |", "| - |", "| 2 |", "> quote", "", "| C |", "| - |", "| 3 |", "- item", "", "| D |", "| - |", "| 4 |", "1. item"].join("\n");
    const { tree } = openDialog(host, message(content));
    expectEqual("blocks", "tables", tablesIn(tree).map((table) => table.rows), [[["1"]], [["2"]], [["3"]], [["4"]]]);
  },

  "several tables get captions and a count"(host) {
    const content = `${SIMPLE}\n\n| X | Y |\n|---|---|\n| 7 | 8 |`;
    const { tree } = openDialog(host, message(content));
    expectEqual("several", "table count", tablesIn(tree).length, 2);
    expectEqual("several", "title", textOf(findAll(tree, "h2")), "Tables (2)");
    expectEqual("several", "captions", findAll(tree, "h3").map(textOf), ["Table 1 of 2", "Table 2 of 2"]);
  },

  "cell text never becomes HTML or a link"(host) {
    const payload = '<img src=x onerror="globalThis.pwned=1">';
    const content = ["| Raw | Link | Script |", "|---|---|---|", `| ${payload} | [click](javascript:alert(1)) | <script>alert(1)</script> |`].join("\n");
    const { tree } = openDialog(host, message(content));
    walk(tree, (element) => {
      if (typeof element.type !== "string") throw new SmokeFailure("trust", "unexpanded component in tree", element.type);
      if ("dangerouslySetInnerHTML" in element.props) throw new SmokeFailure("trust", "raw HTML prop found", element.type);
      if (["a", "img", "script", "iframe"].includes(element.type)) throw new SmokeFailure("trust", "element from cell text", element.type);
      if (Object.keys(element.props).some((key) => /^on(?!Click$|Close$)/.test(key))) throw new SmokeFailure("trust", "unexpected event handler", Object.keys(element.props));
    });
    expectEqual("trust", "cells", tablesIn(tree)[0].rows, [[payload, "click", "<script>alert(1)</script>"]]);
  },

  "inline Markdown and line breaks in cells"(host) {
    const content = ["| Cell |", "|---|", "| **bold** and *em* and ~~old~~ |", "| `co*de*` |", "| one<br>two<BR/>three |", "| <https://example.com> \\* |"].join("\n");
    const { tree } = openDialog(host, message(content));
    expectEqual("inline", "texts", tablesIn(tree)[0].rows, [["bold and em and old"], ["co*de*"], ["one\ntwo\nthree"], ["https://example.com *"]]);
    expectEqual("inline", "elements", ["strong", "em", "del", "code", "br"].map((type) => findAll(tree, type).length), [1, 1, 1, 1, 2]);
  },

  "code spans follow the GFM rules"(host) {
    const content = ["| Cell |", "|---|", "| ``foo` |", "| `  a  ` |", "| **a `**` b** |", "| ``a`b`` |"].join("\n");
    const { tree } = openDialog(host, message(content));
    const codes = (row) => findAll(findAll(tree, "tbody")[0].children[row], "code").map(textOf);
    // Runs of different length do not pair; one space is trimmed per side;
    // a code span wins over strong; a longer run may hold a shorter one.
    expectEqual("code", "spans", [0, 1, 2, 3].map(codes), [[], [" a "], ["**"], ["a`b"]]);
    expectEqual("code", "texts", tablesIn(tree)[0].rows, [["``foo`"], [" a "], ["**a ** b**"], ["a`b"]]);
  },

  "long hostile text stays fast"(host) {
    const [action] = host.actions;
    const runs = (char) => char.repeat(HOSTILE_LENGTH);
    const wide = `${"|a".repeat(HOSTILE_LENGTH / 8)}|\n${"|-".repeat(HOSTILE_LENGTH / 8)}|\n${"a\n".repeat(HOSTILE_LENGTH / 4)}`;
    const cell = (text) => `| a |\n| - |\n| ${text} |`;
    const cases = {
      pipes: [runs("|"), false],
      dashes: [runs("-"), false],
      "wide header with many rows": [wide, true],
      backticks: [cell(runs("`")), true],
      "rising backtick runs": [cell(Array.from({ length: 360 }, (_, length) => `${"`".repeat(length + 1)}a`).join("")), true],
      autolinks: [cell("<http:".repeat(HOSTILE_LENGTH / 6)), true],
      brackets: [cell(runs("[")), true],
    };
    for (const [label, [content, expected]] of Object.entries(cases)) {
      const started = performance.now();
      const msg = message(content);
      expectEqual("hostile", `${label} matches`, action.matches(msg, SESSION), expected);
      const tree = expected ? host.React.render(host.React.createElement(action.component, { message: msg, session: SESSION, close: () => undefined })) : null;
      const elapsed = Math.round(performance.now() - started);
      if (elapsed > HOSTILE_BUDGET_MS) throw new SmokeFailure("hostile", `${label} took ${elapsed} ms (budget ${HOSTILE_BUDGET_MS} ms)`);
      // The wide table is drawn up to the cell cap, with a notice for the rest.
      if (label === "wide header with many rows") {
        const width = HOSTILE_LENGTH / 8;
        expectEqual("hostile", "drawn cells", findAll(tree, "td").length, Math.floor(MAX_DRAWN_CELLS / width) * width);
        expectEqual("hostile", "notice", /^Showing the first 6 of 16384 rows\./.test(textOf(findAll(tree, "p"))), true);
      }
    }
  },

  "each table frame is a named, focusable region"(host) {
    const { tree } = openDialog(host, message(`${SIMPLE}\n\n| X |\n|---|\n| 1 |`));
    const frames = findAll(tree, "div").filter((div) => div.props.tabIndex === 0);
    expectEqual("region", "frames", frames.map((frame) => [frame.props.role, typeof frame.props["aria-labelledby"]]), [["region", "string"], ["region", "string"]]);
    const captionIds = findAll(tree, "h3").map((caption) => caption.props.id);
    expectEqual("region", "labels", frames.map((frame) => frame.props["aria-labelledby"]), captionIds);
  },

  "Close and Escape both close the dialog"(host) {
    const { tree, closed } = openDialog(host, message(SIMPLE));
    const [button] = findAll(tree, "button");
    expectEqual("close", "button text", textOf(button), "Close");
    button.props.onClick();
    // The dialog's close event fires for Escape and for dialog.close().
    tree.props.onClose();
    expectEqual("close", "close calls", closed.length, 2);
  },

  "message without tables shows a notice"(host) {
    const { tree } = openDialog(host, message("table was edited away"));
    expectEqual("empty", "tables", tablesIn(tree).length, 0);
    expectEqual("empty", "notice", textOf(findAll(tree, "p")), "This message has no table now.");
  },
};

async function main() {
  const pluginPath = process.argv[2] ?? DEFAULT_PLUGIN;
  let failed = 0;
  for (const [name, run] of Object.entries(scenarios)) {
    try {
      run(await loadPlugin(pluginPath));
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n     ${error.stack ?? error}`);
    }
  }
  const total = Object.keys(scenarios).length;
  console.log(`${total - failed}/${total} scenarios passed`);
  process.exit(failed ? 1 : 0);
}

await main();
