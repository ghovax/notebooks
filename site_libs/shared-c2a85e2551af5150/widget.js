// A molecule drawn with the symmetry elements of its point group, as molstarview.symmetry.SymmetryFigure makes it,
// below a dropdown of representations, such as an orbital product or a state's. The chosen representation colours
// each element by its class's character: symmetric where it equals the character under E, antisymmetric where it is its
// opposite, neither otherwise. Hovering an element shows its class and character, a table below gives the character
// under every class and a legend names the colours by the table's icons.

// Each kind of class's colour, a CSS variable the figure sets from the model's colours (data/symmetry.yaml).
const COLOURS = {symmetric:'var(--molstarview-symmetric)', antisymmetric:'var(--molstarview-antisymmetric)',
    neither:'var(--molstarview-neither)'};

// Font Awesome Free 6, solid "equals", "right-left" and "shuffle" (CC BY 4.0), inline so the page needs no icon font:
// a class the representation leaves unchanged, one whose sign it reverses, and one it mixes. Each is its viewBox
// width and path.
const ICONS = {
    symmetric:[448, 'M48 128c-17.7 0-32 14.3-32 32s14.3 32 32 32H400c17.7 0 32-14.3 32-32s-14.3-32-32-32H48zm0 192c-17.7 0-32 14.3-32 32s14.3 32 32 32H400c17.7 0 32-14.3 32-32s-14.3-32-32-32H48z'],
    antisymmetric:[512, 'M32 96l320 0V32c0-12.9 7.8-24.6 19.8-29.6s25.7-2.2 34.9 6.9l96 96c6 6 9.4 14.1 9.4 22.6s-3.4 16.6-9.4 22.6l-96 96c-9.2 9.2-22.9 11.9-34.9 6.9s-19.8-16.6-19.8-29.6V160L32 160c-17.7 0-32-14.3-32-32s14.3-32 32-32zM480 352c17.7 0 32 14.3 32 32s-14.3 32-32 32H160v64c0 12.9-7.8 24.6-19.8 29.6s-25.7 2.2-34.9-6.9l-96-96c-6-6-9.4-14.1-9.4-22.6s3.4-16.6 9.4-22.6l96-96c9.2-9.2 22.9-11.9 34.9-6.9s19.8 16.6 19.8 29.6l0 64H480z'],
    neither:[512, 'M403.8 34.4c12-5 25.7-2.2 34.9 6.9l64 64c6 6 9.4 14.1 9.4 22.6s-3.4 16.6-9.4 22.6l-64 64c-9.2 9.2-22.9 11.9-34.9 6.9s-19.8-16.6-19.8-29.6V160H352c-10.1 0-19.6 4.7-25.6 12.8L284 229.3 244 176l31.2-41.6C293.3 110.2 321.8 96 352 96h32V64c0-12.9 7.8-24.6 19.8-29.6zM164 282.7L204 336l-31.2 41.6C154.7 401.8 126.2 416 96 416H32c-17.7 0-32-14.3-32-32s14.3-32 32-32H96c10.1 0 19.6-4.7 25.6-12.8L164 282.7zm274.6 188c-9.2 9.2-22.9 11.9-34.9 6.9s-19.8-16.6-19.8-29.6V416H352c-30.2 0-58.7-14.2-76.8-38.4L121.6 172.8c-6-8.1-15.5-12.8-25.6-12.8H32c-17.7 0-32-14.3-32-32s14.3-32 32-32H96c30.2 0 58.7 14.2 76.8 38.4L326.4 339.2c6 8.1 15.5 12.8 25.6 12.8h32V320c0-12.9 7.8-24.6 19.8-29.6s25.7-2.2 34.9 6.9l64 64c6 6 9.4 14.1 9.4 22.6s-3.4 16.6-9.4 22.6l-64 64z'],
};

// A kind's icon, in the current colour, named for screen readers by its word.
function behaviourIcon(kind, name) {
    const space = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(space, 'svg');
    svg.setAttribute('viewBox', `0 0 ${ICONS[kind][0]} 512`);
    svg.setAttribute('class', 'molstarview-symmetry-icon');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', name);
    const title = svg.appendChild(document.createElementNS(space, 'title'));
    title.textContent = name;
    svg.appendChild(document.createElementNS(space, 'path')).setAttribute('d', ICONS[kind][1]);
    return svg;
}

// Whether a class's character, as a share of the character under E, makes it symmetric, antisymmetric or neither.
function behaviour(character, identity) {
    const ratio = character / identity;
    if (Math.abs(ratio - 1) < 1e-6) return 'symmetric';
    if (Math.abs(ratio + 1) < 1e-6) return 'antisymmetric';
    return 'neither';
}

