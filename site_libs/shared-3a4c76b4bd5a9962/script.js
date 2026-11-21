
// Vega measures a container-wide chart only when the window resizes, so a column that changes width without one, a tab
// or fold shown, a sidebar opened, the page settling while it loads, would keep its chart at the old width, or at none
// when it was drawn hidden. Each chart is watched, and a change of its width resizes the page's charts, once a frame.
(() => {
    if (!globalThis.ResizeObserver) return;
    const widths = new WeakMap();
    let pending = false;
    const resize = () => { pending = false; window.dispatchEvent(new Event('resize')); };
    const sizes = new ResizeObserver(entries => {
        let changed = false;
        for (const entry of entries) {
            const width = Math.round(entry.contentRect.width), before = widths.get(entry.target);
            widths.set(entry.target, width);
            // A chart first seen is drawn at its width already; a hidden one, of no width, is left until shown.
            if (before !== undefined && width !== before && width > 0) changed = true;
        }
        if (changed && !pending) { pending = true; requestAnimationFrame(resize); }
    });
    const watch = node => {
        if (node.nodeType !== Node.ELEMENT_NODE || node.closest('.vega-embed') && !node.matches('.vega-embed')) return;
        for (const chart of node.matches('.vega-embed') ? [node] : node.querySelectorAll('.vega-embed')) {
            if (!widths.has(chart)) sizes.observe(chart);
        }
    };
    new MutationObserver(mutations => {
        for (const mutation of mutations) for (const node of mutation.addedNodes) watch(node);
    }).observe(document.documentElement, {childList: true, subtree: true});
    watch(document.documentElement);
})();
