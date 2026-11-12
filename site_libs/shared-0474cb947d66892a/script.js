
// Draws each scan as one matrix in the page's own styles. Rows and columns are two axes; every other axis is a dropdown
// that starts at "All", so a cell holds the runs of all of them, as dots or, past sixteen, a pie chart. Clicking such a
// cell pins the axes it sits on and moves rows and columns on to the next two, and Back and Forward
// step through the views visited. Only axis values and crossings that have runs are ever offered or drawn.
(() => {
  const same = (a, b) => String(a) === String(b);
  const LIMIT = 16;
  const SVG = "http://www.w3.org/2000/svg";
  const ANGLE_LEFT = "M41.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l160 160c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L109.3 256 246.6 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-160 160z";
  const ANGLE_RIGHT = "M278.6 233.4c12.5 12.5 12.5 32.8 0 45.3l-160 160c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L210.7 256 73.4 118.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l160 160z";

  // Text with $...$ math into an element, typeset by the page's KaTeX.
  const write = (element, text) => {
    for (const [index, part] of String(text).split("$").entries()) {
      if (index % 2 === 0) element.append(part);
      else {
        const math = document.createElement("span");
        if (globalThis.katex) katex.render(part, math, {throwOnError: false});
        else math.textContent = part;
        element.append(math);
      }
    }
    return element;
  };
  const cell = (tag, text, attributes = {}) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return text === undefined ? element : write(element, text);
  };
  const closeMenus = except => {
    for (const select of document.querySelectorAll(".scan-select")) {
      if (select === except) continue;
      select.querySelector("[role=listbox]").classList.remove("show");
      select.querySelector("button[aria-expanded]").setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", event => { if (!event.target.closest?.(".scan-select")) closeMenus(); });

  const draw = root => {
    const data = JSON.parse(root.querySelector('script[type="application/json"]').textContent);
    const icons = Object.fromEntries([...root.querySelectorAll("img[data-status]")].map(image => [image.dataset.status, image]));
    const statuses = data.statuses ?? {};
    // Each status's name and the script's words in the page language, which the page's data carries.
    const names = data.names ?? {};
    const T = (key, values = {}) => (data.text?.[key] ?? key).replace(/%\((\w+)\)s/g, (all, name) => values[name] ?? all);
    const axis = key => data.axes.find(item => item.key === key);
    const keys = data.axes.map(item => item.key);
    // The two drawn axes, every other axis fixed to a value or "*" for All, and the pins in the order they were made,
    // each group being the axes one click pinned together and the rows and columns it left.
    const state = {rows: data.view.rows || keys[0], columns: data.view.columns || "", fixed: Object.fromEntries(keys.map(key => [key, "*"])), status: "", outcome: ""};
    const controls = root.appendChild(cell("div", undefined, {class: "scan-controls"}));
    // The views visited, as JSON, and which one is shown; Back and Forward move along them.
    const visits = {entries: [], index: -1};
    const bar = root.appendChild(cell("div", undefined, {class: "scan-history"}));
    const group = bar.appendChild(cell("div", undefined, {class: "btn-group btn-group-sm", role: "group", "aria-label": T("matrix-views-visited")}));
    // Font Awesome Free 6, solid "angle-left" and "angle-right" (CC BY 4.0), inline so the page needs no icon font.
    const icon = shape => {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 320 512");
      svg.setAttribute("class", "scan-history-icon");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("fill", "currentColor");
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", shape);
      svg.append(path);
      return svg;
    };
    const back = group.appendChild(cell("button", undefined, {type: "button", class: "btn btn-outline-secondary", "aria-label": T("matrix-back"), title: T("matrix-back")}));
    back.append(icon(ANGLE_LEFT));
    const forward = group.appendChild(cell("button", undefined, {type: "button", class: "btn btn-outline-secondary", "aria-label": T("matrix-forward"), title: T("matrix-forward")}));
    forward.append(icon(ANGLE_RIGHT));
    const holder = root.appendChild(cell("div", undefined, {class: "scan-matrices"}));
    let focused = null;
    let popovers = [];

    // One control: its bold label and info button above a dropdown whose entries can hold math, placed in the band of
    // its kind: the axes drawn, the other axes, or the filters on the runs.
    let bands = {};
    const control = (band, label, description, options, value, change) => {
      // A control with a single choice decides nothing.
      if (options.length < 2) return;
      const wrapper = bands[band].appendChild(cell("div", undefined, {class: "scan-control"}));
      const heading = wrapper.appendChild(cell("div", label, {class: "scan-label"}));
      if (globalThis.quartoInfoButton) heading.append(quartoInfoButton(description));
      const select = wrapper.appendChild(cell("div", undefined, {class: "scan-select"}));
      const current = options.find(([optionValue]) => same(optionValue, value)) ?? options[0];
      const button = select.appendChild(cell("button", current[1], {type: "button", class: "form-select form-select-sm", "aria-haspopup": "listbox", "aria-expanded": "false"}));
      const list = select.appendChild(cell("ul", undefined, {class: "dropdown-menu", role: "listbox"}));
      const items = options.map(([optionValue, text, explanation]) => {
        const chosen = same(optionValue, current[0]);
        const item = cell("button", text, {type: "button", role: "option", class: `dropdown-item${chosen ? " scan-current" : ""}`, "aria-selected": String(chosen), "data-value": optionValue});
        // An entry with an explanation carries the same info button as the labels; pressing it explains without choosing.
        if (explanation && globalThis.quartoInfoButton) {
          const info = item.appendChild(quartoInfoButton(explanation));
          info.addEventListener("click", event => event.stopPropagation());
        }
        item.addEventListener("click", () => {
          // The current entry is only dimmed: choosing it again just closes the menu.
          if (chosen) {
            closeMenus();
            button.focus();
            return;
          }
          change(String(optionValue));
          focused = label;
          visit();
          render();
        });
        list.appendChild(cell("li")).append(item);
        return item;
      });
      button.addEventListener("click", () => {
        const open = !list.classList.contains("show");
        closeMenus(select);
        list.classList.toggle("show", open);
        button.setAttribute("aria-expanded", String(open));
        if (open) items[Math.max(items.findIndex(item => item.classList.contains("scan-current")), 0)].focus();
      });
      select.addEventListener("keydown", event => {
        const position = items.indexOf(document.activeElement);
        if (event.key === "Escape") { closeMenus(); button.focus(); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!list.classList.contains("show")) button.click();
          else items[(position + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
        }
      });
      if (focused === label) button.focus();
    };

    const roles = () => [state.rows, state.columns].filter(Boolean);
    // The runs under every pin except those of the axes listed; the drawn axes are never pinned.
    const matching = (exclude = []) => data.points.filter(point => keys.every(key => exclude.includes(key) || roles().includes(key) || state.fixed[key] === "*" || same(point.coordinates[key], state.fixed[key])));
    const valuesOf = (points, key) => axis(key).values.filter(value => points.some(point => same(point.coordinates[key], value.value)));
    const shown = point => (!state.status || point.status === state.status) && (!state.outcome || point.outcome === state.outcome);
    // Keeps the state consistent after any change: a drawn axis is not pinned, and a pin whose value has no runs under the
    // others goes back to All.
    const settle = () => {
      for (const key of roles()) state.fixed[key] = "*";
      for (const key of keys) if (state.fixed[key] !== "*" && !valuesOf(matching([key]), key).some(value => same(value.value, state.fixed[key]))) state.fixed[key] = "*";
    };
    // Pins the axes of a clicked cell and moves rows and columns on to the next two axes that still vary.
    const open = (rowValue, columnValue) => {
      const before = {rows: state.rows, columns: state.columns};
      state.fixed[state.rows] = String(rowValue);
      if (state.columns) state.fixed[state.columns] = String(columnValue);
      const left = roles();
      state.rows = state.columns = "";
      const points = matching();
      const next = keys.filter(key => !left.includes(key) && state.fixed[key] === "*" && valuesOf(points, key).length > 1);
      if (!next.length) {
        for (const key of left) state.fixed[key] = "*";
        [state.rows, state.columns] = [before.rows, before.columns];
        return;
      }
      [state.rows, state.columns] = [next[0], next[1] ?? ""];
    };
    const snapshot = () => JSON.stringify({rows: state.rows, columns: state.columns, fixed: state.fixed, status: state.status, outcome: state.outcome});
    // A change made through a control or a cell is a new view: Back and Forward step along the views, and a new change
    // drops the ones ahead. A change that leaves the view as it was adds nothing.
    const visit = () => {
      settle();
      const now = snapshot();
      if (visits.entries[visits.index] === now) return;
      visits.entries.splice(visits.index + 1);
      visits.entries.push(now);
      visits.index = visits.entries.length - 1;
    };
    const go = by => {
      const target = visits.index + by;
      if (target < 0 || target >= visits.entries.length) return;
      visits.index = target;
      Object.assign(state, JSON.parse(visits.entries[target]));
      render();
    };

    const order = () => [...Object.keys(statuses), ...new Set(data.points.map(point => point.status).filter(word => !(word in statuses)))];
    const tally = points => new Map(order().map(word => [word, points.filter(point => point.status === word).length]).filter(([, count]) => count));
    const swatch = word => {
      const element = cell("span", undefined, {class: "scan-dot"});
      if (statuses[word]) element.style.background = statuses[word];
      else element.classList.add("scan-hollow");
      return element;
    };
    // A full pie of the statuses, in their colours: one wedge each from the top, clockwise, with no number in it.
    const pie = points => {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 32 32");
      svg.setAttribute("class", "scan-pie");
      svg.setAttribute("aria-hidden", "true");
      const parts = [...tally(points)];
      const paint = (shape, word) => {
        shape.setAttribute("fill", statuses[word] || "#dee2e6");
        shape.setAttribute("stroke", "var(--bs-body-bg, #ffffff)");
        shape.setAttribute("stroke-width", "0.75");
        shape.setAttribute("stroke-linejoin", "round");
        svg.append(shape);
      };
      if (parts.length === 1) {
        const disc = document.createElementNS(SVG, "circle");
        for (const [name, value] of Object.entries({cx: 16, cy: 16, r: 16})) disc.setAttribute(name, value);
        paint(disc, parts[0][0]);
        return svg;
      }
      let angle = -Math.PI / 2;
      for (const [word, count] of parts) {
        const sweep = 2 * Math.PI * count / points.length;
        const point = turn => `${(16 + 16 * Math.cos(turn)).toFixed(3)} ${(16 + 16 * Math.sin(turn)).toFixed(3)}`;
        const wedge = document.createElementNS(SVG, "path");
        wedge.setAttribute("d", `M16 16 L${point(angle)} A16 16 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(angle + sweep)} Z`);
        paint(wedge, word);
        angle += sweep;
      }
      return svg;
    };
    const dots = points => {
      const box = cell("span", undefined, {class: "scan-dots"});
      for (const point of points) box.appendChild(swatch(point.status));
      return box;
    };
    // Hovering a cell of several runs shows a popover of the same kind as a single run's: its runs by status, with the
    // status icons, and by logged outcome, each in a table of its own.
    const summary = (anchor, points) => {
      const instance = globalThis.tippy?.(anchor, {
        content: () => {
          const box = cell("div", undefined, {class: "diagram-popover scan-popover"});
          const table = (heading, rows) => {
            const element = cell("table", undefined, {class: "table table-sm"});
            element.appendChild(cell("thead")).appendChild(cell("tr")).append(...heading);
            const body = element.appendChild(cell("tbody"));
            for (const row of rows) body.appendChild(cell("tr")).append(...row);
            return element;
          };
          const count = value => cell("td", String(value), {class: "text-end"});
          box.append(cell("p", T("matrix-cell-statuses", { count: points.length })));
          box.append(table([cell("th", undefined, {class: "scan-icon-cell"}), cell("th", T("matrix-status")), cell("th", T("matrix-runs"), {class: "text-end"})],
            [...tally(points)].map(([word, runs]) => {
              const icon = cell("td", undefined, {class: "scan-icon-cell"});
              if (icons[word]) icon.append(icons[word].cloneNode());
              return [icon, cell("td", names[word] ?? word), count(runs)];
            })));
          const outcomes = Object.keys(data.outcomes ?? {}).map(code => [code, points.filter(point => point.outcome === code).length]).filter(([, runs]) => runs);
          if (outcomes.length) {
            box.append(cell("p", T("matrix-cell-outcomes", { count: points.length })));
            box.append(table([cell("th", T("matrix-outcome")), cell("th", T("matrix-runs"), {class: "text-end"})], outcomes.map(([code, runs]) => [cell("td", data.outcomes[code].title), count(runs)])));
          }
          return box;
        },
        allowHTML: true, maxWidth: "none", delay: 100, arrow: false, interactive: true, interactiveBorder: 10,
        theme: "quarto", placement: "bottom-start", appendTo: () => document.body,
      });
      if (instance) popovers.push(instance);
    };

    const render = () => {
      settle();
      for (const instance of popovers) instance.destroy();
      popovers = [];
      const points = matching();
      const free = keys.filter(key => !roles().includes(key));
      const options = Object.fromEntries(free.map(key => [key, valuesOf(matching([key]), key)]));

      // Every control sits in one row, in order, and wraps onto new rows where the page is too narrow for them.
      const row = cell("div", undefined, {class: "scan-control-band"});
      bands = {layout: row, axes: row, filters: row};
      controls.replaceChildren(row);
      // Rows and columns offer only axes that vary under the other pins, and the drawn ones.
      const choices = none => [...(none ? [["", T("matrix-none"), T("matrix-single-column")]] : []),
        ...keys.filter(key => roles().includes(key) || valuesOf(matching([key]), key).length > 1).map(key => [key, axis(key).label, axis(key).description])];
      control("layout", T("matrix-rows"), T("matrix-rows-help"), choices(false), state.rows, key => {
        const previous = state.rows;
        state.rows = key;
        if (state.columns === key) state.columns = previous;
      });
      control("layout", T("matrix-columns"), T("matrix-columns-help"), choices(true), state.columns, key => {
        const previous = state.columns;
        state.columns = key;
        if (key && state.rows === key) state.rows = previous || keys.find(other => other !== key);
      });
      // Each other axis is All, so a cell holds its runs, or one value, offering only values that have runs under the other pins.
      for (const key of free) {
        if (state.fixed[key] === "*" && options[key].length < 2) continue;
        control("axes", axis(key).label, `${axis(key).description ? `${axis(key).description} ` : ""}${T("matrix-all-help")}`,
                [["*", T("matrix-all")], ...options[key].map(value => [value.value, value.tick])], state.fixed[key], value => { state.fixed[key] = value; });
      }
      const found = field => [...new Set(data.points.map(point => point[field]).filter(Boolean))];
      if (found("status").length > 1) control("filters", T("matrix-status"), T("matrix-status-help"), [["", T("matrix-all")], ...found("status").map(word => [word, names[word] ?? word])], state.status, value => { state.status = value; });
      if (found("outcome").length) {
        control("filters", T("matrix-outcome"), T("matrix-outcome-help"), [["", T("matrix-all")], ...found("outcome").map(code => [code, data.outcomes[code].title])], state.outcome, value => { state.outcome = value; });
      }
      for (const band of Object.values(bands)) if (!band.children.length) band.remove();
      focused = null;

      back.disabled = visits.index <= 0;
      forward.disabled = visits.index >= visits.entries.length - 1;

      // Only the values of the drawn axes that have runs are drawn, and a crossing without a run is a gap.
      const rows = valuesOf(points, state.rows).reverse();
      const columns = state.columns ? valuesOf(points, state.columns) : [null];
      const grid = cell("div", undefined, {class: "scan-grid"});
      const place = (element, row, column) => {
        element.style.gridArea = `${row} / ${column} / span 1 / span 1`;
        grid.append(element);
      };
      rows.forEach((rowValue, index) => {
        place(cell("div", rowValue.tick, {class: "scan-row-tick"}), 1 + index, 1);
        columns.forEach((column, position) => {
          const positioned = points.filter(point => same(point.coordinates[state.rows], rowValue.value) && (column === null || same(point.coordinates[state.columns], column.value)));
          const here = positioned.filter(shown);
          // No run at this crossing leaves a gap; runs that the filters hide leave a grey cell.
          const target = cell("div", undefined, {class: !positioned.length ? "scan-cell scan-void" : here.length ? "scan-cell" : "scan-cell scan-unselected"});
          place(target, 1 + index, position + 2);
          if (here.length === 1) {
            const link = target.appendChild(cell("a", undefined, {href: here[0].href, "aria-label": names[here[0].status] ?? here[0].status}));
            if (icons[here[0].status]) link.append(icons[here[0].status].cloneNode());
            globalThis.calculationPopover?.(link, null);
          } else if (here.length > 1) {
            const button = target.appendChild(cell("button", undefined, {type: "button", class: "scan-open", "aria-label": T("matrix-open-runs", { count: here.length })}));
            button.append(here.length <= LIMIT ? dots(here) : pie(here));
            summary(button, here);
            button.addEventListener("click", () => { open(rowValue.value, column?.value); visit(); render(); });
          }
        });
      });
      if (state.columns) columns.forEach((column, position) => place(cell("div", column.tick, {class: "scan-column-tick"}), 1 + rows.length, position + 2));

      const view = cell("div", undefined, {class: "scan-view"});
      // Each axis title carries its axis's info button, as its control's label does.
      const titled = (element, key) => {
        if (axis(key).description && globalThis.quartoInfoButton) element.append(quartoInfoButton(axis(key).description));
        return element;
      };
      // Typeset upright and rotated as a whole, because math breaks in a vertical writing mode; absolute, so it sets no row height.
      const rowTitle = view.appendChild(cell("div", undefined, {class: "scan-row-title"}));
      const rowText = rowTitle.appendChild(titled(cell("span", axis(state.rows).label), state.rows));
      const area = view.appendChild(cell("div", undefined, {class: "scan-area"}));
      area.append(grid);
      const columnTitle = state.columns ? view.appendChild(titled(cell("div", axis(state.columns).label, {class: "scan-column-title"}), state.columns)) : null;
      holder.replaceChildren(view);

      // Centre the titles on the cells alone, not on the ticks beside them, and fit the rotated one along their height.
      // The row title's width and its text's length depend on each other, so the fit repeats until a pass changes nothing,
      // on every redraw and resize, and never keeps an earlier layout.
      const fit = () => {
        const boxes = [...area.querySelectorAll(".scan-cell")].map(target => target.getBoundingClientRect());
        const left = Math.min(...boxes.map(box => box.left)), right = Math.max(...boxes.map(box => box.right));
        const top = Math.min(...boxes.map(box => box.top)), bottom = Math.max(...boxes.map(box => box.bottom));
        if (columnTitle) {
          columnTitle.style.marginLeft = `${left - area.getBoundingClientRect().left}px`;
          columnTitle.style.width = `${right - left}px`;
        }
        rowText.style.width = `${bottom - top}px`;
        rowTitle.style.width = `${rowText.offsetHeight}px`;
        const shifted = area.querySelector(".scan-cell").getBoundingClientRect().top - boxes[0].top;
        rowText.style.top = `${(top + bottom) / 2 + shifted - rowTitle.getBoundingClientRect().top}px`;
        return [columnTitle?.style.cssText, rowText.style.cssText, rowTitle.style.cssText].join("|");
      };
      arrange = () => {
        let last = "";
        for (let pass = 0; pass < 5; pass++) {
          const now = fit();
          if (now === last) break;
          last = now;
        }
      };
      arrange();
      // The fonts and the browser's own layout may settle after the redraw: fit once more then.
      globalThis.requestAnimationFrame?.(() => arrange());
    };
    let arrange = () => {};
    if (globalThis.ResizeObserver) new ResizeObserver(() => arrange()).observe(holder);
    // Ticks and titles change size when the math fonts arrive.
    document.fonts?.ready.then(() => arrange());
    back.addEventListener("click", () => go(-1));
    forward.addEventListener("click", () => go(1));
    visit();
    render();
  };

  // The hover popovers of a scan's node and row draw a copy of the hidden data of their own.
  globalThis.drawScan = draw;
  for (const root of document.querySelectorAll(".scan-matrix")) if (!root.closest(".diagram-details")) draw(root);
})();
