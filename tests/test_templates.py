"""
Structural checks for the rendered HTML.

The page is built from Jinja macros and Alpine <template> blocks. A missing or
extra closing tag fails nothing loudly: the browser repairs the tree silently
and a block ends up in the wrong place.
"""

from html.parser import HTMLParser

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "source", "track", "wbr",
}  # fmt: skip


class _Balance(HTMLParser):
    def __init__(self, lines):
        super().__init__()
        self.lines = lines
        self.stack = []  # (tag, line it was opened on)
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        line = self.getpos()[0]
        if not self.stack or self.stack[-1][0] != tag:
            innermost = self.stack[-1] if self.stack else None
            self.errors.append(
                f"unexpected </{tag}> at line {line}: "
                f"{self.lines[line - 1].strip()!r}; innermost open tag: {innermost}"
            )
            return
        self.stack.pop()


def test_index_html_tags_are_balanced(client):
    html = client.get("/").get_data(as_text=True)
    parser = _Balance(html.splitlines())
    parser.feed(html)
    parser.close()

    assert parser.errors == []
    assert parser.stack == []
