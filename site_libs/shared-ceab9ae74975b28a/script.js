
(() => {
    const widths = new Map([["\u2009", "0.16666667em"], ["\u2005", "0.22222222em"], ["\u2005\u200a", "0.27777778em"]]);
    const patched = new WeakSet();
    const namespace = "http://www.w3.org/1998/Math/MathML";
    // Chrome draws only mathvariant="normal"; KaTeX writes \mathbf, \boldsymbol and their kin as other mathvariants,
    // which Chrome ignores, so a bold r is drawn as an italic one. Each letter, digit or Greek letter is replaced by
    // its Unicode mathematical alphanumeric, which the math font draws in that style: per variant, the code points of
    // A, a, 0, Alpha and alpha in that style, or null where Unicode has no such letters.
    const alphabets = {
        "bold": [0x1D400, 0x1D41A, 0x1D7CE, 0x1D6A8, 0x1D6C2],
        "bold-italic": [0x1D468, 0x1D482, 0x1D7CE, 0x1D71C, 0x1D736],
        "italic": [0x1D434, 0x1D44E, null, 0x1D6E2, 0x1D6FC],
        "double-struck": [0x1D538, 0x1D552, 0x1D7D8, null, null],
        "script": [0x1D49C, 0x1D4B6, null, null, null],
        "fraktur": [0x1D504, 0x1D51E, null, null, null],
        "sans-serif": [0x1D5A0, 0x1D5BA, 0x1D7E2, null, null],
        "bold-sans-serif": [0x1D5D4, 0x1D5EE, 0x1D7EC, 0x1D756, 0x1D770],
        "monospace": [0x1D670, 0x1D68A, 0x1D7F6, null, null],
    };
    // Letters Unicode places outside the alphabets, in the Letterlike Symbols block.
    const holes = {"italic": {h: 0x210E}, "double-struck": {C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124},
        "script": {B: 0x212C, E: 0x2130, F: 0x2131, H: 0x210B, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211B, e: 0x212F, g: 0x210A, o: 0x2134},
        "fraktur": {C: 0x212D, H: 0x210C, I: 0x2111, R: 0x211C, Z: 0x2128}};
    function styled(text, variant) {
        const [upper, lower, digit, greekUpper, greekLower] = alphabets[variant];
        return [...text].map(character => {
            const code = character.codePointAt(0), hole = holes[variant]?.[character];
            if (hole) return String.fromCodePoint(hole);
            if (code >= 65 && code <= 90 && upper) return String.fromCodePoint(upper + code - 65);
            if (code >= 97 && code <= 122 && lower) return String.fromCodePoint(lower + code - 97);
            if (code >= 48 && code <= 57 && digit) return String.fromCodePoint(digit + code - 48);
            if (code >= 0x391 && code <= 0x3A9 && code !== 0x3A2 && greekUpper) return String.fromCodePoint(greekUpper + code - 0x391);
            if (code >= 0x3B1 && code <= 0x3C9 && greekLower) return String.fromCodePoint(greekLower + code - 0x3B1);
            return character;
        }).join("");
    }
    function variants(root) {
        const elements = root.namespaceURI === namespace && root.hasAttribute?.("mathvariant") ? [root] : [];
        elements.push(...(root.querySelectorAll?.("[mathvariant]") || []));
        for (const element of elements) {
            const variant = element.getAttribute("mathvariant");
            if (!(variant in alphabets) || element.namespaceURI !== namespace) continue;
            const walker = document.createTreeWalker(element, 4);
            while (walker.nextNode()) walker.currentNode.nodeValue = styled(walker.currentNode.nodeValue, variant);
            element.removeAttribute("mathvariant");
        }
    }
    function explicitSpaces(html) {
        return html.replace(/<mtext>([\u2005\u2009\u200a]+)<\/mtext>/g,
            (original, text) => widths.has(text) ? '<mspace width="' + widths.get(text) + '"></mspace>' : original)
            .replace(/<(m[ino]|mtext) mathvariant="([a-z-]+)">([^<]*)<\/\1>/g,
                (original, tag, variant, text) => variant in alphabets ? `<${tag}>${styled(text, variant)}</${tag}>` : original);
    }
    // Chrome lays out tables as MathML Core does, centring every cell and padding it alike, so it ignores the
    // columnalign and columnspacing that KaTeX's aligned, cases and matrices rely on. Each cell takes its column's
    // alignment, the last one repeating, and half the spacing of the gaps beside it.
    function tables(root) {
        const found = root.namespaceURI === namespace && root.localName === "mtable" ? [root]
            : [...(root.querySelectorAll?.("mtable") || [])];
        for (const table of found) {
            const aligns = (table.getAttribute("columnalign") || "").split(/\s+/).filter(Boolean);
            const spacing = (table.getAttribute("columnspacing") || "").split(/\s+/).filter(Boolean);
            const pick = (list, index) => list[Math.min(index, list.length - 1)];
            for (const row of table.children) {
                const cells = [...row.children];
                cells.forEach((cell, index) => {
                    if (aligns.length) cell.style.textAlign = pick(aligns, index);
                    if (!spacing.length) return;
                    cell.style.paddingInlineStart = index ? `calc(${pick(spacing, index - 1)} / 2)` : "0";
                    cell.style.paddingInlineEnd = index < cells.length - 1 ? `calc(${pick(spacing, index)} / 2)` : "0";
                });
            }
        }
    }
    function normalize(root) {
        if (root.querySelectorAll) variants(root);
        if (root.nodeType !== 3) tables(root);
        // The DOM renderer emits bare text nodes; serialized MathML uses mtext.
        const nodes = [];
        if (root.nodeType === 3) nodes.push(root);
        const roots = root.namespaceURI === namespace ? [root] : root.querySelectorAll?.("math") || [];
        for (const math of roots) {
            const walker = document.createTreeWalker(math, 4);
            while (walker.nextNode()) nodes.push(walker.currentNode);
        }
        for (const node of nodes) {
            const parent = node.parentNode, width = widths.get(node.nodeValue);
            if (!width || parent?.namespaceURI !== namespace) continue;
            const space = document.createElementNS(namespace, "mspace");
            space.setAttribute("width", width);
            if (parent.localName === "mtext" && parent.childNodes.length === 1) parent.replaceWith(space);
            else node.replaceWith(space);
        }
    }
    function install() {
        const katex = globalThis.katex;
        if (katex && !patched.has(katex)) {
            const render = katex.render, renderToString = katex.renderToString;
            katex.render = function (tex, element, options) {
                const result = render.call(this, tex, element, options);
                normalize(element);
                return result;
            };
            katex.renderToString = function (...args) {
                return explicitSpaces(renderToString.apply(this, args));
            };
            patched.add(katex);
        }
        normalize(document);
    }
    new MutationObserver(changes => {
        for (const change of changes) {
            const parent = change.target.nodeType === 1 ? change.target : change.target.parentElement;
            if (parent?.closest(".molstar-notebook-viewer, .vega-embed")) continue;
            for (const node of change.addedNodes)
                if (node.nodeType === 1 || node.nodeType === 3) normalize(node);
        }
    }).observe(document.documentElement, {childList: true, subtree: true});
    document.addEventListener("DOMContentLoaded", install);
    window.addEventListener("load", install);
    install();
})();
