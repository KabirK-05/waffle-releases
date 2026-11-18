// Minimal, safe Markdown renderer. All text is HTML-escaped before any markup is added. Maths
// becomes placeholders that renderMath() draws with KaTeX (vendor/katex) once they are in the page.
(function () {
  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /**
   * A placeholder for one formula; renderMath() fills it in. KaTeX's HTML positions glyphs with
   * inline style attributes, which the page's CSP blocks, so formulas are built as DOM nodes
   * (KaTeX sets their styles through the DOM, which the CSP allows) after the HTML is inserted.
   */
  function math(tex, displayMode) {
    return `<span class="math${displayMode ? ' math-display' : ''}" data-tex="${escapeHtml(tex)}">${escapeHtml(tex)}</span>`;
  }

  /** Draw every formula placeholder inside `container` with KaTeX. Bad input renders in red. */
  function renderMath(container) {
    if (!window.katex) return;
    for (const el of container.querySelectorAll('.math[data-tex]')) {
      const tex = el.getAttribute('data-tex');
      el.removeAttribute('data-tex');
      try {
        window.katex.render(tex, el, { displayMode: el.classList.contains('math-display'), throwOnError: false, trust: false, output: 'html' });
      } catch {
        el.textContent = tex;
      }
    }
  }

  // Maths: $$…$$ and \[…\] are display; \(…\) and $…$ are inline. A lone $ opens maths only when
  // not followed by a space, and closes only when not preceded by a space or followed by a digit,
  // so prices like "$5 or $10" stay plain text. Unclosed maths (mid-stream) stays as typed.
  const MATH = /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;

  function inline(text) {
    const stash = []; // finished HTML for code spans and maths, swapped back in at the end
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let out = text
      .replace(/\u0000/g, '')
      .replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${escapeHtml(code)}</code>`))
      .replace(MATH, (_m, block, bracket, paren, before, dollar) => {
        if (block != null) return keep(math(block.trim(), true));
        if (bracket != null) return keep(math(bracket.trim(), true));
        if (paren != null) return keep(math(paren.trim(), false));
        return before + keep(math(dollar, false));
      });
    out = escapeHtml(out)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
      );
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
  }

  function render(markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let paragraph = [];
    let list = null; // 'ul' | 'ol'

    const flushParagraph = () => {
      if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (list) html.push(`</${list}>`);
      list = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      const fence = line.match(/^\s*```(.*)$/);
      if (fence) {
        flushParagraph();
        closeList();
        const code = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        const lang = fence[1].trim().toLowerCase().replace(/[^a-z0-9+#-]/g, '').slice(0, 20);
        html.push(`<pre><code data-lang="${lang}">${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushParagraph();
        closeList();
        html.push('<hr>');
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
        continue;
      }

      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushParagraph();
        const kind = bullet ? 'ul' : 'ol';
        if (list !== kind) {
          closeList();
          html.push(`<${kind}>`);
          list = kind;
        }
        html.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }

      closeList();
      paragraph.push(line.trim());
    }

    flushParagraph();
    closeList();
    return html.join('');
  }

  window.renderMarkdown = render;
  window.renderMath = renderMath;
})();
