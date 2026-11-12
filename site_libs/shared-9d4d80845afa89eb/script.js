
(() => {
  // The page's words, its language and the worker's address, which viewer-text.<language>.html gives each language's
  // page; another language's viewer runs the default one's worker, told only the language to write in.
  const VIEWER = window.VIEWER || { text: {}, worker: "worker.js", language: "en" };
  const T = (key, values = {}) => (VIEWER.text[key] ?? key).replace(/%\((\w+)\)s/g, (all, name) => values[name] ?? all);
  const address = new URL(VIEWER.worker, document.baseURI);
  address.searchParams.set("language", VIEWER.language);
  const worker = new Worker(address, { type: "module" });
  // Dropped files by their path relative to the drop, folders included.
  const files = new Map();
  const roles = {};
  const main = document.querySelector("main#quarto-document-content") || document.querySelector("main");
  // The notebooks as a Quarto tabset, one tab per calculation, named after its file.
  const container = document.createElement("div");
  container.id = "viewer-calculations";
  container.className = "panel-tabset";
  container.hidden = true;
  container.innerHTML = '<ul class="nav nav-tabs" role="tablist"></ul><div class="tab-content"></div>';
  const tabs = container.firstElementChild, panes = container.lastElementChild;
  main.append(container);
  const done = document.getElementById("viewer-done");
  const failed = document.getElementById("viewer-failed");
  const warning = document.getElementById("viewer-warning");
  // What each calculation could not show, by its key, its main file: parts left out for a missing file, or why it
  // could not be read.
  const issues = {};
  // Each file's status: Bootstrap's spinner while it waits to be read, at the status icons' size and place, then the
  // site's status icon: a cross when it could not be read or its notebook leaves parts out for missing files,
  // listed below its files, and a tick when all is shown.
  const status = (path) => {
    if (!(path in roles)) return `<span class="spinner-border text-primary workflow-status" role="status" title="${T("viewer-reading")}"><span class="visually-hidden">${T("viewer-reading")}</span></span>`;
    const issue = issues[path] || {};
    const [image, word] = path in unread || issue.error ? [failed, T("viewer-not-read")]
      : issue.missing?.length ? [failed, T("viewer-not-all-shown")] : [done, T("viewer-read")];
    return `<img src="${image.src}" class="workflow-status" alt="${escape(word)}" title="${escape(word)}">`;
  };
  const unread = {};
  const notes = document.getElementById("viewer-unread");
  const list = document.getElementById("viewer-file-list");
  const clear = document.getElementById("viewer-clear");
  // The share store, a Cloudflare Worker (quarto/viewer/share), and the button that stores the page's files in it.
  const SHARES = "https://viewer-share.ghovax.workers.dev/";
  const shareButton = document.getElementById("viewer-share");
  const shareLabel = shareButton.querySelector("span");
  const anchors = window.AnchorJS ? Object.assign(new window.AnchorJS(), { options: { placement: "right", icon: "" } }) : null;

  const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // Font Awesome Free 6.6.0's solid trash can (https://fontawesome.com/license/free), one line of text high and on
  // the text's baseline as Bootstrap Icons sit, in the danger colour of the plain button around it, which takes the
  // row's font size and line height.
  const TRASH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" width="0.875em" height="1em" fill="currentColor" style="vertical-align: -0.125em;" aria-hidden="true"><path d="M135.2 17.7L128 32 32 32C14.3 32 0 46.3 0 64S14.3 96 32 96l384 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-96 0-7.2-14.3C307.4 6.8 296.3 0 284.2 0L163.8 0c-12.1 0-23.2 6.8-28.6 17.7zM416 128L32 128 53.2 467c1.6 25.3 22.6 45 47.9 45l245.8 0c25.3 0 46.3-19.7 47.9-45L416 128z"/></svg>';
  // Text with file names and commands in backticks, as code.
  const code = (text) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  const size = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1048576).toFixed(1)} MB`;

  // Beside the buttons, a cross only while Python has failed; each file's own state is shown in the files table.
  let broken = false;
  const showBroken = () => { failed.hidden = !broken; };

  // Problems, as on the calculation pages: each file not read is a warning with its reason, and a failure of the
  // Python worker an error. One callout above the files lists them, titled and coloured by the most serious kind.
  let failure = "", shareFailure = "";
  function showProblems() {
    // Errors of the page as a whole, such as a link that could not be loaded, are plain text; files not read are
    // listed in a table, each with its reason.
    const errors = [failure, shareFailure].filter(Boolean);
    const rows = Object.entries(unread).sort().map(([path, reason]) => [warning, T("viewer-kind-warning"), `<code>${escape(path)}</code>`, code(reason)]);
    if (!rows.length && !errors.length) { notes.innerHTML = ""; return; }
    const kind = errors.length ? "error" : "warning";
    // Each title's singular and plural, separated by a bar in the catalogs.
    const title = (kind === "error" ? T("viewer-errors") : T("viewer-warnings"))
      .split("|")[(errors.length || rows.length) > 1 ? 1 : 0];
    notes.innerHTML = `<div class="callout callout-style-default callout-${kind === "error" ? "important" : "warning"} callout-titled">
