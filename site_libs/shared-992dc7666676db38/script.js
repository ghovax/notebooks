
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";
import elk from "https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.3/dist/mermaid-layout-elk.esm.min.mjs";
import "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/chunks/mermaid.esm.min/flowDiagram-YHGXBVSY.mjs";
import "https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.3/dist/chunks/mermaid-layout-elk.esm.min/render-T4E67GNI.mjs";
restoreRequireDefine();
// Typesets and draws a workflow diagram, after the Mermaid and ELK imports that researchsite.pages places
// before it in the page's module script; `mermaid` and `elk` are those imports.
mermaid.registerLayoutLoaders(elk);
// A workflow's labels are typeset LaTeX, whose markup runs to thousands of characters a node, so a workflow of a few
// dozen runs passes Mermaid's default limit of 50 000 characters; the source is the site's own, so the limit only
// guards against runaway input.
mermaid.initialize({ startOnLoad: false, securityLevel: "loose", maxTextSize: 2000000, maxEdges: 5000 });
const container = document.querySelector(".calculations-diagram");
// A calculation page carries no copy of its workflow's overview rows and status boxes: they are read, while the diagram
// draws, from the workflow page's copy, with their links made relative to this page, and kept hidden as on that page.
const details = container.dataset.details && fetch(container.dataset.details)
  .then(response => (response.ok ? response.text() : ""))
  .then(async text => {
    const base = container.dataset.details.replace(/[^/]*$/, "");
    const local = value => (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(value) ? value : base + value);
    const holder = document.createElement("div");
    holder.className = "diagram-details";
    holder.append(...new DOMParser().parseFromString(text, "text/html").body.childNodes);
    for (const element of holder.querySelectorAll("[href], [src]")) {
      for (const attribute of ["href", "src"]) {
        if (element.hasAttribute(attribute)) element.setAttribute(attribute, local(element.getAttribute(attribute)));
      }
    }
    for (const element of holder.querySelectorAll("[data-calculation]")) element.dataset.calculation = local(element.dataset.calculation);
    // A large JSON block, such as a scan's data, is a shared script that puts the block back where it stands; scripts
    // in fetched HTML do not run, so its block is put back here.
    await Promise.all([...holder.querySelectorAll('script[src$="data.js"]')].map(async script => {
      const source = await (await fetch(script.src)).text();
      const block = source.match(/insertAdjacentHTML\('afterend', ([\s\S]*)\);\s*$/);
      if (block) script.replaceWith(document.createRange().createContextualFragment(JSON.parse(block[1])));
    }));
    container.after(holder);
  })
  .catch(error => console.error("Workflow details could not be read:", error));
while (!globalThis.katex) await new Promise(resolve => setTimeout(resolve, 50));
// Typeset each formula here; Mermaid labels are double-quoted, so the HTML uses single quotes.
const source = container.querySelector("pre").textContent.replace(/\$\$(.+?)\$\$/g,
    (_, tex) => katex.renderToString(tex, { throwOnError: true, output: "html" })
      .replace(/<annotation[^>]*>.*?<\/annotation>/g, "").replaceAll('"', "'"));