// Every open symmetry dropdown closes on a click elsewhere on the page.
function closeSymmetryMenus(except) {
    for (const select of document.querySelectorAll('.molstarview-symmetry-select')) {
        if (select === except) continue;
        select.querySelector('[role=listbox]').classList.remove('show');
        select.querySelector('button[aria-expanded]').setAttribute('aria-expanded', 'false');
    }
}
if (!globalThis.molstarviewSymmetryMenus) {
    globalThis.molstarviewSymmetryMenus = true;
    document.addEventListener('click', event => {
        if (!event.target.closest?.('.molstarview-symmetry-select')) closeSymmetryMenus();
    });
}

// A writer of text with $...$ math into an element, the math typeset by the page's KaTeX once it has loaded, then
// `done` called; its `stop` cancels a wait for KaTeX.
function mathWriter(done = () => {}) {
    const pending = [];
    let waiting = null;
    function typeset() {
        if (!pending.length) return;
        if (!globalThis.katex) { waiting ??= setTimeout(() => { waiting = null; typeset(); }, 200); return; }
        for (const [math, source] of pending.splice(0)) katex.render(source, math, {throwOnError:false});
        done();
    }
    const write = (element, text) => {
        element.replaceChildren();
        for (const [index, part] of String(text).split('$').entries()) {
            if (index % 2 === 0) { if (part) element.append(part); continue; }
            const math = element.appendChild(document.createElement('span'));
            math.textContent = part;
            pending.push([math, part]);
        }
        typeset();
        return element;
    };
    write.stop = () => clearTimeout(waiting);
    return write;
}

function symmetryNode(tag, className, parent) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return parent ? parent.appendChild(element) : element;
}

// The classes, in character-table order, as subtables of their kind of operation, as the pages' own subtables are
// drawn: an outer row per kind spanning a row per class, with the icon of what the chosen representation's character
// makes of the class; each header explains its column from the info button the page gives its quantities. Returns the
// function that shows a representation's characters.
function symmetryTable(parent, classes, T, write) {
    const node = symmetryNode;
    const table = node('table', 'subtables table table-sm table-striped small molstarview-symmetry-characters', node('div', '', parent));
    const head = node('tr', 'header', node('thead', '', table));
    for (const column of ['operation', 'class', 'character']) {
        const heading = write(node('th', '', head), T(`symmetry-${column}`));
        if (globalThis.quartoInfoButton) heading.append(quartoInfoButton(T(`symmetry-${column}-description`)));
    }
    const body = node('tbody', '', table);
    const cells = new Array(classes.length);
    const kinds = ['rotation', 'improper', 'reflection'].filter(kind => classes.some(entry => entry.kind === kind));
    kinds.forEach((kind, group) => {
        const members = classes.map((entry, index) => [entry, index]).filter(([entry]) => entry.kind === kind);
        const parity = group % 2 ? 'even' : 'odd';
        members.forEach(([entry, index], position) => {
            const row = node('tr', `${position ? 'group-row' : 'group-start'} group-${parity} ${position % 2 ? 'even' : 'odd'}`, body);
            if (!position) {
                const name = write(node('td', '', row), T(`symmetry-kind-${kind}`));
                name.rowSpan = members.length;
            }
            const sub = position % 2 ? 'sub-even' : 'sub-odd';
            const label = write(node('td', sub, row), `$${entry.label}$`);
            // What the class's operations do, from the info button the page gives its quantities.
            if (entry.description && globalThis.quartoInfoButton) label.append(quartoInfoButton(entry.description));
            cells[index] = node('td', sub, row);
        });
    });
    return characters => characters.forEach((character, index) => {
        const kind = behaviour(character, characters[0]);
        cells[index].replaceChildren(behaviourIcon(kind, T(`symmetry-is-${kind}`)));
        cells[index].style.color = COLOURS[kind];
    });
}

// A figure and its table displayed apart (SymmetryFigure.parts) meet here, by the figure's uid, whichever the page
// builds first: the figure leaves what the table needs and the representation chosen, and tells the table's listeners
// of every new choice.
function symmetryLink(uid) {
    const links = globalThis.molstarviewSymmetryLinks ||= new Map();
    if (!links.has(uid)) links.set(uid, {state:null, listeners:new Set()});
    return links.get(uid);
}

// The words of a figure in the page's language, English where the page's has none.
function symmetryWords(texts) {
    const language = (document.documentElement.lang || 'en').slice(0, 2);
    return key => (texts[language] || {})[key] ?? (texts.en || {})[key] ?? key;
}

