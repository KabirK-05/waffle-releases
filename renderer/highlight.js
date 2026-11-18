// A small, language-agnostic syntax highlighter for answer code blocks. It builds DOM nodes from
// text (never HTML), so model output cannot inject markup. It is deliberately approximate: a few
// token classes that read well across CSS, JS/TS, Python, shell, JSON and similar languages.
(function () {
  const HASH_COMMENT_LANGS = new Set([
    'py', 'python', 'sh', 'bash', 'zsh', 'shell', 'console', 'rb', 'ruby', 'yaml', 'yml', 'toml', 'r', 'perl', 'ini', 'conf', 'dockerfile', 'makefile',
  ]);

  const KEYWORDS = new Set(
    (
      'abstract as async await break case catch class const continue def default del delete do elif else enum ' +
      'except export extends false final finally fn for from func function go if impl import in instanceof interface ' +
      'is lambda let match mod mut new nil none not null of or package pass private protected pub public raise ' +
      'return self static struct super switch this throw throws true try type typeof undefined use var void while ' +
      'with yield and select where insert update delete set into values join on order by group limit important'
    ).split(' '),
  );

  function patternFor(lang) {
    const hashComments = HASH_COMMENT_LANGS.has(lang);
    const parts = [
      // 1: block and line comments
      String.raw`\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/[^\n]*` + (hashComments ? String.raw`|#[^\n]*` : ''),
      // 2: strings
      String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60`,
      // 3: numbers, with CSS units, and hex colours
      String.raw`#[0-9a-fA-F]{3,8}\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?:px|em|rem|vh|vw|ms|s|deg|fr)?\b|\.\d+\b|%`,
      // 4: identifiers (hyphens allowed between letters, for CSS)
      String.raw`[A-Za-z_$@](?:[\w$]|-(?=[A-Za-z]))*`,
    ];
    return new RegExp(parts.map((p) => `(${p})`).join('|'), 'g');
  }

  /** Classify an identifier by what follows it. */
  function wordClass(word, source, end) {
    const rest = source.slice(end, end + 40);
    const next = rest.replace(/^[ \t]*/, '');
    if (KEYWORDS.has(word) || KEYWORDS.has(word.toLowerCase())) return 'tk-keyword';
    if (next.startsWith(':') && !next.startsWith('::')) return 'tk-prop';
    if (next.startsWith('(')) return 'tk-fn';
    if (/^[A-Z][a-z]/.test(word)) return 'tk-type';
    return '';
  }

  function tokenize(source, lang) {
    const re = patternFor(lang);
    const tokens = [];
    let last = 0;
    let m;
    while ((m = re.exec(source))) {
      if (m.index > last) tokens.push({ text: source.slice(last, m.index), cls: '' });
      let cls = '';
      if (m[1]) cls = 'tk-comment';
      else if (m[2]) {
        // A quoted key (JSON) reads as a property, like a bare one.
        const after = source.slice(re.lastIndex).replace(/^[ \t]*/, '');
        cls = after.startsWith(':') ? 'tk-prop' : 'tk-string';
      } else if (m[3]) cls = 'tk-number';
      else if (m[4]) cls = wordClass(m[4], source, re.lastIndex);
      tokens.push({ text: m[0], cls });
      last = re.lastIndex;
    }
    if (last < source.length) tokens.push({ text: source.slice(last), cls: '' });
    return tokens;
  }

  /** Return one <span class="ln"> per source line, filled with highlighted tokens. */
  function highlightLines(source, lang = '') {
    const lines = [];
    let line = document.createElement('span');
    line.className = 'ln';
    const push = (text, cls) => {
      if (!text) return;
      if (!cls) return line.append(document.createTextNode(text));
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      line.append(span);
    };
    for (const { text, cls } of tokenize(source, lang)) {
      const parts = text.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) {
          lines.push(line);
          line = document.createElement('span');
          line.className = 'ln';
        }
        push(part, cls);
      });
    }
    lines.push(line);
    return lines;
  }

  window.highlightLines = highlightLines;
})();
