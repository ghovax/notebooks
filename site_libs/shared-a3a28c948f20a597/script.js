
(() => {
    async function size() {
        const style = getComputedStyle(document.body);
        await Promise.all([document.fonts.load("italic 1000px KaTeX_Math"),
                           document.fonts.load("1000px KaTeX_Main"), document.fonts.ready]);
        const context = document.createElement("canvas").getContext("2d");
        if (!context) return;
        const height = (font, character) => {
            context.font = font;
            const bounds = context.measureText(character);
            return bounds.actualBoundingBoxAscent + bounds.actualBoundingBoxDescent;
        };
        let cross = 0, square = 0;
        for (const [characters, font] of [["acemnorsuvwxzABCEHKMNORSUXZ", "italic 1000px KaTeX_Math"],
                                          ["0123456789", "1000px KaTeX_Main"]]) {
            for (const character of characters) {
                const text = height(`1000px ${style.fontFamily}`, character);
                const math = height(font, character);
                if (!Number.isFinite(text) || !Number.isFinite(math) || text <= 0 || math <= 0) continue;
                cross += text * math;
                square += math * math;
            }
        }
        const ratio = cross / square;
        if (Number.isFinite(ratio) && ratio > 0.5 && ratio < 2)
            document.documentElement.style.setProperty("--math-scale", ratio.toFixed(4));
    }
    if (document.body) size(); else document.addEventListener("DOMContentLoaded", size);
})();