function initializeSymmetry({model, el}) {
    const T = symmetryWords(model.get('texts'));
    // Each class's label as a character table heads it and its kind, rotation, improper or reflection.
    const classes = model.get('classes'), options = model.get('options');
    let chosen = Math.min(Math.max(model.get('start'), 0), options.length - 1);

    // Text with math, the dropdown measured again once it is typeset.
    const write = mathWriter(() => fit());
    // The dropdown as wide as its widest entry, measured once the entries are typeset, so choosing never resizes it.
    let list = null, button = null;
    function fit() {
        if (!list || !button || !list.isConnected) return;
        const shown = list.classList.contains('show');
        list.style.visibility = 'hidden';
        list.style.minWidth = '0';
        list.style.width = 'max-content';
        list.classList.add('show');
        // The widest entry's text, without the menu's and its items' padding, plus the button's padding, chevron
        // and border.
        const sides = (element, kind) => {
            const style = getComputedStyle(element);
            return ['Left', 'Right'].reduce((sum, side) => sum + (parseFloat(style[`${kind}${side}`]) || 0), 0);
        };
        const item = list.querySelector('.dropdown-item');
        const text = list.offsetWidth - sides(list, 'padding') - sides(list, 'border') - (item ? sides(item, 'padding') : 0);
        if (!shown) list.classList.remove('show');
        list.style.visibility = list.style.minWidth = list.style.width = '';
        if (text > 0) {
            const width = `${Math.ceil(text + sides(button, 'padding') + sides(button, 'border') + 1)}px`;
            if (button.style.width !== width) button.style.width = width;
        }
    }
    const node = symmetryNode;

    const root = node('div', 'molstarview-symmetry', el);
    for (const [kind, colour] of Object.entries(model.get('colors'))) root.style.setProperty(`--molstarview-${kind}`, colour);
    // The dropdown, as the site's own: a form-select button over a Bootstrap menu whose entries hold math.
    const control = node('div', 'molstarview-symmetry-control', root);
    const id = `molstarview-symmetry-${globalThis.molstarviewSymmetryCount = (globalThis.molstarviewSymmetryCount || 0) + 1}`;
    const label = write(node('label', 'form-label molstarview-symmetry-label', control), model.get('choice'));
    label.htmlFor = `${id}-button`;
    // The quantity's explanation from the info button the page gives its table headers.
    if (model.get('choice_description') && globalThis.quartoInfoButton) {
        label.append(quartoInfoButton(model.get('choice_description')));
    }
    label.id = `${id}-label`;
    const select = node('div', 'molstarview-symmetry-select', control);
    button = node('button', 'form-select form-select-sm', select);
    button.type = 'button';
    button.id = `${id}-button`;
    button.setAttribute('aria-labelledby', `${id}-label ${id}-button`);
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    list = node('ul', 'dropdown-menu', select);
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', `${id}-label`);
    const items = options.map((option, index) => {
        const item = node('button', 'dropdown-item', node('li', '', list));
        item.type = 'button';
        item.setAttribute('role', 'option');
        write(item, option.label);
        item.addEventListener('click', () => {
            closeSymmetryMenus();
            button.focus();
            if (index !== chosen) { chosen = index; show(); }
        });
        return item;
    });
    button.addEventListener('click', () => {
        const open = !list.classList.contains('show');
        closeSymmetryMenus(select);
        list.classList.toggle('show', open);
        button.setAttribute('aria-expanded', String(open));
        if (open) items[chosen].focus();
    });
    select.addEventListener('keydown', event => {
        const position = items.indexOf(document.activeElement);
        if (event.key === 'Escape') { closeSymmetryMenus(); button.focus(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!list.classList.contains('show')) button.click();
            else items[(position + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
        }
    });

    // The drawing, with each class's label laid over it where the drawing placed it.
    const drawing = node('div', 'molstarview-symmetry-drawing', root);
    drawing.innerHTML = model.get('svg');
    // A label names the element's class and the other classes about the same axis, each in its own class's colour.
    for (const label of model.get('labels')) {
        const span = node('span', 'molstarview-symmetry-tag', drawing);
        label.parts.forEach((part, index) => {
            if (index) span.append(', ');
            write(node('span', `sym-${part.tag}`, span), `$${part.symbol}$`);
        });
        span.style.left = `${100 * label.x}%`;
        span.style.top = `${100 * label.y}%`;
    }

    // Hovering an element, or its label, shows its class and its character under the chosen representation in a box
    // like the pages' Altair tooltips (vega-tooltip): a key column in grey, values beside it, 10 pixels off the pointer.
    const svg = drawing.querySelector('svg');
    const hits = svg ? svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'g')) : null;
    for (const shape of svg ? [...svg.querySelectorAll('.sym')] : []) {
        // A wide transparent copy of each thin stroke, so the pointer finds it.
        const hit = hits.appendChild(shape.cloneNode(false));
        hit.removeAttribute('stroke-dasharray');
        hit.setAttribute('class', `molstarview-symmetry-hit ${[...shape.classList].find(name => /^sym-c\d+$/.test(name))}`);
    }
    const tooltip = node('div', 'molstarview-symmetry-tooltip', document.body);
    for (const [kind, colour] of Object.entries(model.get('colors'))) tooltip.style.setProperty(`--molstarview-${kind}`, colour);
    const tagOf = target => [...(target.closest?.('[class*="sym-c"]')?.classList || [])].find(name => /^sym-c\d+$/.test(name));
    const hover = event => {
        const tag = tagOf(event.target);
        if (!tag) { tooltip.classList.toggle('visible', false); return; }
        const index = Number(tag.slice(5)), characters = options[chosen].characters;
        const kind = behaviour(characters[index], characters[0]);
        const table = document.createElement('table');
        const classRow = table.appendChild(document.createElement('tr'));
        write(node('td', 'key', classRow), T('symmetry-class'));
        write(node('td', 'value', classRow), `$${classes[index].label}$`);
        const characterRow = table.appendChild(document.createElement('tr'));
        write(node('td', 'key', characterRow), T('symmetry-character'));
        const icon = node('td', 'value', characterRow);
        icon.append(behaviourIcon(kind, T(`symmetry-is-${kind}`)));
        icon.style.color = COLOURS[kind];
        tooltip.replaceChildren(table);
        tooltip.classList.toggle('visible', true);
        tooltip.style.left = `${event.clientX + 10}px`;
        tooltip.style.top = `${event.clientY + 10}px`;
    };
    drawing.addEventListener('pointermove', hover);
    drawing.addEventListener('pointerleave', () => tooltip.classList.toggle('visible', false));

    // The table of characters: below the drawing, or, displayed apart, in its own output, which the link feeds.
    const showTable = model.get('apart') ? null : symmetryTable(root, classes, T, write);
    const link = model.get('apart') ? symmetryLink(model.get('uid')) : null;

    // The colours' legend, as the pages' Altair legends draw one, each entry the table's icon of its kind in its colour
    // and the relation of characters it stands for, so the legend reads both the drawing and the table.
    const legend = node('div', 'molstarview-symmetry-legend', root);
    const entries = node('div', 'molstarview-depiction-legend', legend);
    for (const kind of ['symmetric', 'antisymmetric', 'neither']) {
        const entry = node('span', 'molstarview-depiction-item', entries);
        const icon = entry.appendChild(behaviourIcon(kind, T(`symmetry-is-${kind}`)));
        icon.style.color = COLOURS[kind];
        write(node('span', '', entry), T(`symmetry-${kind}`));
    }

    function show() {
        const characters = options[chosen].characters;
        write(button, options[chosen].label);
        items.forEach((item, index) => {
            item.classList.toggle('molstarview-symmetry-current', index === chosen);
            item.setAttribute('aria-selected', String(index === chosen));
        });
        characters.forEach((character, index) => {
            const colour = COLOURS[behaviour(character, characters[0])];
            for (const element of root.querySelectorAll(`.sym-c${index}`)) element.style.color = colour;
        });
        showTable?.(characters);
        if (link) {
            link.state = {classes, texts:model.get('texts'), colors:model.get('colors'), characters};
            for (const listener of link.listeners) listener(link.state);
        }
    }
    show();
    // The entries' widths change once the page's fonts have loaded, and a figure in a hidden tab has none until the tab
    // opens, so the dropdown is measured again then.
    document.fonts?.ready.then(fit);
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    sized?.observe(root);
    return () => { write.stop(); sized?.disconnect(); tooltip.replaceWith(); el.replaceChildren(); };
}

// A figure's table displayed as its own output: built once the figure has left its classes, then showing each
// representation the figure's dropdown chooses.
function initializeSymmetryTable({model, el}) {
    const link = symmetryLink(model.get('target'));
    const write = mathWriter();
    let show = null;
    const listener = state => {
        if (!show) {
            const root = symmetryNode('div', 'molstarview-symmetry molstarview-symmetry-apart', el);
            // The figure's colours, which this output, outside the figure, does not inherit.
            for (const [kind, colour] of Object.entries(state.colors)) root.style.setProperty(`--molstarview-${kind}`, colour);
            show = symmetryTable(root, state.classes, symmetryWords(state.texts), write);
        }
        show(state.characters);
    };
    link.listeners.add(listener);
    if (link.state) listener(link.state);
    return () => { write.stop(); link.listeners.delete(listener); el.replaceChildren(); };
}

export default {render: ({model, el}) => (model.get('target') ? initializeSymmetryTable : initializeSymmetry)({model, el})};