const { svg, bindFunctions } = await mermaid.render("calculations-diagram", source);
container.innerHTML = svg;
bindFunctions?.(container);
const drawing = container.querySelector("svg");
// Mermaid shares one arrowhead marker between edges and ignores linkStyle for it; give each
// coloured edge an arrowhead of its own colour.
for (const path of drawing.querySelectorAll("path[marker-end]")) {
  const colour = path.style.stroke, id = path.getAttribute("marker-end").match(/#([^)"']+)/)?.[1];
  const marker = id && drawing.querySelector(`marker[id="${id}"]`);
  if (!colour || !marker) continue;
  const key = `${id}-${colour.replace(/[^a-z0-9]/gi, "")}`;
  if (!drawing.querySelector(`marker[id="${key}"]`)) {
    const copy = marker.cloneNode(true);
    copy.id = key;
    for (const shape of copy.querySelectorAll("path, circle")) Object.assign(shape.style, { fill: colour, stroke: colour });
    marker.after(copy);
  }
  path.setAttribute("marker-end", `url(#${key})`);
}
// Mermaid paints group titles before the arrows, which then cross them; repaint the titles above the arrows and
// nodes, on the group's own background.
// Each title keeps the group's box, so it can fade with the group's nodes.
const titles = document.createElementNS("http://www.w3.org/2000/svg", "g");
titles.setAttribute("class", "cluster-labels");
const groups = [...drawing.querySelectorAll("g.cluster")].map(cluster => ({
  box: cluster.querySelector("rect").getBBox(), label: cluster.querySelector("g.cluster-label") }));
titles.append(...groups.map(group => group.label).filter(Boolean));
drawing.querySelector("g.nodes")?.after(titles);
// On a calculation page the diagram keeps the workflow page's scale in a smaller framed view, centred on that
// calculation; the workflow page opens on the start circle when the diagram is wider than the page.
const current = container.dataset.current;
const focus = drawing.querySelector(current ? `g.node[id*="flowchart-${current}-"]` : 'g.node[id*="-Start"]');
const centerFocus = () => {
  if (!focus) return;
  const box = focus.getBoundingClientRect(), frame = container.getBoundingClientRect();
  container.scrollLeft += box.left + box.width / 2 - frame.left - container.clientWidth / 2;
  if (current) container.scrollTop += box.top + box.height / 2 - frame.top - container.clientHeight / 2;
};
if (current && focus) {
  // The glow takes the node's own border colour.
  const shape = focus.querySelector("rect, polygon, path"), stroke = shape && getComputedStyle(shape).stroke;
  if (stroke && stroke !== "none") focus.style.color = stroke;
  focus.classList.add("current-calculation");
  container.addEventListener("contextmenu", event => {
    event.preventDefault();
    centerFocus();
  });
}
centerFocus();
// Clicking a node traces every path through it, back to the inputs and on to the outputs; clicking an arrow traces
// only the paths through that arrow. Clicking it again, elsewhere or pressing Escape clears the trace; a label's
// link still opens its page. The arrows come from the README source, in order, as [from, to] node names.
const nodes = new Map(), links = [], counts = {};
for (const node of drawing.querySelectorAll("g.node")) {
  const name = node.id.match(/flowchart-(.+)-\d+$/)?.[1];
  if (name) { nodes.set(name, node); node.dataset.name = name; }
}
for (const [from, to] of JSON.parse(container.dataset.edges)) {
  const key = `L_${from}_${to}_`;
  counts[key] = (counts[key] ?? -1) + 1;
  const path = drawing.querySelector(`path[data-id="${key}${counts[key]}"]`);
  if (!path || path.style.opacity === "0") continue;
  // A wide transparent copy of each arrow catches clicks near its thin line.
  const hit = path.cloneNode(false);
  hit.removeAttribute("id"); hit.removeAttribute("marker-end"); hit.removeAttribute("style");
  hit.removeAttribute("data-id"); hit.setAttribute("class", "edge-hit");
  path.after(hit);
  const link = { from, to, path };
  hit.link = link;
  links.push(link);
}
// Every node and arrow reached from a node by repeatedly following arrows upwards or downwards.
const reach = (name, upwards, found) => {
  for (const link of links) {
    if ((upwards ? link.to : link.from) !== name || found.links.has(link)) continue;
    found.links.add(link);
    const next = upwards ? link.from : link.to;
    found.nodes.add(next);
    reach(next, upwards, found);
  }
  return found;
};
let selected = null;
// The selection is kept per workflow for this browser tab, so the workflow page and its calculation pages share it.
const key = `calculations-diagram:${container.dataset.workflow}`;
const remember = choice => {
  try {
    if (choice) sessionStorage.setItem(key, JSON.stringify(typeof choice === "string" ? { node: choice } : { link: links.indexOf(choice) }));
    else sessionStorage.removeItem(key);
  } catch {}
};
await details;
const rows = [...document.querySelectorAll(".calculations-table tbody tr")];
const trace = choice => {
  selected = choice;
  remember(choice);
  drawing.classList.toggle("traced", Boolean(choice));
  for (const element of drawing.querySelectorAll(".on-trace, .trace-origin")) element.classList.remove("on-trace", "trace-origin");
  for (const row of rows) row.classList.remove("off-trace");
  if (!choice) return;
  const [up, down] = typeof choice === "string" ? [choice, choice] : [choice.from, choice.to];
  const found = { nodes: new Set([up, down]), links: new Set(typeof choice === "string" ? [] : [choice]) };
  reach(up, true, found);
  reach(down, false, found);
  for (const name of found.nodes) nodes.get(name)?.classList.add("on-trace");
  // A group's title fades unless the trace passes through one of its nodes.
  for (const { box, label } of groups) {
    const inside = [...found.nodes].some(name => {
      const at = nodes.get(name)?.transform.baseVal.consolidate()?.matrix;
      return at && at.e >= box.x && at.e <= box.x + box.width && at.f >= box.y && at.f <= box.y + box.height;
    });
    label?.classList.toggle("on-trace", inside);
  }
  for (const link of found.links) link.path.classList.add("on-trace");
  (typeof choice === "string" ? nodes.get(choice) : choice.path).classList.add("trace-origin");
  // The overview tables grey out the calculations off the trace.
  const traced = new Set([...found.nodes].map(name => nodes.get(name)?.querySelector(".nodeLabel a")?.getAttribute("href")));
  // A scan's row names its node.
  for (const row of rows) {
    const scan = row.querySelector(".scan-title")?.dataset.node;
    row.classList.toggle("off-trace", scan ? !found.nodes.has(scan) : !traced.has(row.querySelector("a")?.getAttribute("href")));
  }
};
// A calculation page's diagram clears only from within itself, since the page's viewers and charts take clicks too.
document.addEventListener("click", event => {
  if (event.target.closest("a, .tippy-box") || (current && !event.target.closest(".calculations-diagram"))) return;
  const hit = event.target.closest(".calculations-diagram .edge-hit");
  const node = event.target.closest(".calculations-diagram g.node");
  const choice = hit ? hit.link : node ? node.dataset.name : null;
  trace(choice === selected ? null : choice);
});
document.addEventListener("keydown", event => { if (event.key === "Escape") trace(null); });
try {
  const saved = JSON.parse(sessionStorage.getItem(key));
  if (saved) trace(saved.node ?? links[saved.link] ?? null);
} catch {}
// Hovering a calculation's link, in the diagram or in the overview tables, shows the same Quarto hover popover: its
// status box with the workflow's assessment of it, its overview-table row and the findings behind its status. The
// copied formulas are typeset already, and the popover hook in math-header.html leaves typeset math alone.
// A scan's node and row have no status box; their popover holds its row and a matrix drawn from its hidden data.
// A calculation's detail is found by the address its link leads to, since pages link one calculation by different
// relative paths, such as a scan's page and its workflow's.
const address = href => new URL(href, document.baseURI).href;
const detailOf = anchor => {
  const target = address(anchor.getAttribute("href"));
  return [...document.querySelectorAll(".diagram-detail[data-calculation]")].find(detail => address(detail.dataset.calculation) === target);
};
const popover = (anchor, row, scan = null) => tippy(anchor, {
  // Nothing to show shows nothing, rather than an empty box.
  onShow: instance => (instance.popper.querySelector(".diagram-popover")?.childNodes.length ?? 0) > 0,
  content: () => {
    const box = document.createElement("div");
    box.className = "diagram-popover";
    const detail = scan ? null : detailOf(anchor);
    if (detail) box.append(...detail.cloneNode(true).childNodes);
    if (row) {
      const copy = document.createElement("table"), body = document.createElement("tbody");
      copy.className = "table table-sm popover-row";
      body.append(row.cloneNode(true));
      copy.append(row.closest("table").tHead.cloneNode(true), body);
      const callout = box.querySelector(".callout");
      if (callout) callout.after(copy);
      else box.prepend(copy);
    }
    const data = scan && document.querySelector(`.diagram-detail[data-scan="${scan}"] .scan-matrix`);
    if (data && globalThis.drawScan) {
      const matrix = data.cloneNode(true);
      box.append(matrix);
      globalThis.drawScan(matrix);
    }
    return box;
  },
  allowHTML: true, maxWidth: "none", delay: 100, arrow: false, interactive: true, interactiveBorder: 10,
  theme: "quarto", placement: "bottom-start", appendTo: () => document.body,
});
if (globalThis.tippy) {
  // A scan redraws its table as its selectors change, so its script attaches this to each new cell as well.
  globalThis.calculationPopover = popover;
  for (const anchor of drawing.querySelectorAll(".nodeLabel a")) {
    const row = document.querySelector(`.calculations-table a[href="${anchor.getAttribute("href")}"]`)?.closest("tr");
    // A scan's node shows its row and matrix from the loop over nodes below.
    if (row && !row.querySelector(".scan-title")) popover(anchor, row);
  }
  for (const anchor of document.querySelectorAll(".calculations-table a:not(.scan-title)")) {
    if (!anchor.closest(".diagram-details")) popover(anchor, anchor.closest("tr"));
  }
  // A scan's cell has no overview row; its popover holds the run's status box.
  for (const anchor of document.querySelectorAll(".scan-matrix a")) {
    if (!anchor.closest(".diagram-details")) popover(anchor, null);
  }
  // A scan's node and its row show its row and matrix.
  for (const [name, node] of nodes) {
    const row = document.querySelector(`.calculations-table .scan-title[data-node="${name}"]`)?.closest("tr");
    if (row) popover(node, row, name);
  }
  for (const title of document.querySelectorAll(".calculations-table .scan-title")) {
    if (!title.closest(".diagram-details")) popover(title, title.closest("tr"), title.dataset.node);
  }
}