<div class="callout-header d-flex align-content-center"><div class="callout-icon-container"><i class="callout-icon"></i></div>
<div class="callout-title-container flex-fill">${title}</div></div>
<div class="callout-body-container callout-body">${errors.map((error) => `<p>${escape(error)}</p>`).join("")}${rows.length ? `<table class="caption-top table">
<thead><tr class="header"><th style="text-align: left;">${T("viewer-column-kind")}</th><th style="text-align: left;">${T("viewer-column-file")}</th><th style="text-align: left;">${T("viewer-column-message")}</th></tr></thead>
<tbody>${rows.map(([image, word, file, message], index) => `<tr class="${index % 2 ? "even" : "odd"}"><td style="text-align: left;"><img src="${image.src}" class="workflow-status" alt="${word}" title="${word}"></td><td style="text-align: left;">${file}</td><td style="text-align: left;">${message}</td></tr>`).join("")}</tbody></table>` : ""}</div></div>`;
  }
  const fail = (text) => { failure = text; showProblems(); };

  // When each file was added, and the order the page shows files and their notebooks in: the latest added first,
  // as the page is read from the top, and the files added together by name. A notebook is as recent as the latest
  // of its files, its own and those read with it.
  const uploaded = new Map();
  const newestFirst = (time) => (a, b) => time(b) - time(a) || (a < b ? -1 : a > b ? 1 : 0);
  const added = (key) => Math.max(uploaded.get(key) || 0, ...Object.entries(roles)
    .filter(([, role]) => role.endsWith(` of \`${key}\``)).map(([path]) => uploaded.get(path) || 0));
  // An instant as the calculation pages write one, in the visitor's own time zone with its abbreviation, in the page
  // language's pattern and month names, such as 5 Sept 2026, 14:03:27 CEST in English.
  const MONTHS = T("viewer-months").split(" ");
  const LOCAL = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" });
  // The zone's abbreviation as the time-zone database writes it, as the notebooks' times show it: the browser's short
  // name, or the initials of its long name where the short one is only an offset, as JST for Japan Standard Time.
  const LONG = new Intl.DateTimeFormat("en-US", { timeZoneName: "long" });
  const zone = (date, short) => {
    if (!/^GMT[+-]/.test(short)) return short;
    const name = LONG.formatToParts(date).find(({ type }) => type === "timeZoneName").value;
    return /^[A-Z][a-z]+( [A-Z][a-z]+)+ Time$/.test(name) ? name.split(" ").map((word) => word[0]).join("") : short;
  };
  const clock = (time) => {
    const date = new Date(time);
    const part = Object.fromEntries(LOCAL.formatToParts(date).map(({ type, value }) => [type, value]));
    return T("viewer-clock", { day: Number(part.day), month: MONTHS[part.month - 1], year: part.year,
      time: `${part.hour}:${part.minute}:${part.second}`, zone: zone(date, part.timeZoneName) });
  };

  // The dropped files as a Markdown table renders on these pages, each with what it is read as.
  // The calculation a file belongs to, as Python grouped it: the log or input it is read with, or itself.
  const owner = (path) => {
    const match = (roles[path] || "").match(/ of `(.+)`$/);
    return match && files.has(match[1]) ? match[1] : path;
  };

  // The dropped files, one table per calculation, as its notebook below: the log or input first, then the files read
  // with it, the latest added calculation first. Files Python has not read yet wait together in one table above,
  // and move to their calculations' tables once it has.
  function showFiles() {
    clear.disabled = shareButton.disabled = !files.size;
    const waiting = [...files.keys()].filter((path) => !(path in roles)).sort();
    const groups = new Map();
    for (const path of files.keys()) {
      if (path in roles) groups.set(owner(path), [...(groups.get(owner(path)) || []), path]);
    }
    const latest = (key) => Math.max(...groups.get(key).map((path) => uploaded.get(path)));
    // A calculation's table heads its tab; files of no calculation, those not read, stay above the tabs.
    let above = waiting.length ? table(waiting) : "";
    for (const key of [...groups.keys()].sort(newestFirst(latest))) {
      const markup = table([key, ...groups.get(key).filter((path) => path !== key).sort()]) + issueBox(issues[key]);
      const slot = [...panes.children].find((pane) => pane.dataset.key === key)?.querySelector(":scope > .viewer-files");
      if (slot) slot.innerHTML = markup; else above += markup;
    }
    list.innerHTML = above;
  }

  // What a calculation's notebook could not show, under its files: why it could not be read, or each part left out
  // with the file it needs.
  function issueBox(issue) {
    if (!issue?.error && !issue?.missing?.length) return "";
    const body = issue.error ? `<p>${escape(issue.error)}</p>` : `<table class="caption-top table">
<thead><tr class="header"><th style="text-align: left;">${T("viewer-column-not-shown")}</th><th style="text-align: left;">${T("viewer-column-needs")}</th></tr></thead>
<tbody>${issue.missing.map(({ part, needs }, index) => `<tr class="${index % 2 ? "even" : "odd"}"><td style="text-align: left;">${escape(part)}</td><td style="text-align: left;">${code(needs)}</td></tr>`).join("")}</tbody></table>`;
    return `<div class="callout callout-style-default callout-important callout-titled">
<div class="callout-header d-flex align-content-center"><div class="callout-icon-container"><i class="callout-icon"></i></div>
<div class="callout-title-container flex-fill">${issue.error ? T("viewer-not-read") : T("viewer-not-all-shown")}</div></div>
<div class="callout-body-container callout-body">${body}</div></div>`;
  }

  function table(paths) {
    const rows = paths.map((path, index) => `<tr class="${index % 2 ? "even" : "odd"}">
<td style="text-align: left;">${status(path)}</td>
<td style="text-align: left;"><code>${escape(path)}</code></td>
<td style="text-align: right;">${size(files.get(path).size)}</td>
<td style="text-align: right;">${clock(uploaded.get(path))}</td>
<td style="text-align: left;">${code(roles[path] || "")}</td>
<td style="text-align: right;"><button type="button" class="border-0 bg-transparent p-0 text-danger align-baseline" data-remove="${escape(path)}" title="${escape(T("viewer-remove", { path }))}">${TRASH}</button></td>
</tr>`).join("");
    return `<table class="caption-top table">
<thead><tr class="header"><th style="text-align: left;">${T("viewer-column-status")}</th><th style="text-align: left;">${T("viewer-column-file")}</th><th style="text-align: right;">${T("viewer-column-size")}</th><th style="text-align: right;">${T("viewer-column-uploaded")}</th><th style="text-align: left;">${T("viewer-column-description")}</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>`;
  }

  // The page's state as a link: the address carries ?share=<id> while the files are those the share with that id
  // holds, and any other change of the files drops it; the part after # is only ever a section.
  const unlink = () => {
    if (new URLSearchParams(location.search).has("share")) history.replaceState(null, "", location.pathname + location.hash);
    showShare();
  };
  // The share button: Share while the files have no link, then, until they change, Copy link, filled green with a
  // clipboard icon, copying the page's link again.
  const shareIcon = shareButton.querySelector("i");
  function showShare(label = null) {
    const linked = new URLSearchParams(location.search).has("share");
    shareButton.classList.toggle("btn-primary", !linked);
    shareButton.classList.toggle("btn-success", linked);
    shareIcon.className = linked ? "bi bi-clipboard" : "bi bi-link-45deg";
    shareLabel.textContent = label || (linked ? T("viewer-copy-link") : T("viewer-share"));
  }
  async function copyLink() {
    let copied = true;
    try { await navigator.clipboard.writeText(location.href); } catch { copied = false; }
    showShare(copied ? T("viewer-link-copied") : T("viewer-address-link"));
    setTimeout(() => showShare(), 2000);
  }

  // Every change of the files runs after the one before has been sent to Python, whatever order picks, drops,
  // removals and shared links arrive in, and a file counts as added only once its content has been read; so the
  // list Python reads always matches the files it holds, and files that belong together, such as a log and its
  // checkpoint, are grouped the same whichever comes first.
  let changes = Promise.resolve();
  // Files a shared link lists whose contents Python has not unpacked yet: shown waiting, but not yet Python's.
  const listed = new Set();
  const present = () => [...files.keys()].filter((path) => !listed.has(path));
  const change = (task) => (changes = changes.then(task).catch((error) => fail(T("viewer-files-failed", { error: error.message }))));

  // Files added, each at the time given for it, as a shared link records, or now.
  function add(entries, times = null) {
    if (!entries.length) return changes;
    return change(async () => {
      const buffers = await Promise.all(entries.map(async ([path, file]) => ({ path, buffer: await file.arrayBuffer() })));
      if (!times) unlink();
      const now = Date.now();
      for (const [path, file] of entries) {
        listed.delete(path);
        files.set(path, file);
        uploaded.set(path, times?.[path] ?? now);
      }
      showFiles();
      worker.postMessage({ type: "add", files: buffers, paths_now: present() }, buffers.map((file) => file.buffer));
    });
  }

  function remove(paths) {
    return change(() => {
      for (const path of paths) { files.delete(path); uploaded.delete(path); listed.delete(path); }
      unlink();
      showFiles();
      worker.postMessage({ type: "remove", paths, paths_now: present() });
    });
  }

  // Every file of a dropped item, walking into dropped folders.
  async function walk(entry, prefix = "") {
    if (entry.isFile) return [[prefix + entry.name, await new Promise((resolve, reject) => entry.file(resolve, reject))]];
    const reader = entry.createReader(), found = [];
    for (let batch; (batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))).length;) {
      for (const child of batch) found.push(...await walk(child, `${prefix}${entry.name}/`));
    }
    return found;
  }

  // The whole page takes drops.
  document.addEventListener("dragover", (event) => {
    if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", async (event) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry()).filter(Boolean);
    const found = [];
    for (const entry of entries) found.push(...await walk(entry));
    add(found);
  });
  const filesInput = document.getElementById("viewer-files");
  const folderInput = document.getElementById("viewer-folder");
  document.getElementById("viewer-choose").addEventListener("click", () => filesInput.click());
  document.getElementById("viewer-choose-folder").addEventListener("click", () => folderInput.click());
  for (const input of [filesInput, folderInput]) {
    input.addEventListener("change", () => {
      add([...input.files].map((file) => [file.webkitRelativePath || file.name, file]));
      input.value = "";
    });
  }
  clear.addEventListener("click", () => remove([...files.keys()]));
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (button) remove([button.dataset.remove]);
  });

  // The table-of-contents entry of the last section scrolled past is active, as Quarto marks it; Quarto's own
  // tracking knows only the entries the page had when it loaded, and this page had none.
  function markActive() {
    const links = [...document.querySelectorAll("#TOC a.nav-link")];
    let active = null;
    for (const link of links) {
      const section = locate(decodeURIComponent(link.getAttribute("href").slice(1)));
      if (section && !section.closest(".tab-pane:not(.active)") && section.getBoundingClientRect().top - 200 <= 0) active = link;
    }
    const current = active || links[0];
    for (const link of links) {
      link.classList.toggle("active", link === current);
      if (link === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }
  let scrolling = false;
  window.addEventListener("scroll", () => {
    if (scrolling) return;
    scrolling = true;
    requestAnimationFrame(() => { scrolling = false; markActive(); });
  }, { passive: true });

  // Quarto's table of contents for the page as it now stands, made in the margin when the page had none.
  function rebuildToc() {
    let nav = document.getElementById("TOC");
    if (!nav) {
      const margin = document.getElementById("quarto-margin-sidebar");
      if (!margin) return;
      nav = document.createElement("nav");
      nav.id = "TOC";
      nav.setAttribute("role", "doc-toc");
      nav.className = "toc-active";
      nav.innerHTML = `<h2 id="toc-title">${T("viewer-contents")}</h2>`;
      margin.append(nav);
    }
    const root = document.createElement("ul");
    const stack = [{ level: 1, list: root }];
    // Tab titles replace their headings, but remain navigable alongside all of their subsections.
    for (const entry of main.querySelectorAll("h2.anchored, h3.anchored, h4.anchored, h5.anchored, h6.anchored, section.step")) {
      const calculation = entry.closest(".viewer-calculation");
      if (calculation && !calculation.classList.contains("active")) continue;
      const step = entry.matches("section.step");
      const pane = step && entry.parentElement.matches(".viewer-steps > .tab-content > .tab-pane") ? entry.parentElement : null;
      if (step && !pane) continue;
      const tab = pane && pane.closest(".viewer-steps").querySelector(`:scope > .nav [data-bs-target="#${CSS.escape(pane.id)}"]`);
      const text = (tab || (!step && entry))?.cloneNode(true);
      if (!text) continue;
      const level = step ? Number([...entry.classList].find((name) => /^level[1-6]$/.test(name))?.slice(5)) : Number(entry.tagName[1]);
      const id = step ? entry.id : entry.closest("section")?.id || entry.id;
      if (!id || !level) continue;
      while (stack.length > 1 && stack.at(-1).level >= level) stack.pop();
      const item = document.createElement("li");
      text.querySelectorAll(".anchorjs-link").forEach((link) => link.remove());
      item.innerHTML = `<a href="#${id}" id="toc-${id}" class="nav-link" data-scroll-target="#${id}" title="${escape(text.textContent.trim())}">${text.innerHTML}</a>`;
      stack.at(-1).list.append(item);
      const nested = document.createElement("ul");
      item.append(nested);
      stack.push({ level, list: nested });
    }
    root.querySelectorAll("ul").forEach((nested) => { if (!nested.children.length) nested.remove(); });
    nav.querySelector(":scope > ul")?.remove();
    nav.append(root);
    nav.hidden = !root.children.length;
    // Quarto puts a margin without a table of contents, as this page had when rendered, beneath the page, where
    // its links would take no clicks; with one, it is in front, as on the other pages.
    nav.parentElement.classList.toggle("zindex-bottom", nav.hidden);
    markActive();
  }

  // KaTeX on every math span, with the options of Quarto's own render; the page defines Quarto.typesetMath only
  // when it had math when rendered.
  function typeset(node) {
    if (window.Quarto?.typesetMath) return window.Quarto.typesetMath(node);
    for (const math of node.querySelectorAll("span.math")) {
      if (!math.firstChild || math.firstChild.nodeType !== Node.TEXT_NODE) continue;
      window.katex?.render(math.firstChild.data, math, {
        displayMode: math.classList.contains("display"), throwOnError: false, macros: [], fleqn: false,
      });
    }
  }

  // Finish a new section as Quarto finishes a page: math, anchors, folds, then the widgets in it.
  function finish(node) {
    window.stepTabs?.(node);
    typeset(node);
    anchors?.add(`#${node.id} .anchored`);
    window.wrapFolds?.(node);
    window.require?.(["@jupyter-widgets/html-manager/dist/libembed-amd"], (embed) => embed.renderWidgets(node));
  }

  // Each calculation's notebook in its tab, its files' table first; the latest added calculation's tab comes first
  // and opens when it is new, otherwise the open tab stays open.
  function show(calculations) {
    const kept = new Map([...panes.children].map((node) => [node.dataset.key, node]));
    const wanted = new Set(calculations.map((calculation) => calculation.key));
    for (const [key, node] of kept) if (!wanted.has(key)) node.remove();
    const open = panes.querySelector(":scope > .tab-pane.active")?.dataset.key;
    calculations = [...calculations].sort((a, b) => newestFirst(added)(a.key, b.key));
    const arrived = calculations.find((calculation) => !kept.has(calculation.key))?.key;
    let before = null;
    for (const [index, calculation] of calculations.entries()) {
      let node = kept.get(calculation.key);
      const fresh = !node || node.dataset.signature !== calculation.signature;
      if (fresh) {
        node?.remove();
        node = document.createElement("div");
        node.id = `viewer-calculation-${index}-${calculation.signature.slice(0, 8)}`;
        node.className = "viewer-calculation tab-pane";
        node.setAttribute("role", "tabpanel");
        node.dataset.key = calculation.key;
        node.dataset.signature = calculation.signature;
        node.innerHTML = '<div class="viewer-files"></div>' + calculation.html;
      }
      panes.insertBefore(node, before ? before.nextSibling : panes.firstChild);
      before = node;
      if (fresh) finish(node);
    }
    const active = arrived || (wanted.has(open) ? open : calculations[0]?.key);
    tabs.innerHTML = [...panes.children].map((pane) => `<li class="nav-item" role="presentation"><a class="nav-link${pane.dataset.key === active ? " active" : ""}" data-bs-toggle="tab" data-bs-target="#${pane.id}" role="tab" aria-controls="${pane.id}" aria-selected="${pane.dataset.key === active}" href=""><code>${escape(pane.dataset.key.split("/").pop())}</code></a></li>`).join("");
    for (const pane of panes.children) pane.classList.toggle("active", pane.dataset.key === active);
    container.hidden = !calculations.length;
    rebuildToc();
    reveal();
    window.dispatchEvent(new Event("resize"));
  }

  // Going to a section opens its calculation and nested tabs, then any fold around it.
  function locate(id, from = null) {
    const selector = `[id="${CSS.escape(id)}"]`;
    const pane = from?.closest(".viewer-calculation") || panes.querySelector(":scope > .tab-pane.active");
    return pane?.querySelector(selector) || document.querySelector(selector);
  }
  function go(target) {
    const holders = [];
    for (let pane = target.closest(".tab-pane"); pane; pane = pane.parentElement.closest(".tab-pane")) holders.unshift(pane);
    for (const pane of holders) {
      const link = document.querySelector(`[data-bs-target="#${CSS.escape(pane.id)}"]`);
      if (link && !pane.classList.contains("active")) window.bootstrap?.Tab.getOrCreateInstance(link).show();
    }
    for (let fold = target.closest("details.fold"); fold; fold = fold.parentElement.closest("details.fold")) fold.open = true;
    requestAnimationFrame(() => {
      target.scrollIntoView();
      markActive();
    });
  }
  // A section in the address is gone to once it is on the page.
  let revealed = "";
  function reveal() {
    const target = location.hash.length > 1 && locate(decodeURIComponent(location.hash.slice(1)));
    if (!target || revealed === location.hash) return;
    revealed = location.hash;
    go(target);
  }
  window.addEventListener("hashchange", () => { revealed = ""; reveal(); });
  // Links to sections, in the table of contents and in the notebooks, go to the section of their own calculation.
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]:not([data-bs-toggle])');
    if (!link || !(link.closest("#TOC") || container.contains(link)) || link.getAttribute("href").length < 2) return;
    const id = decodeURIComponent(link.getAttribute("href").slice(1));
    const target = locate(id, container.contains(link) ? link : null);
    if (!target) return;
    event.preventDefault();
    history.pushState(null, "", `${location.pathname}${location.search}#${encodeURIComponent(id)}`);
    revealed = location.hash;
    go(target);
  });
  // A tab shown: the table of contents follows it, and its charts and molecule viewers take their width.
  document.addEventListener("shown.bs.tab", () => { rebuildToc(); window.dispatchEvent(new Event("resize")); });

  // Sharing: Python packs the files with the times they were added, the share store keeps them under a short id, and
  // the address then ends in it, copied for pasting.
  const shareFailed = (text) => { shareFailure = text; showProblems(); showShare(); shareButton.disabled = !files.size; };
  shareButton.addEventListener("click", () => {
    if (new URLSearchParams(location.search).has("share")) { copyLink(); return; }
    shareButton.disabled = true;
    shareLabel.textContent = T("viewer-sharing");
    shareFailure = "";
    showProblems();
    change(() => worker.postMessage({ type: "pack", entries: present().map((path) => [path, uploaded.get(path)]) }));
  });
  async function store(data) {
    try {
      const response = await fetch(SHARES, { method: "POST", body: data, headers: { "Content-Type": "application/octet-stream" } });
      if (!response.ok) throw new Error(T("viewer-share-store-status", { status: response.status }));
      history.replaceState(null, "", `${location.pathname}?share=${await response.text()}${location.hash}`);
      shareButton.disabled = !files.size;
      await copyLink();
    } catch (error) {
      shareFailed(T("viewer-share-failed", { error: error.message }));
    }
  }
  // A shared link's files, fetched and unpacked, then added with the times they were first added.
  showShare();
  const linked = (new URLSearchParams(location.search).get("share") || "").match(/^([0-9A-Za-z_-]{8,43})$/);
  if (linked) {
    fetch(SHARES + linked[1]).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? T("viewer-share-missing") : T("viewer-share-store-status", { status: response.status }));
      const data = await response.arrayBuffer();
      // The share's plain header lists its files, shown at once, waiting, while Python starts and unpacks them.
      let header = null;
      try {
        const length = new DataView(data).getUint32(0);
        header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length)));
      } catch { /* checked below */ }
      if (!Array.isArray(header)) throw new Error(T("viewer-share-unreadable"));
      change(() => {
        for (const [path, time, size] of header) {
          files.set(path, { size });
          uploaded.set(path, time);
          listed.add(path);
        }
        showFiles();
      });
      worker.postMessage({ type: "unpack", data }, [data]);
    }).catch((error) => { shareFailure = T("viewer-share-load-failed", { error: error.message }); showProblems(); });
  }

  worker.onmessage = (event) => {
    const data = event.data;
    if (data.type === "packed") store(data.data);
    else if (data.type === "unpacked") {
      // Only the files still listed: one removed while the link loaded stays removed.
      const kept = data.files.filter(({ path }) => listed.has(path));
      add(kept.map(({ path, content }) => [path, new File([content], path.split("/").pop())]),
          Object.fromEntries(kept.map(({ path, time }) => [path, time])));
    }
    else if (data.type === "error") { broken = true; fail(data.start ? T("viewer-python-unavailable", { error: data.text }) : data.text); showBroken(); if (shareLabel.textContent === T("viewer-sharing")) shareFailed(T("viewer-share-pack-failed")); }
    else if (data.type === "result") {
      broken = false;
      failure = "";
      for (const key of Object.keys(roles)) delete roles[key];
      Object.assign(roles, data.roles);
      for (const key of Object.keys(unread)) delete unread[key];
      Object.assign(unread, data.unread);
      for (const key of Object.keys(issues)) delete issues[key];
      for (const calculation of data.calculations) issues[calculation.key] = calculation.issues;
      showProblems();
      show(data.calculations);
      showFiles();
      showBroken();
    }
  };
  worker.onerror = (event) => { broken = true; fail(T("viewer-python-stopped", { error: event.message })); showBroken(); };
  showFiles();
})();
