
(() => {
    const labels = new Map(), descriptions = new Map(), sources = new WeakSet(), records = new WeakMap(), templates = new Map();
    // An explanation's Markdown as HTML: $...$ LaTeX typeset by KaTeX, and links, inline code, bold and italics.
    function explanation(text) {
        // Lines starting with "- " form a bulleted list; any other line is a run of inline Markdown before or after it.
        const html = [];
        let items = null;
        for (const line of text.split('\n')) {
            if (line.startsWith('- ')) {
                if (!items) { items = []; html.push(items); }
                items.push(line.slice(2));
            } else if (line.trim()) {
                items = null;
                html.push(line);
            }
        }
        return html.map(part => Array.isArray(part) ? '<ul>' + part.map(item => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</ul>' : '<div>' + inlineMarkdown(part) + '</div>').join('');
    }
    function inlineMarkdown(text) {
        const escape = part => part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const inline = part => escape(part)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
        return text.split(/(\$[^$]+\$)/).map(part => part.length > 2 && part.startsWith('$') && part.endsWith('$')
            ? (globalThis.katex ? katex.renderToString(part.slice(1, -1), {throwOnError:false}) : escape(part))
            : inline(part)).join('');
    }
    // An info button that opens an explanation, Markdown with $...$ LaTeX, in Quarto's own hover popover, typeset
    // when the popover opens.
    function infoButton(description) {
        const button = document.createElement('span');
        button.className = 'quantity-info-icon';
        button.dataset.quartoMath = 'true';
        button.setAttribute('aria-label', 'Explanation');
        // Material "info" outline icon.
        button.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"></path></svg>';
        if (globalThis.tippy) tippy(button, {
            content: '',
            onShow(instance) {
                const box = document.createElement('div');
                box.className = 'quantity-popover';
                box.innerHTML = explanation(description);
                instance.setContent(box);
            },
            allowHTML: true, maxWidth: 'none', delay: 100, arrow: false, theme: 'quarto', placement: 'bottom',
            appendTo: () => document.body,
        });
        return button;
    }
    // Viewers' colour scales open their quantity's explanation from the same button.
    globalThis.quartoInfoButton = infoButton;
    // Table cells that scientific_table gave an explanation, a marker after their label holding its Markdown source,
    // get their info button once.
    function describeHeaders() {
        for (const marker of document.querySelectorAll('span.quantity-info[data-description]:not([data-ready])')) {
            marker.dataset.ready = 'true';
            const bytes = Uint8Array.from(atob(marker.dataset.description), c => c.charCodeAt(0));
            marker.replaceChildren(infoButton(new TextDecoder().decode(bytes)));
        }
    }
    const measure = document.createElement('div');
    Object.assign(measure.style, {position:'fixed', left:'-10000px', top:'0', visibility:'hidden', whiteSpace:'nowrap', lineHeight:'1'});
    measure.dataset.quartoMath = 'true';
    let scheduled = false;
    function formula(value) {
        const text = value.trim().replaceAll('\u2212', '-');
        const scientific = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))[eE]([+-]?\d+)$/);
        const result = scientific
            ? `$\\mathord{${scientific[1]}\\times 10^{${Number(scientific[2])}}}$`
            : labels.get(text) || text;
        return result?.startsWith('$') && result.endsWith('$') ? result.slice(1, -1) : null;
    }
    // A label with inline math, or any registered label that differs from the raw field name.
    function mixed(value) {
        const key = value.trim(), text = labels.get(key) || key;
        return (/\$[^$]+\$/.test(text) || text !== key) && formula(value) === null ? text : null;
    }
    function typeset(value, size, family = 'inherit', isMixed = false) {
        const key = JSON.stringify([value, size, family, isMixed]);
        if (!templates.has(key)) {
            const span = document.createElement('span');
            span.style.fontSize = size;
            span.style.fontFamily = family;
            // Mixed labels alternate plain text and $...$ math; others are one formula.
            for (const part of isMixed ? value.split(/(\$[^$]+\$)/).filter(Boolean) : ['$' + value + '$']) {
                if (!(part.startsWith('$') && part.endsWith('$'))) { span.append(document.createTextNode(part)); continue; }
                const math = document.createElement('span');
                katex.render(part.slice(1, -1), math, {throwOnError:true, displayMode:false});
                span.append(math);
            }
            // A zero-size probe on the baseline gives the formula's real ascent, so it can sit
            // on the SVG text's baseline instead of an estimate from its height.
            const probe = document.createElement('span');
            Object.assign(probe.style, {display:'inline-block', width:'0', height:'0', verticalAlign:'baseline'});
            span.append(probe);
            measure.append(span);
            const bounds = span.getBoundingClientRect();
            const baseline = probe.getBoundingClientRect().top - bounds.top;
            probe.remove();
            templates.set(key, {span:span.cloneNode(true), width:bounds.width, height:bounds.height, baseline});
            span.remove();
        }
        return templates.get(key);
    }

    // Sets each axis title clear of its tick labels: snug on a chart's first layout, and only ever further out once laid
    // out, so that titles stay still as a zoom changes the width of the labels, moving only to avoid overlapping them.
    function spaceAxisTitles(charts, snug) {
        for (const text of charts.flatMap(chart => [...chart.querySelectorAll('.role-axis-title > text')])) {
            const record = records.get(text);
            const axis = text.closest('.role-axis');
            if (!record?.node.isConnected || !axis) continue;
            const ticks = [...axis.querySelectorAll('.role-axis-label > text')]
                .map(tick => records.get(tick)?.node || tick)
                .map(tick => tick.getBoundingClientRect())
                .filter(rect => rect.width && rect.height);
            if (!ticks.length) continue;
            const title = record.node.getBoundingClientRect();
            const vertical = /rotate\(\s*-?90/.test(text.getAttribute('transform') || '');
            let dx = 0, dy = 0;
            if (vertical) {
                const domain = axis.querySelector('.role-axis-domain line');
                if (!domain) continue;
                const centre = domain.getBoundingClientRect().left;
                const left = (title.left + title.right) / 2 < centre;
                const boundary = left ? Math.min(...ticks.map(r => r.left)) : Math.max(...ticks.map(r => r.right));
                dx = left ? boundary - title.right - 8 : boundary + 8 - title.left;
                if (!snug && (left ? dx > 0 : dx < 0)) dx = 0;
            } else {
                dy = Math.max(...ticks.map(r => r.bottom)) + 8 - title.top;
                if (!snug && dy < 0) dy = 0;
            }
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
            const inverse = record.node.parentNode.getScreenCTM()?.inverse();
            if (!inverse) continue;
            record.offsetX = (record.offsetX || 0) + inverse.a * dx + inverse.c * dy;
            record.offsetY = (record.offsetY || 0) + inverse.b * dx + inverse.d * dy;
            record.node.setAttribute('transform',
                `translate(${record.offsetX},${record.offsetY}) ${text.getAttribute('transform') || ''}`);
        }
    }

    // Vega lays a legend out from its plain label text, which for a typeset label is the LaTeX source, and in a
    // single row unless told otherwise. Lay every legend of a plot out again from the typeset widths. Each legend is
    // a grid: entries in reading order, each column as wide as its own widest entry, as many columns as fit, rows
    // at Vega's spacing. The legends of one plot then flow left to right from where Vega put the first, a legend
    // moving to a new band below when it would need more rows beside the previous one than on its own. The plot
    // grows by the height the legends gained. Vega's own transforms are kept as the originals, so a Vega re-layout
    // is taken as the new original.
    function original(node) {
        const current = node.getAttribute('transform') || 'translate(0,0)';
        if (current !== node.dataset.quartoShifted) node.dataset.quartoOriginal = current;
        const match = node.dataset.quartoOriginal.match(/translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)\s*\)/);
        return match && {current, x: Number(match[1]), y: Number(match[2])};
    }
    function place(node, current, x, y) {
        const wanted = `translate(${x},${y})`;
        node.dataset.quartoShifted = wanted;
        if (current !== wanted) node.setAttribute('transform', wanted);
    }
    const legendGap = 16, legendBandGap = 10;
    // A legend's grid for a width: column count, column starts, row count and total width.
    function grid(entries, room) {
        const widths = count => Array.from({length: count}, (_, column) =>
            Math.max(...entries.filter((_, index) => index % count === column).map(entry => entry.width)));
        let columns = entries.length;
        while (columns > 1 && widths(columns).reduce((sum, width) => sum + width + legendGap, 0) - legendGap > room) columns--;
        const starts = widths(columns).reduce((list, width) => [...list, list[list.length - 1] + width + legendGap], [0]);
        return {columns, starts, rows: Math.ceil(entries.length / columns), width: starts[columns] - legendGap};
    }
    // A colour-gradient legend has no entries to lay out, but Vega sets it below the same LaTeX-sized band: it too
    // starts Vega's legend offset below the axes as drawn.
    function raiseGradients(svg, scale) {
        for (const legend of svg.querySelectorAll('.role-legend > g')) {
            if (legend.querySelector('.role-legend-entry .role-scope')) continue;
            const self = original(legend), shown = self?.current.match(/translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/);
            const drawn = [...svg.querySelectorAll('.role-axis line, .role-axis path, .role-axis text, .role-axis foreignObject')]
                .filter(node => node.tagName !== 'text' || getComputedStyle(node).visibility !== 'hidden')
                .map(node => node.getBoundingClientRect()).filter(rect => rect.width || rect.height);
            if (!shown || !drawn.length) continue;
            const top = legend.getBoundingClientRect().top, axesBottom = Math.max(...drawn.map(rect => rect.bottom));
            if (top < axesBottom - 1) continue;
            const placed = Number(shown[2]), wanted = placed + (axesBottom + 18 * scale - top) / scale;
            if (Math.abs(wanted - placed) >= 1) place(legend, self.current, Number(shown[1]), Math.round(wanted));
        }
    }
    function spaceLegends(charts) {
        for (const svg of charts.flatMap(chart => [...chart.querySelectorAll('svg.marks')])) {
            const scale = svg.getScreenCTM()?.a || 1;
            raiseGradients(svg, scale);
            const legends = [];
            let ready = true;
            for (const legend of svg.querySelectorAll('.role-legend > g')) {
                const scope = legend.querySelector('.role-legend-entry .role-scope');
                const self = original(legend);
                if (!scope || !self) continue;
                const entries = [];
                for (const item of [...scope.children].filter(child => child.matches('g[transform]'))) {
                    const position = original(item);
                    const text = item.querySelector('.role-legend-label > text');
                    if (!position || !text) continue;
                    // The drawn extent of the entry, symbol to the end of its label as shown (typeset or plain), in
                    // the plot's own units.
                    const node = records.get(text)?.node;
                    const label = (node?.isConnected ? node.querySelector('div') || node : text).getBoundingClientRect();
                    const start = item.getBoundingClientRect().left;
                    entries.push({item, ...position, width: label.width ? (label.right - start) / scale : 0});
                }
                // A legend not laid out yet, as in a closed fold, is measured once it is shown.
                if (!entries.length || entries.some(entry => !entry.width)) { ready = false; break; }
                entries.sort((a, b) => a.y - b.y || a.x - b.x);
                const ys = [...new Set(entries.map(entry => entry.y))].sort((a, b) => a - b);
                // Where the entries start within the legend, below its title.
                const offset = (scope.getBoundingClientRect().top - legend.getBoundingClientRect().top) / scale;
                legends.push({legend, self, entries, rows: ys.length, rowHeight: ys.length > 1 ? ys[1] - ys[0] : 20,
                              left: Math.min(...entries.map(entry => entry.x)), top: ys[0],
                              inset: (scope.getBoundingClientRect().left - legend.getBoundingClientRect().left) / scale,
                              head: Math.max(0, offset)});
            }
            if (!ready || !legends.length) continue;
            const origin = {x: Math.min(...legends.map(item => item.self.x)), y: Math.min(...legends.map(item => item.self.y))};
            // Vega sets a bottom legend below the x axis as it measured it, from the LaTeX source of typeset labels,
            // which rotated reach far below the typeset ones. Such legends start instead Vega's legend offset below
            // the axes as drawn: their lines, shown labels and titles.
            const first = legends[0], shown = first.self.current.match(/translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/);
            const drawn = [...svg.querySelectorAll('.role-axis line, .role-axis path, .role-axis text, .role-axis foreignObject')]
                .filter(node => node.tagName !== 'text' || getComputedStyle(node).visibility !== 'hidden')
                .map(node => node.getBoundingClientRect()).filter(rect => rect.width || rect.height);
            const legendTop = first.legend.getBoundingClientRect().top;
            const axesBottom = Math.max(...drawn.map(rect => rect.bottom));
            if (shown && drawn.length && legendTop >= axesBottom - 1) {
                // Moved only by a whole step of at least a pixel, so that a later pass finds the legends where it
                // would put them and writes nothing, instead of each write's mutation scheduling another pass.
                const placed = Number(shown[2]) - (first.self.y - origin.y);
                const wanted = placed + (axesBottom + 18 * scale - legendTop) / scale;
                origin.y = Math.abs(wanted - placed) < 1 ? placed : Math.round(wanted);
            }
            // The room from where the legends start to the plot's right edge, in the plot's units: the first legend's
            // drawn left edge, taken back to the origin from its current position.
            const shownX = Number(first.self.current.match(/translate\(\s*([-\d.e]+)/)?.[1] ?? first.self.x);
            const room = (svg.getBoundingClientRect().right - first.legend.getBoundingClientRect().left) / scale + shownX - origin.x;
            const heightOf = (item, rows) => item.head + rows * item.rowHeight;
            const originalBottom = Math.max(...legends.map(item => item.self.y + heightOf(item, item.rows)));
            let x = origin.x, y = origin.y, bottom = origin.y;
            for (const item of legends) {
                const alone = grid(item.entries, room - item.inset);
                let layout = grid(item.entries, room - item.inset - (x - origin.x));
                // Beside the previous legend only when it fits there without needing more rows.
                if (x > origin.x && (layout.rows > alone.rows || x - origin.x + item.inset + layout.width > room)) {
                    x = origin.x; y = bottom + legendBandGap; layout = alone;
                }
                place(item.legend, item.self.current, x, y);
                item.entries.forEach((entry, index) => place(entry.item, entry.current,
                    item.left + layout.starts[index % layout.columns], item.top + Math.floor(index / layout.columns) * item.rowHeight));
                bottom = Math.max(bottom, y + heightOf(item, layout.rows));
                x += item.inset + layout.width + 2 * legendGap;
            }
            // Grow the plot by the height the legends gained over Vega's own layout,
            const height = svg.getAttribute('height');
            if (height !== svg.dataset.quartoHeight) svg.dataset.quartoBase = height;
            // or shrink it by the height they gave back by moving up.
            const extra = bottom - originalBottom;
            const wantedHeight = String(Number(svg.dataset.quartoBase) + extra);
            svg.dataset.quartoHeight = wantedHeight;
            if (height !== wantedHeight) {
                svg.setAttribute('height', wantedHeight);
                const box = svg.getAttribute('viewBox')?.split(/[ ,]+/).map(Number);
                if (box?.length === 4) svg.setAttribute('viewBox', [box[0], box[1], box[2], Number(wantedHeight)].join(' '));
            }
        }
    }

    // Vega reserves the x-axis band from the LaTeX source of labels that are rotated, and the page typesets them much
    // narrower, moving the axis title up to them; the rest of the reserved band then stays empty below the plot. Trim
    // the svg to its lowest drawn element, so no blank strip separates the chart from the block beneath it, and keep
    // the viewBox at the drawn scale so positions and interactions are unchanged.
    function trimEmptyBand(charts) {
        for (const svg of charts.flatMap(chart => [...chart.querySelectorAll('svg.marks')])) {
            const rect = svg.getBoundingClientRect();
            if (!rect.height) continue;
            let bottom = -Infinity;
            // Axes, legends, text marks and the plot frame establish the visible extent; the data marks lie inside it,
            // and a page's thousands of them must not be measured.
            for (const node of svg.querySelectorAll(
                '.role-axis :is(text, foreignObject, path, line), .role-legend :is(text, foreignObject, path, line, rect), .mark-text :is(text, foreignObject), .role-frame > path')) {
                // Zoomed marks can extend far beyond their clip path; their bounding boxes ignore clipping and
                // must not grow the SVG.
                if (node.closest('defs, clipPath, mask, marker, pattern, [clip-path]')) continue;
                const style = getComputedStyle(node);
                if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
                const drawn = node.getBoundingClientRect();
                if (drawn.width || drawn.height) bottom = Math.max(bottom, drawn.bottom);
            }
            if (!isFinite(bottom)) continue;
            const scale = rect.height / (svg.viewBox.baseVal.height || rect.height);
            const wanted = String(Math.ceil((bottom - rect.top) / scale + 2));
            if (svg.getAttribute('height') === wanted) continue;
            svg.setAttribute('height', wanted);
            const box = svg.getAttribute('viewBox')?.split(/[ ,]+/).map(Number);
            if (box?.length === 4) svg.setAttribute('viewBox', [box[0], box[1], box[2], wanted].join(' '));
        }
    }

    // What changed since the last scan: the whole page, the charts in ``dirty``, or the tooltip. A zoom redraws one chart
    // every frame, so a scan touches only that chart.
    let wholePage = true, tooltipChanged = false, settling = 0;
    const dirty = new Set(), unsettled = new Set(), settled = new WeakSet();
    function settle() {
        settling = 0;
        const charts = [...unsettled].filter(chart => chart.isConnected);
        unsettled.clear();
        spaceLegends(charts);
        trimEmptyBand(charts);
    }
    // The page's registered plot labels and their explanations, read once each script is complete.
    function readSources() {
        for (const source of document.querySelectorAll('script.quarto-plot-labels, script.quarto-plot-descriptions')) {
            if (sources.has(source)) continue;
            const target = source.classList.contains('quarto-plot-labels') ? labels : descriptions;
            // The observer can see a script before the HTML parser has finished its JSON text. Leave it pending;
            // the subsequent text mutation or DOMContentLoaded schedules another scan.
            let entries;
            try { entries = Object.entries(JSON.parse(source.textContent)); }
            catch (error) {
                if (document.readyState !== 'loading' && source.textContent.trim()) console.error('Invalid plot labels:', error);
                continue;
            }
            for (const [key, value] of entries) if (value) target.set(key, value);
            sources.add(source);
        }
    }
    // Vega reserves room for axis labels, legends and titles from each text's width as a canvas measures it, which
    // for a typeset label is its LaTeX source, often twice as wide as the math drawn. Measured as typeset instead,
    // every chart lays out around its labels as they appear: the bands beside its axes and the legend below adapt
    // to them. Any other text is measured as before.
    const measureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text) {
        const metrics = measureText.call(this, text);
        if (!globalThis.katex || !document.body || typeof text !== 'string' || !text.trim()) return metrics;
        readSources();
        const label = mixed(text), value = label || formula(text);
        const size = this.font.match(/([\d.]+)px/);
        if (!value || !size) return metrics;
        try {
            if (!measure.isConnected) document.body.append(measure);
            const width = typeset(value, `${size[1]}px`, this.font.slice(size.index + size[0].length).trim() || 'inherit', Boolean(label)).width;
            return {width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width,
                    actualBoundingBoxAscent: metrics.actualBoundingBoxAscent, actualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
                    fontBoundingBoxAscent: metrics.fontBoundingBoxAscent, fontBoundingBoxDescent: metrics.fontBoundingBoxDescent};
        } catch { return metrics; }
    };
    function scan() {
        scheduled = false;
        if (!document.body) return;
        if (!measure.isConnected) document.body.append(measure);
        const whole = wholePage;
        const charts = whole ? [...document.querySelectorAll('.vega-embed')] : [...dirty].filter(chart => chart.isConnected);
        wholePage = false;
        dirty.clear();
        if (whole) readSources();
        if (whole) describeHeaders();
        // Axis and legend text, the titles of facets such as the composition matrices' fragments, and text marks drawn
        // in the plot, which are typeset when they hold inline math.
        for (const text of charts.flatMap(chart => [...chart.querySelectorAll('.role-axis-title > text, .role-axis-label > text, .role-legend-label > text, .role-legend-title > text, .role-title-text > text, .mark-text.role-mark > text')])) {
            const description = text.closest('.role-axis-title, .role-legend-title') && descriptions.get(text.textContent.trim());
            const label = mixed(text.textContent) || (description && !formula(text.textContent) ? text.textContent.trim() : null);
            const value = label || formula(text.textContent);
            if (!value) {
                records.get(text)?.node.remove();
                records.delete(text);
                text.style.visibility = 'inherit';
                continue;
            }
            if (!globalThis.katex) continue;
            const previous = records.get(text), transform = text.getAttribute('transform') || '';
            const x = Number(text.getAttribute('x') || 0), y = Number(text.getAttribute('y') || 0);
            const anchor = text.getAttribute('text-anchor');
            // The typeset copy is hidden and shown as Vega hides and shows the text, as a label is when a zoom leaves no
            // room for it, and a text drawn as an outline beneath another, a halo, keeps that outline as a glow.
            const opacity = String(Number(text.getAttribute('opacity') ?? 1) * Number(text.getAttribute('fill-opacity') ?? 1));
            if (previous?.node.isConnected && previous.node.style.opacity !== opacity) previous.node.style.opacity = opacity;
            // Vega moves a tick's text every frame of a zoom. The same words only move their typeset copy, which is built
            // again, and the font read, only when the words change.
            if (previous?.value === value && previous.node.isConnected) {
                const place = [x, y, transform, anchor].join('|');
                if (place === previous.place) continue;
                previous.place = place;
                const {width, baseline} = previous.math;
                previous.node.setAttribute('x', x - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0));
                previous.node.setAttribute('y', y - baseline + (previous.shift || 0));
                // An axis title keeps the offset that clears it of its labels.
                previous.node.setAttribute('transform', previous.offsetX || previous.offsetY
                    ? `translate(${previous.offsetX || 0},${previous.offsetY || 0}) ${transform}` : transform);
                continue;
            }
            const style = getComputedStyle(text);
            try {
                const math = typeset(value, style.fontSize, style.fontFamily, Boolean(label));
                const node = previous?.node || document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
                node.dataset.quartoMath = 'true';
                node.setAttribute('x', x - (anchor === 'middle' ? math.width / 2 : anchor === 'end' ? math.width : 0));
                node.setAttribute('y', y - math.baseline);
                node.setAttribute('width', math.width + 2); node.setAttribute('height', math.height + 2);
                node.setAttribute('transform', transform); node.style.overflow = 'visible';
                const content = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
                // Legend titles keep Vega's bold weight once typeset.
                Object.assign(content.style, {fontSize:style.fontSize, fontFamily:style.fontFamily, color:style.fill, lineHeight:'1', whiteSpace:'nowrap',
                                              fontWeight: text.closest('.role-legend-title') ? style.fontWeight : 'normal'});
                const halo = text.getAttribute('stroke'), width = Number(text.getAttribute('stroke-width') || 0);
                if (halo && halo !== 'none' && width) content.style.textShadow = Array(4).fill(`0 0 ${width / 2}px ${halo}`).join(', ');
                content.append(math.span.cloneNode(true));
                // An axis or legend title of a described quantity gets its info button.
                if (description) content.append(infoButton(description));
                node.replaceChildren(content);
                node.style.opacity = opacity;
                text.style.visibility = 'hidden';
                if (node.parentNode !== text.parentNode) text.parentNode.append(node);
                text.closest('svg.marks').style.overflow = 'visible';
                // A typeset legend label is centred on its symbol, as plain labels are: its subscripts and
                // superscripts would otherwise leave it visibly off the symbol's middle.
                const symbol = text.closest('.role-legend-label')?.parentNode?.querySelector('.role-legend-symbol path');
                let shift = 0;
                const mark = symbol?.getBoundingClientRect(), drawn = mark && content.getBoundingClientRect();
                if (mark && mark.height && drawn.height) {
                    const scale = drawn.height / (math.height || drawn.height);
                    shift = ((mark.top + mark.bottom) - (drawn.top + drawn.bottom)) / 2 / (scale || 1);
                    node.setAttribute('y', y - math.baseline + shift);
                }
                records.set(text, {value, math, shift, node, place:[x, y, transform, anchor].join('|')});
            } catch (error) {text.style.visibility = 'inherit'; console.error(error);}
        }
        // Legends and the plot's height do not change under a zoom, so a chart already laid out is laid out again only when
        // its redraws stop; a new chart, or a change to the page, is laid out at once.
        const fresh = charts.filter(chart => whole || !settled.has(chart));
        fresh.forEach(chart => settled.add(chart));
        const later = charts.filter(chart => !fresh.includes(chart));
        spaceAxisTitles(later, false);
        if (fresh.length) { spaceAxisTitles(fresh, true); spaceLegends(fresh); trimEmptyBand(fresh); }
        if (later.length) {
            later.forEach(chart => unsettled.add(chart));
            clearTimeout(settling);
            settling = setTimeout(settle, 150);
        }
        if (!globalThis.katex || !(whole || tooltipChanged)) return;
        tooltipChanged = false;
        for (const cell of document.querySelectorAll('.vg-tooltip td.key, .vg-tooltip td.value, .vg-tooltip th')) {
            if (cell.querySelector('.katex')) continue;
            // Mixed text such as "$S_0$ minimum" alternates plain text and $...$ math, as in legends.
            const label = mixed(cell.textContent);
            if (label) {
                cell.replaceChildren(...label.split(/(\$[^$]+\$)/).filter(Boolean).map(part => {
                    if (!(part.startsWith('$') && part.endsWith('$'))) return document.createTextNode(part);
                    const math = document.createElement('span');
                    katex.render(part.slice(1, -1), math, {throwOnError:true, displayMode:false});
                    return math;
                }));
                continue;
            }
            const value = formula(cell.textContent);
            if (!value) continue;
            const math = document.createElement('span');
            katex.render(value, math, {throwOnError:true, displayMode:false});
            cell.replaceChildren(math);
        }
    }
    // Once a frame at most, however many times Vega draws in it; a hidden page draws no frames, so it scans at once.
    function queue() {
        if (scheduled) return;
        scheduled = true;
        if (document.hidden) queueMicrotask(scan); else requestAnimationFrame(scan);
    }
    function schedule() {
        wholePage = true;
        queue();
    }
    // Own math/layout writes must not re-enter the observer and starve browser events. A redraw marks its chart; a change
    // anywhere else marks the whole page.
    const observer = new MutationObserver(mutations => {
        let changed = false;
        // A redraw writes thousands of records for one chart; those of one parent need looking at only once.
        const seen = new Set();
        for (const mutation of mutations) {
            const element = mutation.target.nodeType === Node.ELEMENT_NODE
                ? mutation.target : mutation.target.parentElement;
            // Molstar typesets its own labels; its toolbar and scene updates do not change plot or page math.
            if (!element) continue;
            if (mutation.type === 'childList') {
                const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
                if (nodes.length && nodes.every(node =>
                    node.nodeType === Node.ELEMENT_NODE && node.matches('[data-quarto-math]'))) continue;
            }
            const parent = element.parentNode;
            if (mutation.type === 'attributes' && seen.has(parent)) continue;
            seen.add(parent);
            if (element.closest('.molstar-notebook-viewer, [data-quarto-math]')) continue;
            const tip = element.closest('#vg-tooltip-element');
            if (tip) {
                if (mutation.type === 'childList' && element.querySelector('.katex')) continue;
                tooltipChanged = changed = true;
                continue;
            }
            const chart = element.closest('.vega-embed');
            if (chart) dirty.add(chart); else wholePage = true;
            changed = true;
        }
        if (changed) queue();
    });
    observer.observe(document.documentElement, {childList:true, subtree:true, characterData:true,
        attributes:true, attributeFilter:['transform','x','y','text-anchor','font-size','opacity','fill-opacity']});
    document.addEventListener('DOMContentLoaded', schedule);
    window.addEventListener('load', schedule);
    // Labels are measured as drawn, so lay legends out again once fonts load, on resize and when a fold opens.
    document.fonts?.ready.then(schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('toggle', schedule, true);
    schedule();
})();
