
// A chart's input bindings, such as the Part, Element and Atom controls of the orbital composition matrices, drawn as
// the page's own controls, as the scan matrices draw theirs: a bold label above a menu whose entries can hold math,
// placed above the chart. A choice is handed to the chart's own binding, hidden, so the chart updates as Vega would.
// - A binding whose options are all numbers, such as atom numbers, is a field: a typed number goes to the nearest
//   option allowed, other text back to the current one.
// - When those numbers are labelled by element, an Element dropdown before the field chooses among them: it allows
//   only that element's atoms, moves to the first of them when chosen, and follows the atom chosen. It stays on the
//   page, so each choice changes one binding; the chart echoes its bindings back, and two changes in a row would
//   leave the first one's stale value behind.
// - When the first binding has an `atom` option, the bindings after it show only while that option is chosen.
(() => {
    const write = (element, text) => {
        for (const [index, part] of String(text).split('$').entries()) {
            if (index % 2 === 0) element.append(part);
            else {
                const math = document.createElement('span');
                if (globalThis.katex) katex.render(part, math, {throwOnError: false});
                else math.textContent = part;
                element.append(math);
            }
        }
        return element;
    };
    const element = (tag, attributes = {}, text) => {
        const node = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        return text === undefined ? node : write(node, text);
    };
    const close = except => {
        for (const select of document.querySelectorAll('.chart-controls .scan-select')) {
            if (select === except) continue;
            select.querySelector('[role=listbox]').classList.remove('show');
            select.querySelector('button[aria-expanded]').setAttribute('aria-expanded', 'false');
        }
    };
    document.addEventListener('click', event => { if (!event.target.closest?.('.chart-controls .scan-select')) close(); });
    // Select an option of a binding's select and tell Vega, as a change would.
    const choose = (select, index) => {
        if (index < 0 || select.selectedIndex === index) return;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', {bubbles: true}));
    };
    // One field for a binding of numbered options, those allowed by ``allowed``.
    function field(select, label, allowed) {
        const wrapper = element('div', {class: 'scan-control chart-control-narrow'});
        wrapper.append(element('div', {class: 'scan-label'}, label));
        const input = wrapper.appendChild(element('input', {type: 'text', class: 'form-control form-control-sm',
                                                            inputmode: 'numeric', spellcheck: 'false', 'aria-label': label}));
        const show = () => {
            const options = [...select.options].filter(allowed).map(option => option.value);
            if (document.activeElement !== input) input.value = select.options[select.selectedIndex]?.value ?? '';
            input.placeholder = options.length ? `${options[0]}–${options[options.length - 1]}` : '';
            input.title = `${label}: ${options.join(', ')}`;
        };
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') input.blur();
            if (event.key === 'Escape') { input.value = select.options[select.selectedIndex]?.value ?? ''; input.blur(); }
        });
        input.addEventListener('change', () => {
            const options = [...select.options].map((option, index) => [Number(option.value), index])
                .filter(([, index]) => allowed(select.options[index]));
            const number = Number(input.value.trim().replace('\u2212', '-'));
            if (input.value.trim() !== '' && Number.isFinite(number) && options.length) {
                choose(select, options.reduce((best, entry) =>
                    Math.abs(entry[0] - number) < Math.abs(best[0] - number) ? entry : best)[1]);
            }
            input.value = '';
            show();
        });
        return {wrapper, show};
    }
    // One control for a binding's select: choosing an entry selects it there and tells Vega, as a change would.
    function control(select, label, refresh) {
        const wrapper = element('div', {class: 'scan-control'});
        wrapper.append(element('div', {class: 'scan-label'}, label));
        const menu = wrapper.appendChild(element('div', {class: 'scan-select'}));
        const options = [...select.options];
        const button = menu.appendChild(element('button', {type: 'button', class: 'form-select form-select-sm',
                                                           'aria-haspopup': 'listbox', 'aria-expanded': 'false'}));
        const list = menu.appendChild(element('ul', {class: 'dropdown-menu', role: 'listbox'}));
        const items = options.map((option, index) => {
            const item = element('button', {type: 'button', role: 'option', class: 'dropdown-item'}, option.textContent);
            item.addEventListener('click', () => {
                close();
                button.focus();
                choose(select, index);
                refresh();
            });
            list.appendChild(element('li')).append(item);
            return item;
        });
        const show = () => {
            button.replaceChildren();
            write(button, options[select.selectedIndex]?.textContent ?? '');
            items.forEach((item, index) => {
                item.classList.toggle('scan-current', index === select.selectedIndex);
                item.setAttribute('aria-selected', String(index === select.selectedIndex));
            });
        };
        button.addEventListener('click', () => {
            const open = !list.classList.contains('show');
            close(menu);
            list.classList.toggle('show', open);
            button.setAttribute('aria-expanded', String(open));
            if (open) items[Math.max(select.selectedIndex, 0)].focus();
        });
        menu.addEventListener('keydown', event => {
            const position = items.indexOf(document.activeElement);
            if (event.key === 'Escape') { close(); button.focus(); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!list.classList.contains('show')) button.click();
                else items[(position + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
            }
        });
        return {wrapper, show};
    }
    function restyle(bindings) {
        bindings.dataset.restyled = '';
        const embed = bindings.closest('.vega-embed');
        const band = element('div', {class: 'scan-control-band chart-controls'});
        const binds = [...bindings.querySelectorAll('.vega-bind')].filter(bind => bind.querySelector('select'))
            .map(bind => ({select: bind.querySelector('select'), label: bind.querySelector('.vega-bind-name')?.textContent.trim() ?? ''}));
        const gate = binds[0] && [...binds[0].select.options].some(option => option.value === 'atom') ? binds[0].select : null;
        const controls = [];
        const refresh = () => controls.forEach(({wrapper, show}, index) => {
            wrapper.hidden = Boolean(gate) && index > 0 && gate.value !== 'atom';
            show();
        });
        for (const {select, label} of binds) {
            const options = [...select.options];
            if (!options.every(option => option.value !== '' && Number.isFinite(Number(option.value)))) {
                controls.push(control(select, label, refresh));
                continue;
            }
            let allowed = () => true;
            if (options.some(option => option.textContent !== option.value)) {
                // The Element dropdown, a select of the page's own that only moves the atom.
                const elements = document.createElement('select');
                for (const name of new Set(options.map(option => option.textContent))) {
                    elements.append(Object.assign(document.createElement('option'), {value: name, textContent: `$\\mathrm{${name}}$`}));
                }
                elements.addEventListener('change', () => choose(select, options.findIndex(option => option.textContent === elements.value)));
                allowed = option => option.textContent === elements.value;
                const dropdown = control(elements, 'Element', refresh);
                dropdown.wrapper.classList.add('chart-control-narrow');
                controls.push({wrapper: dropdown.wrapper, show: () => {
                    elements.value = select.options[select.selectedIndex]?.textContent ?? '';
                    dropdown.show();
                }});
            }
            controls.push(field(select, label, allowed));
        }
        for (const {wrapper} of controls) band.append(wrapper);
        refresh();
        for (const {select} of binds) select.addEventListener('change', () => queueMicrotask(refresh));
        if (!embed || !band.children.length) return;
        // A chart drawn again brings its bindings again; its controls are replaced, not repeated.
        embed.parentElement.querySelector(':scope > .chart-controls')?.remove();
        embed.before(band);
        embed.classList.add('bindings-restyled');
    }
    new MutationObserver(() => {
        for (const bindings of document.querySelectorAll('.vega-embed .vega-bindings:not([data-restyled])')) restyle(bindings);
    }).observe(document.documentElement, {childList: true, subtree: true});
})();
